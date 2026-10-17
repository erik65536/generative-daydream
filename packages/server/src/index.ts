/** HTTP + WebSocket server entry point. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { COMBAT_MODES, GAME_LENGTHS, ORIGINS, SKILLS, WORLD_SIZES, type ClientMessage, type ServerMessage, type WorldDefinition } from '@gd/shared';
import { CLIENT_DIST, CONFIG_DIR } from './paths';
import * as store from './storage';
import { genai, reloadGenAI } from './genai/service';
import { getJob, startArtJob, startWorldGeneration } from './worldgen/pipeline';
import { instances } from './game/manager';

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

function auth(req: Request, res: Response, next: NextFunction) {
  const user = store.sessionUser(cookie(req, 'gd_session'));
  if (!user) return void res.status(401).json({ error: 'Please sign in.' });
  (req as AuthedRequest).user = user;
  next();
}

const setSession = (res: Response, token: string) =>
  res.setHeader('Set-Cookie', `gd_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);

const Credentials = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) });

app.post('/api/auth/register', (req, res) => {
  const body = Credentials.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'Username and password are required.' });
  try {
    const u = store.createUser(body.data.username, body.data.password);
    setSession(res, store.createSession(u.id));
    res.json({ id: u.id, username: u.username, isAdmin: u.isAdmin });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const body = Credentials.safeParse(req.body);
  const u = body.success ? store.verifyUser(body.data.username, body.data.password) : null;
  if (!u) return void res.status(401).json({ error: 'Wrong username or password.' });
  setSession(res, store.createSession(u.id));
  res.json({ id: u.id, username: u.username, isAdmin: u.isAdmin });
});

app.post('/api/auth/logout', (req, res) => {
  const t = cookie(req, 'gd_session');
  if (t) store.deleteSession(t);
  res.setHeader('Set-Cookie', 'gd_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  res.json({ id: u.id, username: u.username, isAdmin: u.isAdmin });
});

// ------------------------------------------------------------------------------ worlds

function worldSummary(w: WorldDefinition) {
  const job = getJob(w.id);
  return {
    id: w.id,
    title: w.concept.title,
    pitch: w.concept.pitch,
    genre: w.concept.genre,
    ownerId: w.ownerId,
    ownerName: w.ownerName,
    public: w.public,
    status: job && job.status === 'running' ? 'generating' : w.status,
    createdAt: w.createdAt,
    input: { size: w.input.size, length: w.input.length, combatMode: w.input.combatMode, communication: w.input.communication, art: w.input.art },
    zones: w.zones.filter((z) => z.kind !== 'interior').length,
    npcs: w.npcs.length,
    quests: w.quests.length,
    palette: w.concept.palette,
    cover: Object.values(w.assets).find((a) => a.status === 'ok' && a.kind === 'sprite')?.file,
    artProgress: { ok: Object.values(w.assets).filter((a) => a.status === 'ok').length, total: Object.keys(w.assets).length },
    job: job ? { status: job.status, progress: job.progress, step: job.step } : undefined,
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
});

app.post('/api/worlds', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const body = WorldInputSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input.' });
  const job = startWorldGeneration(body.data, { id: u.id, name: u.username });
  res.json({ worldId: job.worldId });
});

app.get('/api/worlds/:id', auth, (req, res) => {
  const w = store.loadWorld(String(req.params.id));
  if (!w) return void res.status(404).json({ error: 'World not found.' });
  res.json(worldSummary(w));
});

app.get('/api/worlds/:id/job', auth, (req, res) => {
  const id = String(req.params.id);
  const job = getJob(id);
  const w = store.loadWorld(id);
  if (!job) return void res.json({ status: w?.status === 'ready' ? 'done' : w?.status ?? 'unknown', progress: w?.status === 'ready' ? 1 : 0, step: '', log: (w?.generationLog ?? []).map((msg) => ({ t: 0, msg, kind: 'info' })), preview: {} });
  const since = Number(req.query.since ?? 0);
  res.json({ status: job.status, progress: job.progress, step: job.step, error: job.error, log: job.log.filter((l) => l.t > since), preview: job.preview });
});

app.post('/api/worlds/:id/cancel', auth, (req, res) => {
  const job = getJob(String(req.params.id));
  const u = (req as AuthedRequest).user;
  if (job && (job.owner.id === u.id || u.isAdmin)) job.cancelled = true;
  res.json({ ok: true });
});

app.delete('/api/worlds/:id', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w) return void res.status(404).json({ error: 'Not found.' });
  if (w.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Not your world.' });
  store.deleteWorld(w.id);
  res.json({ ok: true });
});

app.post('/api/worlds/:id/art', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'ready') return void res.status(404).json({ error: 'Not found.' });
  if (w.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Not your world.' });
  if (genai().isProcedural('image.texture') && genai().isProcedural('image.sprite')) return void res.status(400).json({ error: 'No image model is configured (config/genai.json).' });
  const level = req.body?.level === 'full' ? 'full' : 'essential';
  if (req.body?.retryFailed) for (const a of Object.values(w.assets)) if (a.status !== 'ok') delete w.assets[a.key];
  startArtJob(w, level, { id: u.id, name: u.username });
  res.json({ ok: true });
});

/** Everything character creation needs. */
app.get('/api/worlds/:id/setup', auth, (req, res) => {
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'ready') return void res.status(404).json({ error: 'World not ready.' });
  res.json({
    id: w.id,
    concept: { title: w.concept.title, pitch: w.concept.pitch, tone: w.concept.tone, playerRole: w.concept.playerRole, palette: w.concept.palette, genre: w.concept.genre },
    terminology: w.terminology,
    combatMode: w.input.combatMode,
    origins: w.origins.map((o) => ({ ...o, template: ORIGINS.find((t) => t.id === o.id) })),
    skills: Object.entries(w.skills).map(([id, f]) => ({ id, ...f, school: SKILLS[id]?.school, minLevel: SKILLS[id]?.minLevel, passive: !!SKILLS[id]?.passive, summary: SKILLS[id]?.summary })),
    assets: Object.fromEntries(Object.values(w.assets).filter((a) => a.status === 'ok').map((a) => [a.key, a.file])),
  });
});

