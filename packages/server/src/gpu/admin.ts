/**
 * The admin GPU page's API: one view of everything that uses the GPU, and the controls over it.
 *
 * The view joins the layers GPU work passes through: the job queue (jobs waiting and running, in every process),
 * each process's published presence (its GPU scheduler's calls, a build's GPU queue, CLI runs' jobs), the GPU lease
 * in the shared database (which process has the GPU and the model it last ran), ComfyUI's queue (whoever queued
 * the prompt) and the GPU's memory. Controls act through the same layers: the job queue's rows (cancel, priority),
 * the switches every process reads (pause), and ComfyUI itself (remove or interrupt a prompt, free its models),
 * so they work on jobs running in the separate worker process too. Work from CLI runs is not in the job queue:
 * only its ComfyUI prompts can be cleared.
 *
 * Administrators only; destructive actions need `confirm: true` and are written to the audit log.
 */
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import type { WorldDefinition } from '@gd/shared';
import { adminOnly, auth, type AuthedRequest } from '../auth';
import { listWorlds, loadWorld } from '../storage';
import { genai } from '../genai/service';
import { evictAll, gpuLeases } from '../genai/gpu';
import type { ProviderConfig } from '../genai/types';
import { ACTIVE, finishedCounts, finishedJobs, getJobRecord, HOLDER, moveJob, queuedJobs, queuePosition, requestCancel, runningJobs, setPriority, type JobRecord } from '../jobs/queue';
import { animationQueue, failedActors, retryActor } from '../anim/job';
import { comfyBase } from '../worldgen/comfy';
import { audit, auditLog, control, processes, setControl, type ProcessRow } from './presence';
import { dropJobPrompts, dropPrompt, readDevice, readHistory, readQueue } from './comfyqueue';

const root = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, '');

/** Providers sharing a GPU, by group. */
function gpuGroups(): Map<string, Map<string, ProviderConfig>> {
  const out = new Map<string, Map<string, ProviderConfig>>();
  for (const [name, cfg] of Object.entries(genai().config.providers ?? {})) {
    if (!cfg.gpu) continue;
    if (!out.has(cfg.gpu)) out.set(cfg.gpu, new Map());
    out.get(cfg.gpu)!.set(name, cfg);
  }
  return out;
}

let loadedCache: { t: number; v: Record<string, string[]> } | null = null;

/** Models the local LLM routers report loaded, by GPU group (cached 3 s). */
async function routerModels(groups: Map<string, Map<string, ProviderConfig>>): Promise<Record<string, string[]>> {
  if (loadedCache && Date.now() - loadedCache.t < 3000) return loadedCache.v;
  const v: Record<string, string[]> = {};
  for (const [g, members] of groups) {
    const seen = new Set<string>();
    for (const cfg of members.values()) {
      if (cfg.type === 'comfyui' || !cfg.baseUrl || seen.has(root(cfg.baseUrl))) continue;
      seen.add(root(cfg.baseUrl));
      try {
        const data = (await (await fetch(`${root(cfg.baseUrl)}/models`, { signal: AbortSignal.timeout(2000) })).json()) as { data?: { id: string; status?: { value?: string } }[] };
        for (const m of data.data ?? []) if (m.status?.value && m.status.value !== 'unloaded') (v[g] ??= []).push(m.id);
      } catch {
        // Not a router, or down.
      }
    }
  }
  loadedCache = { t: Date.now(), v };
  return v;
}

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

/** Who a lease holder or job worker is, in words. */
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
  const groups = gpuGroups();
  const [device, comfy, history, loaded] = await Promise.all([readDevice(base), readQueue(base), readHistory(base), routerModels(groups)]);
  const { titles, animation } = worldsInfo(opts.fresh);
  const leases = gpuLeases();
  const groupNames = [...new Set([...groups.keys(), ...leases.map((l) => l.group)])];
  const counts = finishedCounts(now - 24 * 3600_000);
  const sum = (f: (c: (typeof counts)[number]) => boolean) => counts.filter(f).reduce((a, c) => a + c.n, 0);
  const actors6h = finishedCounts(now - 6 * 3600_000).filter((c) => c.kind === 'animate' && c.status === 'done').reduce((a, c) => a + c.n, 0);
  return {
    now,
    thisProcess: HOLDER,
    control: { paused: control('paused'), animationPaused: control('animationPaused') },
    device,
    groups: groupNames.map((g) => {
      const l = leases.find((x) => x.group === g);
      // The call running on this group, in whichever process has it.
      const running = procs.filter((p) => !p.stale).flatMap((p) => p.state.calls.filter((c) => c.group === g && c.running).map((c) => ({ ...c, holder: p.holder, process: describeHolder(p.holder, procs).label, role: p.role })));
      return {
        group: g,
        holder: l?.held ? { id: l.holder, ...describeHolder(l.holder, procs) } : null,
        lastModel: l?.model || null,
        routerLoaded: loaded[g] ?? [],
        running,
        waiting: (l?.waiting ?? []).map((w) => ({ ...w, ...describeHolder(w.holder, procs) })),
      };
    }),
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

  /** Unload every model on the GPU's servers (ComfyUI frees its models; LLM routers unload theirs). */
  r.post('/unload', async (req, res) => {
    if (!needConfirm(req, res)) return;
    const groups = gpuGroups();
    for (const members of groups.values()) await evictAll(members);
    loadedCache = null;
    audit(admin(req), 'unload models', [...groups.keys()].join(', ') || 'no GPU groups');
    res.json({ ok: true, groups: [...groups.keys()] });
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
