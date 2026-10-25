import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Broker } from '../src/scheduler';
import { ComfyAdapter } from '../src/adapters/comfyui';
import { HoldAdapter } from '../src/adapters/hold';
import { createFront } from '../src/http';
import { fakeComfy } from './fakecomfy';

const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

describe('GPU broker front (ComfyUI pass-through)', () => {
  const comfy = fakeComfy();
  let front: http.Server;
  let base = '';
  let broker: Broker;
  beforeAll(async () => {
    const comfyUrl = await listen(comfy.server);
    const adapter = new ComfyAdapter({ url: comfyUrl, pollMs: 10 });
    broker = new Broker({ comfyui: adapter, hold: new HoldAdapter(30_000, 10) }, { graceMs: 0, log: () => {} });
    front = createFront(broker, adapter, { clients: { prod: 'secret-prod' } });
    base = await listen(front);
  });
  afterAll(() => {
    broker.stop();
    front.close();
    comfy.server.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('holds a prompt while the GPU is busy, then runs it in ComfyUI under the same id', async () => {
    const hold = (await (await post('/broker/holds', { model: 'skintokens', rank: 1 })).json()) as { id: string };
    await sleep(30);
    expect(broker.get(hold.id)!.state).toBe('running');

    const id = uuid();
    const queued = await post('/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } }, prompt_id: id, extra_data: { gd: { workflow: 'krea', rank: 2 } } }, { authorization: 'Bearer secret-prod' });
    expect(((await queued.json()) as { prompt_id: string }).prompt_id).toBe(id);
    const waiting = await fetch(`${base}/history/${id}`);
    expect(await waiting.json()).toEqual({});
    expect(waiting.headers.get('x-broker-state')).toBe('queued; position=1');
    const q = (await (await fetch(`${base}/queue`)).json()) as { queue_pending: unknown[][] };
    expect(q.queue_pending.map((p) => p[1])).toEqual([id]);
    expect(broker.get(id)!.client).toBe('prod');
    expect(comfy.queued.some((p) => p.id === id)).toBe(false);

    await fetch(`${base}/broker/holds/${hold.id}`, { method: 'DELETE' });
    let entry: Record<string, { outputs: Record<string, { images: { filename: string }[] }> }> = {};
    for (let i = 0; i < 100 && !entry[id]; i++) {
      await sleep(10);
      entry = (await (await fetch(`${base}/history/${id}`)).json()) as typeof entry;
    }
    expect(entry[id]!.outputs['9']!.images[0]!.filename).toBe('out.png');
    expect(comfy.queued.find((p) => p.id === id)).toBeTruthy();
    expect(Buffer.from(await (await fetch(`${base}/view?filename=out.png&type=output`)).arrayBuffer()).toString()).toBe('PNGDATA');
  });

  it('cancels a held prompt and reports it the way ComfyUI reports an error', async () => {
    const hold = (await (await post('/broker/holds', {})).json()) as { id: string };
    await sleep(30);
    const id = uuid();
    await post('/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } }, prompt_id: id });
    await post('/queue', { delete: [id] });
    const h = (await (await fetch(`${base}/history/${id}`)).json()) as Record<string, { status: { status_str: string; messages: [string, { exception_message: string }][] } }>;
    expect(h[id]!.status.status_str).toBe('error');
    expect(h[id]!.status.messages[0]![1].exception_message).toBe('cancelled');
    await fetch(`${base}/broker/holds/${hold.id}`, { method: 'DELETE' });
  });

  it('refuses requests from web pages, even from this PC', async () => {
    const res = await post('/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } } }, { origin: 'https://example.com' });
    expect(res.status).toBe(403);
    expect((await fetch(`${base}/broker/queue`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  });

  it("ignores callers' /free, refuses unknown tokens, and answers 404 for prompts it never saw", async () => {
    const frees = comfy.calls.filter((c) => c === 'POST /free').length;
    expect((await post('/free', { unload_models: true })).status).toBe(200);
    expect(comfy.calls.filter((c) => c === 'POST /free').length).toBe(frees);
    expect((await fetch(`${base}/queue`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/history/${uuid()}`)).status).toBe(404);
  });
});
