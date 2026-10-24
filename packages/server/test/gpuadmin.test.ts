/**
 * The admin GPU page's API: administrators only, one view of the job queue, every process's GPU work and
 * ComfyUI's queue, and controls that act through those layers. ComfyUI is a fake server here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// A data folder of its own: the pause switches are shared by every process using a database, and other test
// files run workers and GPU calls in theirs at the same time.
await vi.hoisted(async () => {
  const fs = await import('node:fs');
  process.env.GD_DATA_DIR = `${process.env.GD_DATA_DIR}/gpuadmin`;
  fs.rmSync(process.env.GD_DATA_DIR, { recursive: true, force: true });
  process.env.GD_NO_NVIDIA_SMI = '1';
});

import type { WorldDefinition } from '@gd/shared';
import { changePassword, createSession, inviteUser, saveWorld, worldDir } from '../src/storage';
import { mountGpuAdmin } from '../src/gpu/admin';
import { control, flush, pausedFor, promptBody, setProcessRole } from '../src/gpu/presence';
import { claimNext, enqueue, enqueueAnimation, getJobRecord, queuedJobs, type JobRecord } from '../src/jobs/queue';
import { GpuScheduler } from '../src/genai/gpu';
import { GpuQueue } from '../src/worldgen/gpu';
import { withCallContext } from '../src/genai/context';
import { genai } from '../src/genai/service';
import { DATA_DIR } from '../src/paths';
import type { ProviderConfig } from '../src/genai/types';

/** A ComfyUI that answers the calls the admin page makes and records the rest. */
function fakeComfy() {
  const calls: { path: string; body: unknown }[] = [];
  const tagged = (n: number, id: string, extra: unknown, unet = 'krea2_turbo_fp8_scaled.safetensors') => [n, id, { '1': { class_type: 'UNETLoader', inputs: { unet_name: unet } } }, extra, []];
  const state = {
    running: [tagged(1, 'p_cli', { client_id: 'generative-daydream' })] as unknown[],
    pending: [tagged(2, 'p_job', { client_id: 'gd-worker', gd: { holder: 'h:1:aa', role: 'worker', label: 'job worker', jobId: 'j_x', worldId: 'w_x', kind: 'art', workflow: 'krea' } }), tagged(3, 'p_anim', { client_id: 'gd-animator' }, 'pixal3d.safetensors')] as unknown[],
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = (req.url ?? '').split('?')[0]!;
      calls.push({ path: url, body });
      const json = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (url === '/queue' && req.method === 'GET') return json({ queue_running: state.running, queue_pending: state.pending });
      if (url === '/queue') {
        const del = (body?.delete ?? []) as string[];
        state.pending = state.pending.filter((p) => !del.includes((p as unknown[])[1] as string));
        return json({});
      }
      if (url === '/interrupt') {
        state.running = state.running.filter((p) => (p as unknown[])[1] !== body?.prompt_id);
        return json({});
      }
      if (url === '/history') {
        const now = Date.now();
        return json({
          h_ok: { prompt: tagged(0, 'h_ok', {}), outputs: { '9': { images: [{}, {}] } }, status: { status_str: 'success', completed: true, messages: [['execution_start', { timestamp: now - 5000 }], ['execution_success', { timestamp: now - 1000 }]] } },
          h_bad: { prompt: tagged(0, 'h_bad', { client_id: 'gd-animator' }), outputs: {}, status: { status_str: 'error', messages: [['execution_error', { timestamp: now - 2000, exception_message: 'CUDA out of memory' }]] } },
        });
      }
      if (url === '/system_stats') return json({ devices: [{ name: 'Fake GPU', vram_total: 24 * 2 ** 30, vram_free: 8 * 2 ** 30 }] });
      if (url === '/free') return json({});
      res.writeHead(404).end();
    });
  });
  return { server, calls, state };
}

const comfy = fakeComfy();
let base = '';

function user(isAdmin: boolean) {
  const name = `g_${crypto.randomBytes(4).toString('hex')}`;
  const { user, password } = inviteUser(name, isAdmin);
  changePassword(user.id, password, 'a-chosen-password');
  return { user, cookie: `gd_session=${createSession(user.id)}` };
}

