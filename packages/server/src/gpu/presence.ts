/**
 * What each process is doing on the GPU, where every other process can see it. A build's GPU queue and a CLI run's
 * jobs live in memory, and in development the job worker and CLI runs are separate processes from the web server:
 * each process publishes a snapshot of its build queues and running jobs to the shared database every second or so,
 * and the admin GPU page reads them all (the GPU broker reports its own queue).
 * Nothing here orders work; it only reports it.
 *
 * Also here: the admins' switches every process obeys (pause GPU work, pause background animation), the log of
 * what admins did, and the tag every ComfyUI prompt carries so the page can say which process queued it.
 */
import os from 'node:os';
import path from 'node:path';
import { globalDb } from '../storage';
import { HOLDER } from '../jobs/queue';
import { callContext, PRIORITY_RANK } from '../genai/context';

export type ProcessRole = 'server' | 'worker' | 'cli';

/** Which job a piece of GPU work is for (CLI runs have no job id). */
export interface WorkTag {
  jobId?: string;
  worldId?: string;
  kind?: string;
}

export interface BuildQueueState {
  tag?: WorkTag;
  running?: { model: string; priority: number; since: number };
  pending: { model: string; priority: number }[];
}

export interface TaskState {
  tag: WorkTag;
  step: string;
  progress: number;
  since: number;
}

export interface ProcessState {
  builds: BuildQueueState[];
  tasks: TaskState[];
}

export interface ProcessRow {
  holder: string;
  role: ProcessRole;
  label: string;
  pid: number;
  host: string;
  startedAt: number;
  seen: number;
  state: ProcessState;
}

