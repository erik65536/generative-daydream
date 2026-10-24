/**
 * Durable job queue. A job (build a world, redesign its rules, paint it, a studio task) is a row in the shared
 * database: the web server enqueues it and reads its progress, and a worker (a separate process, or the server
 * itself) claims it under a lease. A worker that stops (restart, crash, deploy) lets its lease run out and the
 * job is picked up again, resuming from its checkpoints.
 */
import os from 'node:os';
import crypto from 'node:crypto';
import { globalDb, tx } from '../storage';

/** `animate` (one actor's 3D model, rig and clip sheets per run) runs beside a world's other jobs. */
export type JobKind = 'world' | 'rules' | 'art' | 'studio' | 'animate';
export type JobStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export const ACTIVE: JobStatus[] = ['queued', 'running', 'waiting'];

export interface JobPhase {
  id: string;
  label: string;
  /** What this stage does, in a few words. */
  detail: string;
  status: 'pending' | 'active' | 'done' | 'skipped';
  done?: number;
  total?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface JobPreview {
  title?: string;
  pitch?: string;
  zones?: string[];
  npcs?: string[];
  arcs?: string[];
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  worldId: string;
  ownerId: string;
  ownerName: string;
  params: unknown;
  status: JobStatus;
  /** Lower runs first. */
  priority: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  progress: number;
  step: string;
  error?: string;
  phases: JobPhase[];
  preview: JobPreview;
  cancelRequested: boolean;
  leaseOwner?: string;
  leaseUntil?: number;
}

export interface LogEntry {
  t: number;
  msg: string;
  kind: 'step' | 'info' | 'warn' | 'error' | 'preview';
}

const db = globalDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, world_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_name TEXT NOT NULL,
    params TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 5,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0, progress REAL NOT NULL DEFAULT 0, step TEXT NOT NULL DEFAULT '', error TEXT,
    phases TEXT NOT NULL DEFAULT '[]', preview TEXT NOT NULL DEFAULT '{}', cancel_requested INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT, lease_until INTEGER
  );
  CREATE INDEX IF NOT EXISTS jobs_world ON jobs (world_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, priority, created_at);
  CREATE TABLE IF NOT EXISTS job_log (job_id TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, msg TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS job_log_job ON job_log (job_id, t);
`);

interface Row {
  id: string; kind: string; world_id: string; owner_id: string; owner_name: string; params: string; status: string; priority: number;
  created_at: number; updated_at: number; started_at: number | null; finished_at: number | null; attempts: number; progress: number;
  step: string; error: string | null; phases: string; preview: string; cancel_requested: number; lease_owner: string | null; lease_until: number | null;
}

const toJob = (r: Row | undefined): JobRecord | undefined =>
  r && {
    id: r.id, kind: r.kind as JobKind, worldId: r.world_id, ownerId: r.owner_id, ownerName: r.owner_name, params: JSON.parse(r.params), status: r.status as JobStatus,
    priority: r.priority, createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at ?? undefined, finishedAt: r.finished_at ?? undefined, attempts: r.attempts,
    progress: r.progress, step: r.step, error: r.error ?? undefined, phases: JSON.parse(r.phases), preview: JSON.parse(r.preview), cancelRequested: !!r.cancel_requested,
    leaseOwner: r.lease_owner ?? undefined, leaseUntil: r.lease_until ?? undefined,
  };

const q = {
  insert: db.prepare(`INSERT INTO jobs (id, kind, world_id, owner_id, owner_name, params, status, priority, created_at, updated_at, step, phases)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`),
  get: db.prepare('SELECT * FROM jobs WHERE id = ?'),
  latestForWorld: db.prepare(`SELECT * FROM jobs WHERE world_id = ? AND kind != 'animate' ORDER BY created_at DESC LIMIT 1`),
  activeForWorld: db.prepare(`SELECT * FROM jobs WHERE world_id = ? AND kind != 'animate' AND status IN ('queued', 'running', 'waiting') ORDER BY created_at LIMIT 1`),
  queuedAnimation: db.prepare(`SELECT id FROM jobs WHERE world_id = ? AND kind = 'animate' AND status = 'queued' LIMIT 1`),
  activeForOwner: db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE owner_id = ? AND status IN ('queued', 'running', 'waiting')`),
  // Runnable: queued, or running/waiting under a lease that ran out (its worker stopped).
  claimable: db.prepare(`SELECT * FROM jobs WHERE status = 'queued' OR (status IN ('running', 'waiting') AND (lease_until IS NULL OR lease_until < ?))
    ORDER BY priority, created_at, rowid LIMIT 1`),
  // The same while background animation is paused (a paused animation job whose worker stopped waits too).
  claimableNoAnimation: db.prepare(`SELECT * FROM jobs WHERE kind != 'animate' AND (status = 'queued' OR (status IN ('running', 'waiting') AND (lease_until IS NULL OR lease_until < ?)))
    ORDER BY priority, created_at, rowid LIMIT 1`),
  queued: db.prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority, created_at, rowid`),
  running: db.prepare(`SELECT * FROM jobs WHERE status IN ('running', 'waiting') ORDER BY started_at`),
  finished: db.prepare(`SELECT * FROM jobs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?`),
  finishedSince: db.prepare(`SELECT kind, status, COUNT(*) AS n FROM jobs WHERE finished_at >= ? GROUP BY kind, status`),
  setPriority: db.prepare(`UPDATE jobs SET priority = ?, created_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`),
  queuedAhead: db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND (priority < ? OR (priority = ? AND created_at < ?))`),
  claim: db.prepare(`UPDATE jobs SET status = 'running', lease_owner = ?, lease_until = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`),
  renew: db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ? AND lease_owner = ?'),
  save: db.prepare('UPDATE jobs SET status = ?, progress = ?, step = ?, error = ?, phases = ?, preview = ?, updated_at = ?, finished_at = ? WHERE id = ?'),
  // A planned pause (worker restart) is not a failed start: it does not count toward the crash limit.
  requeue: db.prepare(`UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, attempts = MAX(0, attempts - 1), updated_at = ? WHERE id = ?`),
  cancel: db.prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?'),
  cancelQueued: db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`),
  cancelFlag: db.prepare('SELECT cancel_requested AS c FROM jobs WHERE id = ?'),
  log: db.prepare('INSERT INTO job_log (job_id, t, kind, msg) VALUES (?, ?, ?, ?)'),
  logSince: db.prepare('SELECT t, kind, msg FROM job_log WHERE job_id = ? AND t > ? ORDER BY t, rowid LIMIT 400'),
  logTail: db.prepare('SELECT t, kind, msg FROM (SELECT rowid, t, kind, msg FROM job_log WHERE job_id = ? ORDER BY t DESC, rowid DESC LIMIT ?) ORDER BY t, rowid'),
  purgeLogs: db.prepare(`DELETE FROM job_log WHERE job_id IN (SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?)`),
};

/** This process, as a lease holder. */
export const HOLDER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
export const LEASE_MS = 60_000;

/** Queue a job. One active job per world; a few per person. */
export function enqueue(kind: JobKind, worldId: string, owner: { id: string; name: string }, params: unknown, opts: { priority?: number; maxPerOwner?: number; step?: string; phases?: Omit<JobPhase, 'status'>[] } = {}): JobRecord {
  return tx(() => {
    if (q.activeForWorld.get(worldId)) throw new JobConflict('Something is already being made for this daydream; wait for it to finish.');
    if (opts.maxPerOwner && (q.activeForOwner.get(owner.id) as { n: number }).n >= opts.maxPerOwner) throw new JobConflict(`You already have ${opts.maxPerOwner} jobs queued or running; wait for one to finish.`);
    const id = `j_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    q.insert.run(id, kind, worldId, owner.id, owner.name, JSON.stringify(params ?? {}), opts.priority ?? 5, now, now, opts.step ?? 'Waiting for a free worker', JSON.stringify((opts.phases ?? []).map((p) => ({ ...p, status: 'pending' }))));
    return toJob(q.get.get(id) as unknown as Row)!;
  });
}

