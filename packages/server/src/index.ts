/** HTTP + WebSocket server entry point. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { COMBAT_MODES, DIFFICULTIES, GAME_LENGTHS, WORLD_SIZES, type ClientMessage, type ServerMessage, type WorldDefinition } from '@gd/shared';
import { CLIENT_DIST, CONFIG_DIR } from './paths';
import * as store from './storage';
import { genai, reloadGenAI } from './genai/service';
import { imagePromptSystem } from './genai/images';
import { backdropSentence, cutout, finishCutout } from './genai/cutout';
import { sendAsset } from './assetroute';
import { resumeWorldGeneration, startWorldGeneration } from './worldgen/pipeline';
import { activeJob, ACTIVE, enqueue, JobConflict, latestJob, logSince, logTail, queuePosition, requestCancel, type JobKind } from './jobs/queue';
import { startWorker } from './jobs/worker';
import { dailyLimitFor, installSpendLedger } from './spending';
import { withCallContext } from './genai/context';
import { BudgetExceeded } from './genai/spend';
import { applyEdit, EditSchema, studioView, TaskSchema } from './worldgen/studio';
import { animationConfig } from './anim/animator';
import { queueAnimation, requestRedo } from './anim/job';
import { incompatibility, instances } from './game/manager';

const PORT = Number(process.env.GD_PORT ?? 3000);
const app = express();
app.use(express.json({ limit: '2mb' }));

// ------------------------------------------------------------------------------ auth

function cookie(req: Request | http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

type AuthedRequest = Request & { user: store.User };

/** Today's AI spending against a user's daily budget (limit null: unlimited). */
const aiOf = (u: store.User) => {
  const limit = dailyLimitFor(u.id);
  return { spentToday: Math.round(store.spentToday(u.id).usd * 10000) / 10000, limit: Number.isFinite(limit) ? limit : null };
};

const meOf = (u: store.User) => ({ id: u.id, username: u.username, isAdmin: u.isAdmin, mustChangePassword: u.mustChangePassword, ai: aiOf(u) });

/** Signed-in users only. Until a one-time password is replaced, only the password change is open. */
function signedIn(allowPending: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = store.sessionUser(cookie(req, 'gd_session'));
    if (!user) return void res.status(401).json({ error: 'Please sign in.' });
    if (user.mustChangePassword && !allowPending) return void res.status(403).json({ error: 'Choose a new password first.', code: 'password_change_required' });
    (req as AuthedRequest).user = user;
    next();
  };
}
const auth = signedIn(false);
const authPending = signedIn(true);

function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (!(req as AuthedRequest).user?.isAdmin) return void res.status(403).json({ error: 'Admins only.' });
  next();
}

