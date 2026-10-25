/**
 * The admin GPU page's API: one view of everything that uses the GPU, and the controls over it.
 *
 * The view joins the layers GPU work passes through: the job queue (jobs waiting and running, in every process),
 * each process's published presence (a build's GPU queue, CLI runs' jobs), the GPU broker's queue (every
 * installation's work, the model it has loaded), ComfyUI's queue (whoever queued the prompt) and the GPU's memory.
 * Controls act through the same layers: the job queue's rows (cancel, priority), the switches every process reads
 * (pause), and the broker (remove or interrupt a prompt), so they work on jobs running in the separate worker
 * process too. Work from CLI runs is not in the job queue: only its ComfyUI prompts can be cleared.
 *
 * Administrators only; destructive actions need `confirm: true` and are written to the audit log.
 */
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import type { WorldDefinition } from '@gd/shared';
import { adminOnly, auth, type AuthedRequest } from '../auth';
import { listWorlds, loadWorld } from '../storage';
import { comfyFetch } from '../genai/comfyclient';
import { ACTIVE, finishedCounts, finishedJobs, getJobRecord, HOLDER, moveJob, queuedJobs, queuePosition, requestCancel, runningJobs, setPriority, type JobRecord } from '../jobs/queue';
import { animationQueue, failedActors, retryActor } from '../anim/job';
import { comfyBase } from '../worldgen/comfy';
import { audit, auditLog, control, processes, setControl, type ProcessRow } from './presence';
import { dropJobPrompts, dropPrompt, readDevice, readHistory, readQueue } from './comfyqueue';

let worldsCache: { t: number; titles: Map<string, string>; animation: { worldId: string; title: string; waiting: number; failed: { key: string; error?: string }[] }[] } | null = null;

/** World titles, actors waiting for animation and failed ones (reads every actor's files: cached 15 s, unless fresh). */
function worldsInfo(fresh = false) {
  if (!fresh && worldsCache && Date.now() - worldsCache.t < 15_000) return worldsCache;
  const titles = new Map<string, string>();
  const animation: NonNullable<typeof worldsCache>['animation'] = [];
  for (const w of listWorlds()) {
    titles.set(w.id, w.concept?.title ?? w.id);
    if (w.status !== 'ready') continue;
    const failed = failedActors(w);
    const waiting = animationQueue(w).length;
    if (failed.length || waiting) animation.push({ worldId: w.id, title: w.concept?.title ?? w.id, waiting, failed });
  }
  worldsCache = { t: Date.now(), titles, animation };
  return worldsCache;
}