app.get('/api/worlds/:id/assets/:file', (req, res) => {
  const id = String(req.params.id);
  const file = String(req.params.file);
  if (!/^[\w-]+$/.test(id) || !/^[\w.-]+\.png$/.test(file)) return void res.status(400).end();
  const p = path.join(store.worldAssetDir(id), file);
  if (!fs.existsSync(p)) return void res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(p);
});

// ------------------------------------------------------------------------------ instances

const CharSpecSchema = z.object({
  name: z.string().trim().min(1).max(24),
  originId: z.string(),
  attributes: z.record(z.string(), z.number()).optional(),
  skills: z.array(z.string()).max(4).optional(),
  colors: z.array(z.string()).max(4).optional(),
});

app.get('/api/worlds/:id/instances', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  res.json(instances.list(String(req.params.id), u.id));
});

app.post('/api/worlds/:id/instances', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'ready') return void res.status(404).json({ error: 'World not ready.' });
  const body = z.object({ name: z.string().max(60).default(''), party: z.array(CharSpecSchema).min(1).max(4) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid party.' });
  const inst = instances.create(w, u.id, u.username, body.data.name, body.data.party);
  res.json({ instanceId: inst.state.id });
});

app.post('/api/instances/:id/join', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const inst = instances.get(String(req.params.id));
  if (!inst) return void res.status(404).json({ error: 'Save not found.' });
  if (inst.hasPlayer(u.id)) return void res.json({ ok: true });
  if (!inst.state.open && inst.state.ownerId !== u.id) return void res.status(403).json({ error: 'That world is not open to other players.' });
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
  res.json({ purposes: g.describe(), recent: g.recent.slice(-60).reverse(), configFile: fs.existsSync(path.join(CONFIG_DIR, 'genai.json')) ? 'config/genai.json' : null });
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
    if (purpose.startsWith('image.') && purpose !== 'image.check') {
      const buf = await g.image(purpose as 'image.sprite', { prompt: 'a friendly lantern-bearing traveler, full body, plain gray background', seed: 42, width: 512, height: 768 });
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

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
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
  if (!user) {
    send({ t: 'error', message: 'Please sign in.' });
    return ws.close();
  }
  const inst = instances.get(instanceId);
  if (!inst) {
    send({ t: 'error', message: 'Save not found.' });
    return ws.close();
  }
  const conn = { userId: user.id, send };
  inst.join(conn);
  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t === 'ping') return send({ t: 'pong', serverTime: Date.now(), clientTime: msg.clientTime });
    inst.handle(user.id, msg);
  });
  ws.on('close', () => inst.leave(conn));
});

server.listen(PORT, () => {
  const g = genai();
  console.log(`Generative Daydream server on http://localhost:${PORT}`);
  console.log('GenAI purposes:');
  for (const p of g.describe()) console.log(`  ${p.purpose.padEnd(14)} → ${p.provider} (${p.type}${p.model ? `, ${p.model}` : ''})`);
});

const shutdown = () => {
  instances.saveAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
