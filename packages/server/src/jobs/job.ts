/**
 * A running job as the generation code sees it: progress, a checklist of stages, a log, and whether it should
 * stop. Backed by its row in the job queue (written through, throttled) so any process can show its progress;
 * without a row (CLI runs) it only lives in memory.
 */
import type { WorldInput } from '@gd/shared';
import { appendLog, cancelRequested, saveJobState, type JobPhase, type JobPreview, type JobRecord, type LogEntry } from './queue';
import { report, touch as touchPresence } from '../gpu/presence';

export type { JobPhase, LogEntry as GenLogEntry };

/** Thrown at a safe point when the worker is asked to restart (new code): the job is re-queued and resumes. */
export class JobYield extends Error {
  constructor() {
    super('worker restarting');
  }
}

/** Set by the worker when it should stop at the next safe point. */
export const workerState = { yieldRequested: false };

export class Job {
  private progress_ = 0;
  private step_ = 'Queued';
  phases: JobPhase[] = [];
  log: LogEntry[] = [];
  status: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' = 'running';
  error?: string;
  preview: JobPreview = {};
  readonly id?: string;
  private pendingLog: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelCheckedAt = 0;
  private cancelFlag = false;
  private readonly startedAt = Date.now();
  /** What this job is for, as the admin GPU page shows it (a CLI run's job has no id or kind). */
  readonly tag: { jobId?: string; worldId: string; kind: string };
  private unreport: (() => void) | null;

  constructor(public readonly worldId: string, public readonly input: WorldInput, public readonly owner: { id: string; name: string }, record?: JobRecord) {
    if (record) {
      this.id = record.id;
      this.phases = record.phases;
      this.preview = record.preview;
      this.progress = record.progress;
      this.step = record.step;
      this.cancelFlag = record.cancelRequested;
    }
    this.tag = { jobId: record?.id, worldId, kind: record?.kind ?? 'cli' };
    this.unreport = report(() => (this.status === 'running' || this.status === 'waiting' ? { tasks: [{ tag: this.tag, step: this.step, progress: this.progress, since: this.startedAt }] } : {}));
  }

  /** No longer running in this process: stop reporting it. */
  close() {
    this.unreport?.();
    this.unreport = null;
  }

  get progress() {
    return this.progress_;
  }
  set progress(v: number) {
    this.progress_ = v;
    this.touch();
  }
  get step() {
    return this.step_;
  }
  set step(v: string) {
    this.step_ = v;
    this.touch();
  }

  /** The owner asked to stop (checked against the queue at most once a second). */
  get cancelled(): boolean {
    if (this.id && Date.now() - this.cancelCheckedAt > 1000) {
      this.cancelCheckedAt = Date.now();
      this.cancelFlag = cancelRequested(this.id);
    }
    return this.cancelFlag;
  }
  set cancelled(v: boolean) {
    this.cancelFlag = v;
  }

  /** A safe point between pieces of work: stop here if the worker is restarting. */
  yieldPoint() {
    if (workerState.yieldRequested && this.id) throw new JobYield();
  }

  /** Declare the stages this job will go through (stages already finished keep their state on a resume). */
  plan(phases: Omit<JobPhase, 'status'>[]) {
    const prev = new Map(this.phases.map((p) => [p.id, p]));
    this.phases = phases.map((p) => {
      const old = prev.get(p.id);
      return old && old.status === 'done' ? { ...p, ...old } : { ...p, status: 'pending' as const };
    });
    this.touch();
  }

  /** Enter a stage: earlier active stages are finished, earlier untouched ones skipped. */
  phase(id: string, counts?: { done?: number; total?: number }) {
    const now = Date.now();
    for (const p of this.phases) {
      if (p.id === id) {
        if (p.status !== 'active') p.startedAt = now;
        p.status = 'active';
        if (counts) Object.assign(p, counts);
        break;
      }
      if (p.status === 'active') {
        p.status = 'done';
        p.endedAt = now;
      } else if (p.status === 'pending') p.status = 'skipped';
    }
    this.touch();
    this.yieldPoint();
  }

  /** Start one stage, leaving the others as they are (stages of a build run side by side). */
  begin(id: string, counts?: { done?: number; total?: number }) {
    const p = this.phases.find((x) => x.id === id);
    if (!p || p.status === 'done') return;
    if (p.status !== 'active') p.startedAt = Date.now();
    p.status = 'active';
    if (counts) Object.assign(p, counts);
    this.touch();
  }

  /** Finish one stage. */
  end(id: string) {
    const p = this.phases.find((x) => x.id === id);
    if (!p || p.status === 'done') return;
    p.status = 'done';
    p.startedAt ??= Date.now();
    p.endedAt = Date.now();
    this.touch();
  }

  /** Update a stage's item counts. */
  count(id: string, done: number, total?: number) {
    const p = this.phases.find((x) => x.id === id);
    if (!p) return;
    p.done = done;
    if (total !== undefined) p.total = total;
    this.touch();
  }

  finishPhases() {
    const now = Date.now();
    for (const p of this.phases) {
      if (p.status === 'active') {
        p.status = 'done';
        p.endedAt = now;
      } else if (p.status === 'pending') p.status = 'skipped';
    }
    this.touch();
  }

  push(msg: string, kind: LogEntry['kind'] = 'info') {
    const e = { t: Date.now(), msg, kind };
    this.log.push(e);
    if (this.log.length > 400) this.log.shift();
    this.pendingLog.push(e);
    if (kind !== 'preview') console.log(`[job ${this.worldId}] ${msg}`);
    // A stage announcing itself is what the job is doing now (unless it waits on a model, which says so instead).
    if (kind === 'step') {
      if (this.stepBeforeWait) this.stepBeforeWait = msg;
      else this.step = msg;
    }
    this.touch();
  }

  /** Waiting on a model (busy, rate-limited or unreachable): shown to the player instead of failing. */
  waiting(why: string | null) {
    const next = why ? 'waiting' : 'running';
    if (this.status !== 'running' && this.status !== 'waiting') return;
    if (next === this.status && (!why || this.step === why)) return;
    this.status = next;
    if (why) {
      this.stepBeforeWait ??= this.step;
      this.step = why;
      this.push(why, 'warn');
    } else if (this.stepBeforeWait) {
      this.step = this.stepBeforeWait;
      this.stepBeforeWait = undefined;
    }
    this.touch();
  }
  private stepBeforeWait?: string;

  /** Record the outcome. */
  finish(status: 'done' | 'failed' | 'cancelled', error?: string) {
    this.status = status;
    this.error = error;
    if (status === 'done') {
      this.progress = 1;
      this.step = 'Ready';
    }
    this.flush(true);
    this.close();
  }

  private touch() {
    touchPresence();
    if (!this.id || this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 400);
  }

  /** Write progress and new log lines to the queue. */
  flush(final = false) {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.id) return;
    const log = this.pendingLog;
    this.pendingLog = [];
    appendLog(this.id, log);
    saveJobState({ id: this.id, status: this.status, progress: this.progress, step: this.step, error: this.error, phases: this.phases, preview: this.preview, finishedAt: final && this.status !== 'running' && this.status !== 'waiting' ? Date.now() : undefined });
  }
}