const db = globalDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS gpu_procs (holder TEXT PRIMARY KEY, role TEXT NOT NULL, label TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL,
    started_at INTEGER NOT NULL, seen INTEGER NOT NULL, state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS gpu_control (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS gpu_audit (at INTEGER NOT NULL, admin_id TEXT NOT NULL, admin_name TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS gpu_audit_at ON gpu_audit (at DESC);
`);
const q = {
  put: db.prepare(`INSERT INTO gpu_procs (holder, role, label, pid, host, started_at, seen, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(holder) DO UPDATE SET role = excluded.role, label = excluded.label, seen = excluded.seen, state = excluded.state`),
  drop: db.prepare('DELETE FROM gpu_procs WHERE holder = ?'),
  prune: db.prepare('DELETE FROM gpu_procs WHERE seen < ?'),
  all: db.prepare('SELECT * FROM gpu_procs ORDER BY started_at'),
  getControl: db.prepare('SELECT value FROM gpu_control WHERE key = ?'),
  setControl: db.prepare('INSERT INTO gpu_control (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  clearControl: db.prepare('DELETE FROM gpu_control WHERE key = ?'),
  audit: db.prepare('INSERT INTO gpu_audit (at, admin_id, admin_name, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)'),
  auditTail: db.prepare('SELECT at, admin_id AS adminId, admin_name AS adminName, action, target, detail FROM gpu_audit ORDER BY at DESC LIMIT ?'),
};

// ------------------------------------------------------------------------------------ this process

/** A process not started as the web server or the worker is a CLI run, named after its script and arguments. */
const me = {
  role: 'cli' as ProcessRole,
  label: [path.basename(process.argv[1] ?? 'node').replace(/\.[jt]s$/, ''), ...process.argv.slice(2)].join(' ').slice(0, 120),
  startedAt: Date.now(),
};

export function setProcessRole(role: ProcessRole, label?: string) {
  me.role = role;
  me.label = label ?? role;
  touch();
}

type Source = () => Partial<ProcessState>;
const sources = new Set<Source>();
let timer: ReturnType<typeof setTimeout> | null = null;
let dueAt = 0;
let lastWrite = 0;

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  dueAt = Date.now() + ms;
  timer = setTimeout(flush, ms);
  timer.unref?.();
}

/** Add something that reports GPU work (a build queue, a job); returns its removal. */
export function report(src: Source): () => void {
  sources.add(src);
  touch();
  return () => {
    sources.delete(src);
    touch();
  };
}

/** Something changed: publish soon (at most once a second). */
export function touch() {
  const ms = Math.max(0, 1000 - (Date.now() - lastWrite));
  if (timer && dueAt <= Date.now() + ms) return;
  schedule(ms);
}

export function snapshot(): ProcessState {
  const out: ProcessState = { builds: [], tasks: [] };
  for (const s of sources) {
    try {
      const p = s();
      out.builds.push(...(p.builds ?? []));
      out.tasks.push(...(p.tasks ?? []));
    } catch {
      // A reporter that fails leaves the rest.
    }
  }
  return out;
}

/** Write this process's row now (also the heartbeat: every 5 s while it has anything to report, else every 15 s). */
export function flush() {
  lastWrite = Date.now();
  try {
    q.put.run(HOLDER, me.role, me.label, process.pid, os.hostname(), me.startedAt, lastWrite, JSON.stringify(snapshot()));
  } catch {
    // The database is busy or closing: the next beat tries again.
  }
  schedule(sources.size ? 5000 : 15000);
}

process.on('exit', () => {
  try {
    q.drop.run(HOLDER);
  } catch {
    /* closing */
  }
});

// ------------------------------------------------------------------------------------ every process

/** A process that has not written for this long is gone (it stopped without saying so). */
export const STALE_MS = 20_000;

export function processes(): (ProcessRow & { stale: boolean })[] {
  const now = Date.now();
  q.prune.run(now - 10 * 60_000);
  return (q.all.all() as { holder: string; role: string; label: string; pid: number; host: string; started_at: number; seen: number; state: string }[]).map((r) => ({
    holder: r.holder,
    role: r.role as ProcessRole,
    label: r.label,
    pid: r.pid,
    host: r.host,
    startedAt: r.started_at,
    seen: r.seen,
    state: JSON.parse(r.state) as ProcessState,
    stale: now - r.seen > STALE_MS,
  }));
}

// ------------------------------------------------------------------------------------ admins' switches

export type ControlKey = 'paused' | 'animationPaused';
export interface Control {
  by: string;
  at: number;
}

const controlCache = new Map<ControlKey, { v: Control | null; t: number }>();

/** A switch, read at most every half second (waiting work asks often). */
export function control(key: ControlKey): Control | null {
  const c = controlCache.get(key);
  if (c && Date.now() - c.t < 500) return c.v;
  const row = q.getControl.get(key) as { value: string } | undefined;
  const v = row ? (JSON.parse(row.value) as Control) : null;
  controlCache.set(key, { v, t: Date.now() });
  return v;
}

export function setControl(key: ControlKey, on: boolean, by: string) {
  if (on) q.setControl.run(key, JSON.stringify({ by, at: Date.now() }));
  else q.clearControl.run(key);
  controlCache.delete(key);
}

/** Whether work of this kind and GPU rank should wait: everything but players' own calls when paused. */
export function pausedFor(rank: number, kind?: string): string | null {
  if (rank > 0 && control('paused')) return 'Paused by an administrator';
  if (kind === 'animate' && control('animationPaused')) return 'Animation paused by an administrator';
  return null;
}

// ------------------------------------------------------------------------------------ audit

export function audit(admin: { id: string; username: string }, action: string, target: string, detail = '') {
  q.audit.run(Date.now(), admin.id, admin.username, action, target, detail);
  console.log(`[gpu admin] ${admin.username}: ${action} ${target}${detail ? ` (${detail})` : ''}`);
}

export const auditLog = (n = 40) => q.auditTail.all(n) as { at: number; adminId: string; adminName: string; action: string; target: string; detail: string }[];

// ------------------------------------------------------------------------------------ ComfyUI prompt tags

/** Carried in every ComfyUI prompt's extra_data so the admin page can say who queued it. */
export interface PromptTag extends WorkTag {
  holder: string;
  role: ProcessRole;
  label: string;
  workflow?: string;
  /** The GPU broker's urgency: 0 a player waits, 1 studio, 2 world builds, 3 background animation. */
  rank?: number;
}

export function promptTag(workflow?: string): PromptTag {
  const ctx = callContext();
  const rank = !ctx ? 2 : ctx.tag?.kind === 'animate' ? 3 : PRIORITY_RANK[ctx.priority];
  return { holder: HOLDER, role: me.role, label: me.label, workflow, rank, ...ctx?.tag };
}

/** The body of a ComfyUI /prompt request, tagged with this process and the job it is for. */
export function promptBody(prompt: unknown, workflow?: string, promptId?: string): string {
  return JSON.stringify({ prompt, prompt_id: promptId, client_id: `gd-${me.role}`, extra_data: { gd: promptTag(workflow) } });
}