const setSession = (res: Response, token: string) =>
  res.setHeader('Set-Cookie', `gd_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);

const Credentials = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) });

/** Failed sign-ins per user id and per address: a short lockout after repeated failures. */
const failures = new Map<string, { n: number; until: number }>();
const locked = (k: string) => (failures.get(k)?.until ?? 0) > Date.now();
const fail = (k: string) => {
  const f = failures.get(k) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) {
    f.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (f.n - 5));
  }
  failures.set(k, f);
};

app.post('/api/auth/login', (req, res) => {
  const body = Credentials.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'User id and password are required.' });
  const keys = [`u:${body.data.username.trim().toLowerCase()}`, `ip:${req.ip}`];
  if (keys.some(locked)) return void res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
  const u = store.verifyUser(body.data.username, body.data.password);
  if (!u) {
    keys.forEach(fail);
    return void res.status(401).json({ error: 'Wrong user id or password.' });
  }
  keys.forEach((k) => failures.delete(k));
  setSession(res, store.createSession(u.id));
  res.json(meOf(u));
});

app.post('/api/auth/logout', (req, res) => {
  const t = cookie(req, 'gd_session');
  if (t) store.deleteSession(t);
  res.setHeader('Set-Cookie', 'gd_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

/** Speech to text for conversations: a short recording in, its words out (charged to the speaker's AI budget). */
app.get('/api/voice', auth, (_req, res) => {
  res.json({ speechInput: !genai().isProcedural('speech.input') });
});

app.post('/api/voice/transcribe', auth, express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '6mb' }), async (req, res) => {
  const u = (req as AuthedRequest).user;
  if (genai().isProcedural('speech.input')) return void res.status(404).json({ error: 'No speech model is configured.' });
  const audio = req.body as Buffer;
  if (!Buffer.isBuffer(audio) || audio.length < 400) return void res.status(400).json({ error: 'No audio received.' });
  try {
    const lang = typeof req.query.lang === 'string' ? req.query.lang.slice(0, 2) : undefined;
    const text = await withCallContext({ priority: 'interactive', userId: u.id }, () => genai().transcribe('speech.input', audio, String(req.headers['content-type'] ?? 'audio/webm'), lang));
    res.json({ text });
  } catch (e) {
    res.status(e instanceof BudgetExceeded ? 402 : 502).json({ error: (e as Error).message });
  }
});

app.get('/api/me', authPending, (req, res) => {
  res.json(meOf((req as AuthedRequest).user));
});

/** Change your own password (required after an administrator set it). Other sessions are signed out. */
app.post('/api/auth/password', authPending, (req, res) => {
  const body = z.object({ current: z.string().max(200), next: z.string().max(200) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'Current and new password are required.' });
  const u = (req as AuthedRequest).user;
  try {
    store.changePassword(u.id, body.data.current, body.data.next, cookie(req, 'gd_session'));
  } catch (e) {
    return void res.status(400).json({ error: (e as Error).message });
  }
  res.json(meOf(store.getUser(u.id)!));
});

// ------------------------------------------------------------------------------ user administration

const userRow = (u: store.User, week?: Record<string, { usd: number; calls: number }>) => ({ ...meOf(u), createdAt: u.createdAt, dailyLimitUsd: u.dailyLimitUsd, spentWeek: Math.round((week?.[u.id]?.usd ?? 0) * 10000) / 10000 });

app.get('/api/admin/users', auth, adminOnly, (_req, res) => {
  const week = store.spendSince(store.spendDay(Date.now() - 6 * 86400_000));
  res.json(store.listUsers().map((u) => userRow(u, week)));
});

/** The whole server's AI spending today, its ceiling and the default per-user budget. */
app.get('/api/admin/spending', auth, adminOnly, (_req, res) => {
  const s = genai().config.spending ?? {};
  const week = store.spendSince(store.spendDay(Date.now() - 6 * 86400_000));
  res.json({ today: Math.round(store.spentTodayTotal() * 10000) / 10000, dailyTotalUsd: s.dailyTotalUsd ?? null, dailyPerUserUsd: s.dailyPerUserUsd ?? null, adminsUnlimited: s.adminsUnlimited !== false, systemWeek: week.system?.usd ?? 0 });
});

/** Invite a user: the server makes a one-time password, shown to the administrator once. */
app.post('/api/admin/users', auth, adminOnly, (req, res) => {
  const body = z.object({ username: z.string().max(40), isAdmin: z.boolean().default(false) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'A user id is required.' });
  try {
    const { user, password } = store.inviteUser(body.data.username, body.data.isAdmin);
    res.json({ user: userRow(user), password });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/admin/users/:id/reset', auth, adminOnly, (req, res) => {
  try {
    res.json({ password: store.resetPassword(String(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.patch('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const body = z.object({ isAdmin: z.boolean().optional(), dailyLimitUsd: z.number().min(0).max(1000).nullable().optional() }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'Nothing to change.' });
  try {
    if (body.data.isAdmin !== undefined) store.setAdmin(String(req.params.id), body.data.isAdmin);
    // A number sets this user's own daily AI budget; null returns them to the server default.
    if (body.data.dailyLimitUsd !== undefined) store.setDailyLimit(String(req.params.id), body.data.dailyLimitUsd);
    res.json(userRow(store.getUser(String(req.params.id))!));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ------------------------------------------------------------------------------ worlds

/** A daydream's own art for its card: the painting of its first place and a few of its people and foes. */
function coverArt(w: WorldDefinition): { scene?: string; figures: string[] } | undefined {
  const ok = (k: string) => (w.assets[k]?.status === 'ok' ? w.assets[k]!.file : undefined);
  const scene = ok(`place_${w.startZoneId}`);
  const keys = [...w.bosses.map((b) => `spr_boss_${b.id}`), ...w.npcs.filter((n) => n.essential).map((n) => `spr_npc_${n.id}`), ...w.origins.map((o) => `spr_origin_${o.id}_androgynous`), ...w.npcs.map((n) => `spr_npc_${n.id}`)];
  const figures = [...new Set(keys.map(ok).filter((f): f is string => !!f))].slice(0, 4);
  return scene || figures.length ? { scene, figures } : undefined;
}

function worldSummary(w: WorldDefinition) {
  const latest = latestJob(w.id);
  const job = latest && ACTIVE.includes(latest.status) ? latest : undefined;
  return {
    id: w.id,
    title: w.concept.title,
    pitch: w.concept.pitch,
    genre: w.concept.genre,
    ownerId: w.ownerId,
    ownerName: w.ownerName,
    public: w.public,
    status: job ? 'generating' : w.status,
    createdAt: w.createdAt,
    input: { size: w.input.size, length: w.input.length, combatMode: w.input.combatMode, communication: w.input.communication, difficulty: w.input.difficulty ?? 'normal' },
    rules: w.ruleset ? { name: w.ruleset.name, classes: w.ruleset.classes.map((c) => c.name), balance: w.ruleset.balance ? { at: w.ruleset.balance.at, ok: w.ruleset.balance.scenarios.filter((x) => x.ok).length, total: w.ruleset.balance.scenarios.length, durationMs: w.ruleset.balance.durationMs } : undefined } : undefined,
    zones: w.zones.filter((z) => z.kind !== 'interior').length,
    npcs: w.npcs.length,
    quests: w.quests.length,
    palette: w.concept.palette,
    cover: Object.values(w.assets).find((a) => a.status === 'ok' && a.kind === 'sprite')?.file,
    coverArt: coverArt(w),
    artProgress: { ok: Object.values(w.assets).filter((a) => a.status === 'ok').length, total: Object.keys(w.assets).length },
    job: latest && (job || latest.status === 'failed') ? { status: latest.status, progress: latest.progress, step: latest.step, error: latest.error, queuePosition: queuePosition(latest) } : undefined,
  };
}

app.get('/api/worlds', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  res.json(store.listWorlds().filter((w) => w.public || w.ownerId === u.id).map(worldSummary));
});

const WorldInputSchema = z.object({
  setting: z.string().trim().min(10, 'Describe the setting in at least a sentence.').max(4000),
  story: z.string().max(4000).optional(),
  notes: z.string().max(4000).optional(),
  size: z.enum(WORLD_SIZES),
  length: z.enum(GAME_LENGTHS),
  communication: z.coerce.number().int().min(0).max(3).transform((n) => n as 0 | 1 | 2 | 3),
  combatMode: z.enum(COMBAT_MODES),
  seed: z.string().max(40).optional(),
  art: z.enum(['none', 'essential', 'full']).default('essential'),
  difficulty: z.enum(DIFFICULTIES as [string, ...string[]]).optional() as z.ZodOptional<z.ZodType<'story' | 'easy' | 'normal' | 'hard' | 'brutal'>>,
  rules: z
    .object({
      turnModel: z.enum(['ap']).optional(),
      deathMode: z.enum(['corpse_run']).optional(),
      revive: z.enum(['heal', 'special', 'after_combat']).optional(),
      crit: z.boolean().optional(),
      dodge: z.boolean().optional(),
      control: z.boolean().optional(),
      surfaces: z.boolean().optional(),
      traps: z.boolean().optional(),
      locks: z.boolean().optional(),
      crafting: z.boolean().optional(),
      upgrades: z.boolean().optional(),
      enchanting: z.boolean().optional(),
      classes: z.number().int().min(2).max(6).optional(),
    })
    .optional(),
});

app.post('/api/worlds', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const body = WorldInputSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input.' });
  try {
    res.json(startWorldGeneration(body.data, { id: u.id, name: u.username }, { maxPerOwner: u.isAdmin ? undefined : 2 }));
  } catch (e) {
    if (e instanceof JobConflict) return void res.status(429).json({ error: e.message });
    throw e;
  }
});

app.get('/api/worlds/:id', auth, (req, res) => {
  const w = store.loadWorld(String(req.params.id));
  if (!w) return void res.status(404).json({ error: 'Daydream not found.' });
  res.json(worldSummary(w));
});

app.get('/api/worlds/:id/job', auth, (req, res) => {
  const id = String(req.params.id);
  const job = latestJob(id);
  const w = store.loadWorld(id);
  if (!job) return void res.json({ status: w?.status === 'ready' ? 'done' : w?.status ?? 'unknown', progress: w?.status === 'ready' ? 1 : 0, step: '', log: (w?.generationLog ?? []).map((msg) => ({ t: 0, msg, kind: 'info' })), preview: {} });
  const since = Number(req.query.since ?? 0);
  res.json({ id: job.id, kind: job.kind, status: job.status, progress: job.progress, step: job.step, error: job.error, log: since ? logSince(job.id, since) : logTail(job.id), preview: job.preview, phases: job.phases, queuePosition: queuePosition(job) });
});

app.post('/api/worlds/:id/cancel', auth, (req, res) => {
  const job = activeJob(String(req.params.id));
  const u = (req as AuthedRequest).user;
  if (job && (job.ownerId === u.id || u.isAdmin)) requestCancel(job.id);
  res.json({ ok: true });
});

app.delete('/api/worlds/:id', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w) return void res.status(404).json({ error: 'Not found.' });
  if (w.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Not your daydream.' });
  store.deleteWorld(w.id);
  res.json({ ok: true });
});

/** Regenerate the world's rules (new ruleset intent from the AI) or rebalance (same intent, current engine). Lore and art stay. */
app.get('/api/worlds/:id/rules', auth, (req, res) => {
  const w = store.loadWorld(String(req.params.id));
  if (!w) return void res.status(404).json({ error: 'Not found.' });
  res.json({ ruleset: w.ruleset ?? null, canRebalance: !!w.rulesIntent });
});

/** Continue a build that stopped (a model or service was down): finished steps are kept. */
app.post('/api/worlds/:id/resume', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'failed') return void res.status(404).json({ error: 'No stopped build to resume.' });
  if (w.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Not your daydream.' });
  if (activeJob(w.id)) return void res.status(409).json({ error: 'This daydream is already being made.' });
  resumeWorldGeneration(w);
  res.json({ ok: true });
});

app.post('/api/worlds/:id/rules', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'ready') return void res.status(404).json({ error: 'Not found.' });
  if (w.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Not your daydream.' });
  const mode = req.body?.mode === 'rebalance' && w.rulesIntent ? 'rebalance' : 'regenerate';
  if (!queueJob(res, 'rules', w, u, { mode })) return;
  res.json({ ok: true, mode });
});

app.post('/api/worlds/:id/art', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'ready') return void res.status(404).json({ error: 'Not found.' });
  if (w.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Not your daydream.' });
  if (genai().isProcedural('image.sprite')) return void res.status(400).json({ error: 'No image model is configured (config/genai.json).' });
  const level = req.body?.level === 'full' ? 'full' : 'essential';
  if (activeJob(w.id)) return void res.status(409).json({ error: 'Something is already being made for this daydream; wait for it to finish.' });
  if (req.body?.retryFailed) {
    for (const a of Object.values(w.assets)) if (a.status !== 'ok') delete w.assets[a.key];
    store.saveWorld(w);
  }
  if (!queueJob(res, 'art', w, u, { level })) return;
  res.json({ ok: true });
});

// ------------------------------------------------------------------------------ world studio

/** Queue a job on a world; answers 409 (and returns false) when one is already active there. */
function queueJob(res: Response, kind: JobKind, w: WorldDefinition, u: store.User, params: unknown, priority = 5): boolean {
  try {
    enqueue(kind, w.id, { id: u.id, name: u.username }, params, { priority, step: 'Waiting for a free worker' });
    return true;
  } catch (e) {
    if (!(e instanceof JobConflict)) throw e;
    res.status(409).json({ error: e.message });
    return false;
  }
}

/** The owner's world (or any world for an admin), loaded for the studio. */
function ownedWorld(req: Request, res: Response) {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'ready') return void res.status(404).json({ error: 'Daydream not found or still being dreamed.' });
  if (w.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Only the owner can open the studio.' });
  return w;
}

app.get('/api/worlds/:id/studio', auth, (req, res) => {
  const w = ownedWorld(req, res);
  if (w) res.json(studioView(w));
});

app.post('/api/worlds/:id/studio/edit', auth, (req, res) => {
  const w = ownedWorld(req, res);
  if (!w) return;
  if (activeJob(w.id)) return void res.status(409).json({ error: 'Something is being made for this daydream; wait for it to finish.' });
  const edits = z.array(EditSchema).max(50).safeParse(Array.isArray(req.body) ? req.body : [req.body]);
  if (!edits.success) return void res.status(400).json({ error: edits.error.issues[0]?.message ?? 'Invalid edit.' });
  for (const e of edits.data) {
    const err = applyEdit(w, e);
    if (err) return void res.status(400).json({ error: err });
  }
  store.saveWorld(w);
  res.json(studioView(w));
});

app.post('/api/worlds/:id/studio/task', auth, (req, res) => {
  const w = ownedWorld(req, res);
  if (!w) return;
  const task = TaskSchema.safeParse(req.body);
  if (!task.success) return void res.status(400).json({ error: task.error.issues[0]?.message ?? 'Invalid task.' });
  if (task.data.kind === 'animate') {
    // Animation runs in its own background job, beside whatever else is being made.
    if (!animationConfig()) return void res.status(400).json({ error: 'Animation is not configured (config/genai.json "animation").' });
    for (const k of task.data.keys) if (w.assets[k]) requestRedo(w.id, k, task.data.from);
    queueAnimation(w, { id: w.ownerId, name: w.ownerName });
    return void res.json(studioView(w));
  }
  if (activeJob(w.id)) return void res.status(409).json({ error: 'Something is already being made for this daydream.' });
  if (task.data.kind === 'paint' && genai().isProcedural('image.sprite')) return void res.status(400).json({ error: 'No image model is configured (config/genai.json).' });
  const u = (req as AuthedRequest).user;
  if (!queueJob(res, 'studio', w, u, { task: task.data }, 3)) return;
  res.json({ ok: true });
});

/** Everything character creation needs. */
app.get('/api/worlds/:id/setup', auth, (req, res) => {
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'ready') return void res.status(404).json({ error: 'This daydream is not ready yet.' });
  if (!w.ruleset) return void res.status(409).json({ error: 'This daydream was made before per-daydream rules. Regenerate its rules on its page first.' });
  res.json({
    id: w.id,
    concept: { title: w.concept.title, pitch: w.concept.pitch, tone: w.concept.tone, playerRole: w.concept.playerRole, palette: w.concept.palette, genre: w.concept.genre },
    ruleset: w.ruleset,
    combatMode: w.input.combatMode,
    difficulty: w.input.difficulty ?? 'normal',
    origins: w.origins,
    assets: Object.fromEntries(Object.values(w.assets).filter((a) => a.status === 'ok').map((a) => [a.key, a.file])),
  });
});

app.get('/api/worlds/:id/assets/:file', (req, res) => {
  const id = String(req.params.id);
  if (!/^[\w-]+$/.test(id)) return void res.status(400).end();
  sendAsset(res, store.worldAssetDir(id), String(req.params.file));
});

// ------------------------------------------------------------------------------ instances

const CharSpecSchema = z.object({
  name: z.string().trim().min(1).max(24),
  classId: z.string().max(60),
  kinId: z.string().max(60),
  presentation: z.enum(['feminine', 'masculine', 'androgynous']).default('androgynous'),
  pronouns: z.string().trim().min(1).max(24).default('they/them'),
  colors: z.array(z.string()).max(4).optional(),
});

app.get('/api/worlds/:id/instances', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  res.json(instances.list(String(req.params.id), u.id));
});

app.post('/api/worlds/:id/instances', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'ready') return void res.status(404).json({ error: 'This daydream is not ready yet.' });
  if (!w.ruleset) return void res.status(409).json({ error: 'Regenerate this daydream\'s rules first.' });
  const body = z.object({ name: z.string().max(60).default(''), party: z.array(CharSpecSchema).min(1).max(4), difficulty: z.enum(DIFFICULTIES as [string, ...string[]]).optional() }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid party.' });
  const inst = instances.create(w, u.id, u.username, body.data.name, body.data.party, body.data.difficulty as never);
  res.json({ instanceId: inst.state.id });
});

app.post('/api/instances/:id/join', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const inst = instances.get(String(req.params.id));
  if (!inst) return void res.status(404).json({ error: 'Save not found.' });
  if (inst.hasPlayer(u.id)) return void res.json({ ok: true });
  if (!inst.state.open && inst.state.ownerId !== u.id) return void res.status(403).json({ error: 'That reverie is not open to other dreamers.' });
  const body = z.object({ party: z.array(CharSpecSchema).min(1).max(4) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'Invalid party.' });
  instances.addPlayer(inst, u.id, u.username, body.data.party);
  res.json({ ok: true });
});

app.get('/api/instances/:id', auth, (req, res) => {
  const s = store.loadInstance(String(req.params.id));
  if (!s) return void res.status(404).json({ error: 'Not found.' });
  const u = (req as AuthedRequest).user;
  res.json({ ...instances.summary(s), hasCharacter: !!s.players[u.id] });
});

app.delete('/api/instances/:id', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const s = store.loadInstance(String(req.params.id));
  if (!s) return void res.status(404).json({ error: 'Not found.' });
  if (s.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Not your save.' });
  if (instances.isLive(s.id)) instances.drop(s.id);
  store.deleteInstance(s.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------------------ GenAI admin

app.get('/api/genai', auth, (req, res) => {
  const g = genai();
  res.json({ purposes: g.describe(), recent: g.recent.slice(-60).reverse(), gpu: g.gpu.status(), configFile: fs.existsSync(path.join(CONFIG_DIR, 'genai.json')) ? 'config/genai.json' : null });
});

app.post('/api/genai/release', auth, async (req, res) => {
  if (!(req as AuthedRequest).user.isAdmin) return void res.status(403).json({ error: 'Admins only.' });
  await genai().releaseGpu();
  res.json({ gpu: genai().gpu.status() });
});

app.post('/api/genai/reload', auth, (req, res) => {
  if (!(req as AuthedRequest).user.isAdmin) return void res.status(403).json({ error: 'Admins only.' });
  try {
    res.json({ purposes: reloadGenAI().describe() });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/genai/test', auth, async (req, res) => {
  if (!(req as AuthedRequest).user.isAdmin) return void res.status(403).json({ error: 'Admins only.' });
  const purpose = String(req.body?.purpose ?? '');
  const g = genai();
  const t0 = Date.now();
  try {
    if (g.isDecision(purpose as 'image.check')) {
      const answers = await g.decide(purpose as 'image.check', {
        state: 'A weary traveler stumbles into the inn, soaked and bleeding, and asks the innkeeper for help.',
        questions: {
          action: { type: 'choice', instructions: 'What does the kind innkeeper do?', criteria: { heal_player: 'Tend their wounds', ignore: 'Ignore them', attack: 'Attack them' } },
          concern: { type: 'score', instructions: 'How concerned is the innkeeper?', criteria: ['indifferent', 'mildly', 'very', 'alarmed'] },
        },
      });
      return void res.json({ ok: true, ms: Date.now() - t0, json: answers });
    }
    if (purpose === 'image.prompt') {
      const text = await g.text('image.prompt', { system: imagePromptSystem(), messages: [{ role: 'user', content: 'Brief: a game character sprite, full body. Subject: a lantern-bearing night watchman in a patched oilskin coat. Art style: painterly dark fantasy.' }], maxTokens: 400 });
      return void res.json({ ok: true, ms: Date.now() - t0, text });
    }
    if (purpose.startsWith('image.') && purpose !== 'image.check') {
      const painting = await g.image(purpose as 'image.sprite', { prompt: `A painterly game character: a friendly lantern-bearing traveler, full body, seen from the front. ${backdropSentence('green')}`, seed: 42, width: 832, height: 1216 });
      const buf = (await finishCutout(await cutout(painting), 512)).png;
      return void res.json({ ok: true, ms: Date.now() - t0, image: `data:image/png;base64,${buf.toString('base64')}` });
    }
    if (purpose === 'image.check' || purpose === 'npc.dialogue' || purpose === 'narration') {
      const text = await g.text(purpose === 'image.check' ? 'narration' : (purpose as 'narration'), { messages: [{ role: 'user', content: 'Say hello as a gruff innkeeper in one sentence.' }], maxTokens: 120 });
      return void res.json({ ok: true, ms: Date.now() - t0, text });
    }
    const out = await g.structured(purpose as 'npc.decision', { prompt: 'Invent a tavern. Return JSON.', schema: z.object({ name: z.string(), mood: z.string(), patrons: z.array(z.string()).max(3) }), name: 'tavern', maxTokens: 400 });
    res.json({ ok: true, ms: Date.now() - t0, json: out });
  } catch (e) {
    res.status(500).json({ ok: false, ms: Date.now() - t0, error: (e as Error).message });
  }
});

// ------------------------------------------------------------------------------ static client

// In development the live client is Vite's (its API calls come here); a built client in dist/ would be stale.
const devClient = process.env.GD_DEV_CLIENT;
if (devClient) app.get(/^\/(?!api|ws).*/, (req, res) => res.redirect(devClient + req.originalUrl));
else if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html'), { dotfiles: 'allow' }));
}

// ------------------------------------------------------------------------------ websocket

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket, req) => {
  const user = store.sessionUser(cookie(req, 'gd_session'));
  const url = new URL(req.url ?? '', 'http://x');
  const instanceId = url.searchParams.get('instance') ?? '';
  const send = (m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  if (!user || user.mustChangePassword) {
    send({ t: 'error', message: user ? 'Choose a new password first.' : 'Please sign in.' });
    return ws.close();
  }
  const inst = instances.get(instanceId);
  if (!inst) {
    const st = store.loadInstance(instanceId);
    const why = st ? incompatibility(st, store.loadWorld(st.worldId)) : null;
    send({ t: 'error', message: why ?? 'Save not found.' });
    return ws.close();
  }
  const conn = { userId: user.id, send };
  inst.join(conn);
  let reload = false;
  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t === 'ping') return send({ t: 'pong', serverTime: Date.now(), clientTime: msg.clientTime });
    if (msg.t === 'dev') {
      if (!user.isAdmin) return;
      // Reload: the client reconnects by itself and gets a fresh copy of the daydream from disk.
      if (msg.action === 'reload') {
        reload = true;
        return ws.close();
      }
    }
    inst.handle(user.id, msg);
  });
  ws.on('close', () => {
    inst.leave(conn);
    if (reload) instances.reload(instanceId);
  });
});

server.listen(PORT, () => {
  const g = genai();
  console.log(`Generative Daydream server on http://localhost:${PORT}`);
  // Jobs run here unless a separate worker process runs them (GD_WORKER=external, as `npm run dev` does).
  if (process.env.GD_WORKER !== 'external') {
    startWorker();
    console.log('Job worker: in this process');
  } else console.log('Job worker: separate process (npm run worker)');
  installSpendLedger();
  const first = store.ensureAdmin();
  if (first) console.log(`
No accounts yet: created administrator "admin" with one-time password ${first}
(change it on first sign-in; reset it any time with: npm run users -w @gd/server -- reset admin)
`);
  console.log('GenAI purposes:');
  for (const p of g.describe()) console.log(`  ${p.purpose.padEnd(14)} → ${p.provider} (${p.type}${p.model ? `, ${p.model}` : ''})`);
});

const shutdown = () => {
  instances.saveAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