let admin: ReturnType<typeof user>, player: ReturnType<typeof user>;

async function call(method: string, p: string, who?: { cookie: string }, body?: unknown) {
  const res = await fetch(`${base}/api/admin/gpu${p}`, { method, headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const wid = () => `w_ga_${crypto.randomBytes(4).toString('hex')}`;
const owner = { id: 'u_ga', name: 'Gpu Admin Test' };

describe('admin GPU page', () => {
  let app: http.Server;
  beforeAll(async () => {
    expect(DATA_DIR).toMatch(/gpuadmin$/);
    await new Promise<void>((r) => comfy.server.listen(0, '127.0.0.1', r));
    process.env.COMFY_URL = `http://127.0.0.1:${(comfy.server.address() as AddressInfo).port}`;
    const e = express();
    e.use(express.json());
    mountGpuAdmin(e);
    app = http.createServer(e);
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    admin = user(true);
    player = user(false);
  });
  afterAll(() => {
    app?.close();
    comfy.server.close();
    delete process.env.COMFY_URL;
  });

  it('is for administrators only, on every route', async () => {
    const routes: [string, string, unknown?][] = [
      ['GET', '/'],
      ['POST', '/pause', { scope: 'all', on: true }],
      ['POST', '/jobs/j_none/priority', { move: 'up' }],
      ['POST', '/jobs/j_none/cancel', { confirm: true }],
      ['POST', '/comfy/p_cli/clear', { confirm: true }],
      ['POST', '/unload', { confirm: true }],
      ['POST', '/actors/retry', { worldId: 'w', key: 'k' }],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} signed out`).toBe(401);
      expect((await call(m, p, player, b)).status, `${m} ${p} as a player`).toBe(403);
    }
    // Nothing a refused request asked for happened.
    expect(control('paused')).toBeNull();
    expect(comfy.state.running).toHaveLength(1);
    expect(comfy.calls.some((c) => c.path === '/free' || c.path === '/interrupt')).toBe(false);
  });

  it('shows the queue, ComfyUI prompts by origin, the GPU memory and throughput', async () => {
    const a = enqueue('art', wid(), owner, {}, { priority: 5 });
    const b = enqueue('studio', wid(), owner, {}, { priority: 3 });
    setProcessRole('server', 'test server');
    flush();
    const { status, body } = await call('GET', '/', admin);
    expect(status).toBe(200);
    expect(body.jobs.queued.map((j: { id: string }) => j.id).slice(0, 2)).toEqual([b.id, a.id]);
    expect(body.jobs.queued[0]).toMatchObject({ kind: 'studio', owner: owner.name, priority: 3, position: 0 });
    expect(body.comfy.up).toBe(true);
    expect(body.comfy.running[0]).toMatchObject({ id: 'p_cli', origin: { kind: 'untagged' }, workflow: 'krea2_turbo' });
    expect(body.comfy.pending.map((p: { origin: { kind: string } }) => p.origin.kind)).toEqual(['worker', 'animator']);
    expect(body.comfy.pending[0].origin).toMatchObject({ jobId: 'j_x', worldId: 'w_x', jobKind: 'art' });
    expect(body.comfy.failures[0]).toMatchObject({ id: 'h_bad', message: 'CUDA out of memory', origin: { kind: 'animator' } });
    expect(body.device).toMatchObject({ name: 'Fake GPU', vramTotalMb: 24576, vramUsedMb: 16384, source: 'comfyui' });
    expect(body.throughput).toMatchObject({ comfyPromptsLastHour: 1, imagesLastHour: 2 });
    expect(body.processes.find((p: { isThis: boolean }) => p.isThis)).toMatchObject({ role: 'server', label: 'test server' });
    for (const j of [a, b]) await call('POST', `/jobs/${j.id}/cancel`, admin, { confirm: true });
  });

  it('reorders queued jobs: a new priority, or one place up or down', async () => {
    const [x, y, z] = [enqueue('art', wid(), owner, {}, { priority: 5 }), enqueue('art', wid(), owner, {}, { priority: 5 }), enqueue('art', wid(), owner, {}, { priority: 6 })];
    const order = () => queuedJobs().map((j) => j.id).filter((id) => [x.id, y.id, z.id].includes(id));
    expect(order()).toEqual([x.id, y.id, z.id]);
    expect((await call('POST', `/jobs/${z.id}/priority`, admin, { move: 'up' })).status).toBe(200);
    expect(order()).toEqual([x.id, z.id, y.id]);
    expect((await call('POST', `/jobs/${x.id}/priority`, admin, { move: 'down' })).status).toBe(200);
    expect(order()).toEqual([z.id, x.id, y.id]);
    expect((await call('POST', `/jobs/${y.id}/priority`, admin, { priority: 1 })).status).toBe(200);
    expect(order()).toEqual([y.id, z.id, x.id]);
    expect(getJobRecord(y.id)!.priority).toBe(1);
    expect((await call('POST', `/jobs/${y.id}/priority`, admin, { priority: 1, move: 'up' })).status).toBe(400);
    expect((await call('POST', `/jobs/j_missing/priority`, admin, { priority: 1 })).status).toBe(404);
    for (const j of [x, y, z]) await call('POST', `/jobs/${j.id}/cancel`, admin, { confirm: true });
    // Ended jobs cannot be reordered or cancelled again.
    expect((await call('POST', `/jobs/${x.id}/priority`, admin, { priority: 2 })).status).toBe(409);
    expect((await call('POST', `/jobs/${x.id}/cancel`, admin, { confirm: true })).status).toBe(409);
  });

  it('cancels a queued job and stops a running one, clearing its ComfyUI prompts; asks for confirmation first', async () => {
    const q = enqueue('art', wid(), owner, {}, { priority: 0 });
    expect((await call('POST', `/jobs/${q.id}/cancel`, admin, {})).status).toBe(400);
    expect(getJobRecord(q.id)!.status).toBe('queued');
    expect((await call('POST', `/jobs/${q.id}/cancel`, admin, { confirm: true })).body).toMatchObject({ ok: true, stopped: false });
    expect(getJobRecord(q.id)!.status).toBe('cancelled');

    // A running job (claimed by a "worker"), with a prompt of its own pending on ComfyUI.
    const r = enqueue('art', wid(), owner, {}, { priority: 0 });
    expect(claimNext('worker-test')?.id).toBe(r.id);
    comfy.state.pending.push([9, 'p_mine', {}, { gd: { holder: 'worker-test', role: 'worker', label: 'job worker', jobId: r.id } }, []]);
    const out = await call('POST', `/jobs/${r.id}/cancel`, admin, { confirm: true });
    expect(out.body).toMatchObject({ ok: true, stopped: true, promptsCleared: 1 });
    expect(getJobRecord(r.id)!.cancelRequested).toBe(true);
    expect(comfy.state.pending.some((p) => (p as unknown[])[1] === 'p_mine')).toBe(false);
    // Other prompts (the CLI run's, the other job's) are untouched.
    expect(comfy.state.running).toHaveLength(1);
    expect(comfy.state.pending).toHaveLength(2);
  });

  it('pauses new GPU work and background animation separately', async () => {
    const anim = wid();
    enqueueAnimation(anim, owner);
    expect((await call('POST', '/pause', admin, { scope: 'animation', on: true })).body).toMatchObject({ paused: null, animationPaused: { by: admin.user.username } });
    expect(pausedFor(2, 'animate')).toMatch(/Animation paused/);
    expect(pausedFor(2, 'art')).toBeNull();
    // A worker claims nothing of the paused kind.
    expect(claimNext('worker-test', { noAnimation: true })).toBeUndefined();
    const claimed = claimNext('worker-test') as JobRecord;
    expect(claimed.kind).toBe('animate');

    expect((await call('POST', '/pause', admin, { scope: 'all', on: true })).status).toBe(200);
    expect(pausedFor(2)).toMatch(/Paused/);
    // Players' own calls (rank 0) are never paused.
    expect(pausedFor(0)).toBeNull();
    await call('POST', '/pause', admin, { scope: 'all', on: false });
    await call('POST', '/pause', admin, { scope: 'animation', on: false });
    expect(control('paused')).toBeNull();
    expect(control('animationPaused')).toBeNull();
    expect((await call('POST', '/pause', admin, { scope: 'everything', on: true })).status).toBe(400);
  });

  it("holds GPU calls while paused, lets players' calls past, and a stopped job gives up its turn", async () => {
    const cfg = { type: 'openai-chat', gpu: 'g' } as ProviderConfig;
    const g = new GpuScheduler(() => 0).group(`pause_${Date.now()}`);
    await call('POST', '/pause', admin, { scope: 'all', on: true });
    const order: string[] = [];
    const waits: (string | null)[] = [];
    const build = withCallContext({ priority: 'background', tag: { jobId: 'j_b', worldId: 'w_b', kind: 'art' } }, () => g.run('p', 'm', cfg, async () => void order.push('build'), 2, (w) => waits.push(w)));
    await new Promise((r) => setTimeout(r, 700));
    expect(order).toEqual([]);
    expect(waits).toEqual(['Paused by an administrator']);
    // A player's call (rank 0) goes past the paused build call.
    await g.run('p', 'm', cfg, async () => void order.push('player'), 0);
    expect(order).toEqual(['player']);
    await call('POST', '/pause', admin, { scope: 'all', on: false });
    await build;
    expect(order).toEqual(['player', 'build']);
    expect(waits).toEqual(['Paused by an administrator', null]);

    // Background animation alone: other work goes on.
    await call('POST', '/pause', admin, { scope: 'animation', on: true });
    const anim = withCallContext({ priority: 'background', tag: { kind: 'animate' } }, () => g.run('p', 'm', cfg, async () => void order.push('animate'), 4));
    await withCallContext({ priority: 'background', tag: { kind: 'art' } }, () => g.run('p', 'm', cfg, async () => void order.push('art'), 2));
    expect(order.slice(2)).toEqual(['art']);
    await call('POST', '/pause', admin, { scope: 'animation', on: false });
    await anim;
    expect(order.slice(2)).toEqual(['art', 'animate']);

    let stop = false;
    await call('POST', '/pause', admin, { scope: 'all', on: true });
    const stopped = withCallContext({ priority: 'background', cancelled: () => stop }, () => g.run('p', 'm', cfg, async () => 'ran', 2));
    stop = true;
    await expect(stopped).rejects.toThrow('cancelled');
    await call('POST', '/pause', admin, { scope: 'all', on: false });
  });

  it('reports each process\'s GPU work: its scheduler calls and a build\'s GPU queue', async () => {
    const cfg = { type: 'openai-chat', gpu: 'g' } as ProviderConfig;
    const g = new GpuScheduler(() => 0).group(`report_${Date.now()}`);
    const q = new GpuQueue(() => false, { jobId: 'j_rep', worldId: 'w_rep', kind: 'world' });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = q.run('krea', 1, () => withCallContext({ priority: 'background', tag: { jobId: 'j_rep', kind: 'world' } }, () => g.run('comfy', 'krea2', cfg, () => hold, 2)));
    const second = q.run('reader', 2, async () => undefined);
    await new Promise((r) => setTimeout(r, 100));
    flush();
    const { body } = await call('GET', '/', admin);
    const me = body.processes.find((p: { isThis: boolean }) => p.isThis);
    expect(me.state.builds.find((b: { tag?: { jobId?: string } }) => b.tag?.jobId === 'j_rep')).toMatchObject({ tag: { jobId: 'j_rep' }, running: { model: 'krea', priority: 1 }, pending: [{ model: 'reader', priority: 2 }] });
    expect(me.state.calls.find((c: { group: string }) => c.group === g.name)).toMatchObject({ model: 'krea2', running: true, tag: { jobId: 'j_rep' } });
    const grp = body.groups.find((x: { group: string }) => x.group === g.name);
    expect(grp.running[0]).toMatchObject({ model: 'krea2', tag: { jobId: 'j_rep' } });
    expect(grp.holder.label).toMatch(/this process/);
    release();
    await Promise.all([first, second]);
  });

  it('tags ComfyUI prompts with the process and the job they are for', () => {
    setProcessRole('cli', 'genlive w_test');
    const body = JSON.parse(withCallContext({ priority: 'background', tag: { jobId: 'j_t', worldId: 'w_t', kind: 'art' } }, () => promptBody({}, 'krea')));
    expect(body.client_id).toBe('gd-cli');
    expect(body.extra_data.gd).toMatchObject({ role: 'cli', label: 'genlive w_test', jobId: 'j_t', worldId: 'w_t', kind: 'art', workflow: 'krea' });
    setProcessRole('server', 'test server');
  });

  it('clears a stuck ComfyUI prompt of any origin, and unloads the models, with confirmation', async () => {
    expect((await call('POST', '/comfy/p_cli/clear', admin, {})).status).toBe(400);
    expect(comfy.state.running).toHaveLength(1);
    expect((await call('POST', '/comfy/p_cli/clear', admin, { confirm: true })).body).toMatchObject({ outcome: 'interrupted' });
    expect(comfy.calls.find((c) => c.path === '/interrupt')?.body).toEqual({ prompt_id: 'p_cli' });
    expect((await call('POST', '/comfy/p_anim/clear', admin, { confirm: true })).body).toMatchObject({ outcome: 'removed' });
    expect((await call('POST', '/comfy/p_anim/clear', admin, { confirm: true })).status).toBe(404);

    expect((await call('POST', '/unload', admin, {})).status).toBe(400);
    const cfg = genai().config;
    const saved = cfg.providers;
    cfg.providers = { ...saved, comfy: { type: 'comfyui', baseUrl: process.env.COMFY_URL, gpu: 'local' } as ProviderConfig };
    try {
      expect((await call('POST', '/unload', admin, { confirm: true })).body).toMatchObject({ ok: true, groups: ['local'] });
      expect(comfy.calls.find((c) => c.path === '/free')?.body).toEqual({ unload_models: true, free_memory: true });
    } finally {
      cfg.providers = saved;
    }
  });

  it('retries a failed animation actor', async () => {
    const cfg = genai().config;
    cfg.animation = { python: 'python' } as typeof cfg.animation;
    try {
      const id = wid();
      const w = {
        id, ownerId: owner.id, ownerName: owner.name, status: 'ready', createdAt: Date.now(), input: {}, concept: { title: 'Retry test' },
        zones: [], npcs: [], families: [], bosses: [], origins: [], quests: [], startZoneId: 'z',
        assets: { spr_npc_a: { key: 'spr_npc_a', kind: 'sprite', status: 'ok', file: 'a.png' } },
      } as unknown as WorldDefinition;
      saveWorld(w);
      fs.mkdirSync(path.join(worldDir(id), 'anim', 'spr_npc_a'), { recursive: true });
      const failFile = path.join(worldDir(id), 'anim', 'spr_npc_a', 'failed.json');
      fs.writeFileSync(failFile, JSON.stringify({ file: 'a.png', error: 'rig failed' }));
      const view = (await call('GET', '/?fresh=1', admin)).body;
      expect(view.animation.find((a: { worldId: string }) => a.worldId === id)).toMatchObject({ title: 'Retry test', failed: [{ key: 'spr_npc_a', error: 'rig failed' }] });

      expect((await call('POST', '/actors/retry', admin, { worldId: id, key: 'spr_npc_a' })).status).toBe(200);
      expect(fs.existsSync(failFile)).toBe(false);
      expect(queuedJobs().some((j) => j.worldId === id && j.kind === 'animate')).toBe(true);
      expect((await call('POST', '/actors/retry', admin, { worldId: id, key: 'spr_npc_a' })).status).toBe(409);
      expect((await call('POST', '/actors/retry', admin, { worldId: 'w_nope', key: 'spr_npc_a' })).status).toBe(404);
    } finally {
      delete cfg.animation;
    }
  });

  it('logs what each administrator did', async () => {
    const { body } = await call('GET', '/', admin);
    const actions = body.audit.map((a: { action: string }) => a.action);
    for (const a of ['pause', 'resume', 'cancel', 'stop', 'move up', 'set priority', 'interrupt prompt', 'remove prompt', 'unload models', 'retry animation']) expect(actions).toContain(a);
    expect(body.audit.every((a: { adminName: string }) => a.adminName === admin.user.username)).toBe(true);
  });
});