/** Queue a world's animation job (low priority: everything else goes first), unless one is already queued. */
export function enqueueAnimation(worldId: string, owner: { id: string; name: string }): void {
  tx(() => {
    if (q.queuedAnimation.get(worldId)) return;
    const id = `j_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    q.insert.run(id, 'animate', worldId, owner.id, owner.name, '{}', 8, now, now, 'Waiting for a free worker', '[]');
  });
}

export class JobConflict extends Error {}

export const getJobRecord = (id: string) => toJob(q.get.get(id) as unknown as Row | undefined);
export const latestJob = (worldId: string) => toJob(q.latestForWorld.get(worldId) as unknown as Row | undefined);
export const activeJob = (worldId: string) => toJob(q.activeForWorld.get(worldId) as unknown as Row | undefined);
export const queuePosition = (j: JobRecord) => (j.status === 'queued' ? (q.queuedAhead.get(j.priority, j.priority, j.createdAt) as { n: number }).n : 0);

/** Claim the next runnable job for this worker, under a lease (no animation job while that is paused). */
export function claimNext(holder = HOLDER, opts: { noAnimation?: boolean } = {}): JobRecord | undefined {
  return tx(() => {
    const now = Date.now();
    const r = toJob((opts.noAnimation ? q.claimableNoAnimation : q.claimable).get(now) as unknown as Row | undefined);
    if (!r) return undefined;
    q.claim.run(holder, now + LEASE_MS, now, now, r.id);
    return getJobRecord(r.id);
  });
}

export const renewLease = (id: string, holder = HOLDER) => q.renew.run(Date.now() + LEASE_MS, id, holder);
export const requeue = (id: string) => q.requeue.run(Date.now(), id);
export const cancelRequested = (id: string) => !!(q.cancelFlag.get(id) as { c: number } | undefined)?.c;

/** Ask a job to stop: a queued one is cancelled at once, a running one stops at its next check. */
export function requestCancel(id: string) {
  const now = Date.now();
  q.cancel.run(now, id);
  q.cancelQueued.run(now, now, id);
}

/** Queued jobs in the order they will run. */
export const queuedJobs = () => (q.queued.all() as unknown as Row[]).map((r) => toJob(r)!);
export const runningJobs = () => (q.running.all() as unknown as Row[]).map((r) => toJob(r)!);
export const finishedJobs = (n = 40) => (q.finished.all(n) as unknown as Row[]).map((r) => toJob(r)!);
/** Jobs finished since `t`, counted by kind and outcome. */
export const finishedCounts = (t: number) => q.finishedSince.all(t) as unknown as { kind: JobKind; status: JobStatus; n: number }[];

/** Give a queued job a new priority (lower runs first); false when it is no longer queued. */
export function setPriority(id: string, priority: number): boolean {
  const j = getJobRecord(id);
  if (!j || j.status !== 'queued') return false;
  return Number(q.setPriority.run(Math.round(priority), j.createdAt, Date.now(), id).changes) > 0;
}

/**
 * Move a queued job one place up or down the queue by swapping places with its neighbour: the two trade priority
 * and queued-at time (the queue orders by priority, then age).
 */
export function moveJob(id: string, dir: 'up' | 'down'): boolean {
  return tx(() => {
    const list = queuedJobs();
    const i = list.findIndex((j) => j.id === id);
    const me = list[i];
    const other = list[dir === 'up' ? i - 1 : i + 1];
    if (!me || !other) return false;
    const now = Date.now();
    // Queued in the same millisecond at the same priority: a millisecond apart, so the order is not left to chance.
    const tie = other.priority === me.priority && other.createdAt === me.createdAt;
    q.setPriority.run(other.priority, other.createdAt + (tie ? (dir === 'up' ? -1 : 1) : 0), now, me.id);
    if (!tie) q.setPriority.run(me.priority, me.createdAt, now, other.id);
    return true;
  });
}

export function saveJobState(j: Pick<JobRecord, 'id' | 'status' | 'progress' | 'step' | 'error' | 'phases' | 'preview' | 'finishedAt'>) {
  q.save.run(j.status, j.progress, j.step, j.error ?? null, JSON.stringify(j.phases), JSON.stringify(j.preview), Date.now(), j.finishedAt ?? null, j.id);
}

export function appendLog(id: string, entries: LogEntry[]) {
  if (!entries.length) return;
  tx(() => {
    for (const e of entries) q.log.run(id, e.t, e.kind, e.msg);
  });
}

export const logSince = (id: string, since: number) => q.logSince.all(id, since) as unknown as LogEntry[];
export const logTail = (id: string, n = 400) => q.logTail.all(id, n) as unknown as LogEntry[];

/** Old jobs' logs are dropped after a week (the job rows stay as history). */
export const purgeOldLogs = () => q.purgeLogs.run(Date.now() - 7 * 24 * 3600_000);