/** The GPU broker's own queue: every installation's work, what runs and what it has loaded. */
async function brokerQueue(): Promise<{ up: boolean; error?: string; resident?: unknown; running?: unknown; queued?: unknown[]; down?: string[] }> {
  try {
    const res = await comfyFetch('/broker/queue', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { up: false, error: `HTTP ${res.status}` };
    return { up: true, ...((await res.json()) as object) };
  } catch (e) {
    return { up: false, error: `The GPU broker is not answering (${(e as Error).message}); start it with npm run broker` };
  }
}

/** Who a job worker is, in words. */
function describeHolder(holder: string | undefined, procs: ProcessRow[]): { label: string; role: string } {
  if (!holder) return { label: '—', role: 'none' };
  const p = procs.find((x) => x.holder === holder);
  if (p) return { label: `${p.label}${holder === HOLDER ? ' (this process)' : ''} · pid ${p.pid}`, role: p.role };
  return { label: `unregistered process ${holder.split(':').slice(1, 2).join('')} (older code, most likely a CLI run)`, role: 'unknown' };
}

function jobView(j: JobRecord, titles: Map<string, string>, procs: ProcessRow[]) {
  const by = j.leaseOwner && j.status !== 'queued' ? describeHolder(j.leaseOwner, procs) : undefined;
  return {
    id: j.id,
    kind: j.kind,
    worldId: j.worldId,
    world: titles.get(j.worldId) ?? j.worldId,
    owner: j.ownerName,
    status: j.status,
    priority: j.priority,
    step: j.step,
    progress: j.progress,
    error: j.error,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    attempts: j.attempts,
    cancelRequested: j.cancelRequested,
    position: j.status === 'queued' ? queuePosition(j) : undefined,
    worker: by?.label,
  };
}

export async function gpuSnapshot(opts: { fresh?: boolean } = {}) {
  const now = Date.now();
  const base = comfyBase();
  const procs = processes();
  const [device, comfy, history, broker] = await Promise.all([readDevice(base), readQueue(base), readHistory(base), brokerQueue()]);
  const { titles, animation } = worldsInfo(opts.fresh);
  const counts = finishedCounts(now - 24 * 3600_000);
  const sum = (f: (c: (typeof counts)[number]) => boolean) => counts.filter(f).reduce((a, c) => a + c.n, 0);
  const actors6h = finishedCounts(now - 6 * 3600_000).filter((c) => c.kind === 'animate' && c.status === 'done').reduce((a, c) => a + c.n, 0);
  return {
    now,
    thisProcess: HOLDER,
    control: { paused: control('paused'), animationPaused: control('animationPaused') },
    device,
    broker,
    processes: procs.map((p) => ({ ...p, isThis: p.holder === HOLDER })),
    jobs: {
      running: runningJobs().map((j) => jobView(j, titles, procs)),
      queued: queuedJobs().map((j) => jobView(j, titles, procs)),
      recent: finishedJobs(30).map((j) => jobView(j, titles, procs)),
    },
    comfy: { url: base, ...comfy, failures: history?.failures ?? [] },
    animation,
    throughput: {
      comfyPromptsLastHour: history?.lastHour ?? null,
      imagesLastHour: history?.imagesLastHour ?? null,
      actorsPerHour: Math.round((actors6h / 6) * 10) / 10,
      jobsDone24h: sum((c) => c.status === 'done'),
      jobsFailed24h: sum((c) => c.status === 'failed'),
      jobsCancelled24h: sum((c) => c.status === 'cancelled'),
    },
    audit: auditLog(30),
  };
}

const Confirm = z.object({ confirm: z.literal(true) });
const admin = (req: Request) => (req as AuthedRequest).user;
const needConfirm = (req: Request, res: Response) => {
  if (Confirm.safeParse(req.body ?? {}).success) return true;
  res.status(400).json({ error: 'This action needs confirming (confirm: true).' });
  return false;
};

/** The admin GPU routes under /api/admin/gpu, behind sign-in and the administrator check. */
export function mountGpuAdmin(app: Express) {
  const r = express.Router();
  r.use(auth, adminOnly);

  r.get('/', async (req, res) => {
    res.json(await gpuSnapshot({ fresh: req.query.fresh === '1' }));
  });

  /** Pause or resume new GPU work (scope all) or background animation alone. */
  r.post('/pause', (req, res) => {
    const body = z.object({ scope: z.enum(['all', 'animation']), on: z.boolean() }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'scope (all or animation) and on are required.' });
    const key = body.data.scope === 'all' ? 'paused' : 'animationPaused';
    setControl(key, body.data.on, admin(req).username);
    audit(admin(req), body.data.on ? 'pause' : 'resume', body.data.scope === 'all' ? 'all GPU work' : 'background animation');
    res.json({ paused: control('paused'), animationPaused: control('animationPaused') });
  });

  /** A queued job's new priority, or one place up or down. */
  r.post('/jobs/:id/priority', (req, res) => {
    const body = z.object({ priority: z.number().int().min(0).max(99).optional(), move: z.enum(['up', 'down']).optional() }).safeParse(req.body);
    if (!body.success || (body.data.priority === undefined) === !body.data.move) return void res.status(400).json({ error: 'Give a priority (0-99) or a move (up or down).' });
    const id = String(req.params.id);
    const j = getJobRecord(id);
    if (!j) return void res.status(404).json({ error: 'No such job.' });
    const ok = body.data.move ? moveJob(id, body.data.move) : setPriority(id, body.data.priority!);
    if (!ok) return void res.status(409).json({ error: body.data.move ? 'It cannot move further.' : 'Only a queued job can change priority.' });
    audit(admin(req), body.data.move ? `move ${body.data.move}` : 'set priority', `${j.kind} job ${id} (${j.worldId})`, body.data.move ? '' : `${j.priority} → ${body.data.priority}`);
    res.json({ ok: true });
  });

  /**
   * Cancel a queued job, or stop a running one: it is asked to stop (it does at its next check, within a second
   * or so), its ComfyUI prompts are removed or interrupted, and what it finished stays for a later resume.
   */
  r.post('/jobs/:id/cancel', async (req, res) => {
    if (!needConfirm(req, res)) return;
    const id = String(req.params.id);
    const j = getJobRecord(id);
    if (!j) return void res.status(404).json({ error: 'No such job.' });
    if (!ACTIVE.includes(j.status)) return void res.status(409).json({ error: `It already ended (${j.status}).` });
    requestCancel(id);
    const dropped = j.status === 'queued' ? 0 : await dropJobPrompts(comfyBase(), id).catch(() => 0);
    audit(admin(req), j.status === 'queued' ? 'cancel' : 'stop', `${j.kind} job ${id} (${j.worldId})`, dropped ? `${dropped} ComfyUI prompt(s) cleared` : '');
    worldsCache = null;
    res.json({ ok: true, stopped: j.status !== 'queued', promptsCleared: dropped });
  });

  /** Take a prompt off ComfyUI (any origin, CLI runs included): removed while pending, interrupted while running. */
  r.post('/comfy/:promptId/clear', async (req, res) => {
    if (!needConfirm(req, res)) return;
    const id = String(req.params.promptId);
    try {
      const outcome = await dropPrompt(comfyBase(), id);
      if (outcome === 'gone') return void res.status(404).json({ error: 'That prompt is no longer queued.' });
      audit(admin(req), outcome === 'removed' ? 'remove prompt' : 'interrupt prompt', `ComfyUI ${id}`);
      res.json({ ok: true, outcome });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  /** Try a failed animation actor again. */
  r.post('/actors/retry', (req, res) => {
    const body = z.object({ worldId: z.string().min(1).max(80), key: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'worldId and key are required.' });
    const w: WorldDefinition | null = loadWorld(body.data.worldId);
    if (!w) return void res.status(404).json({ error: 'No such daydream.' });
    if (!retryActor(w, body.data.key)) return void res.status(409).json({ error: 'That actor has no failed animation to retry.' });
    audit(admin(req), 'retry animation', `${body.data.key} (${w.id})`);
    worldsCache = null;
    res.json({ ok: true });
  });

  app.use('/api/admin/gpu', r);
}
