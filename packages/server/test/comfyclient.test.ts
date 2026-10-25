import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Broker } from '../../gpu-broker/src/scheduler';
import { ComfyAdapter } from '../../gpu-broker/src/adapters/comfyui';
import { HoldAdapter } from '../../gpu-broker/src/adapters/hold';
import { createFront } from '../../gpu-broker/src/http';
import { fakeComfy } from '../../gpu-broker/test/fakecomfy';
import { savedImages, submitAndWait, waitReason, type ComfyTarget } from '../src/genai/comfyclient';
import { withCallContext } from '../src/genai/context';

const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ComfyUI client behind the GPU broker', () => {
  const comfy = fakeComfy();
  let front: http.Server;
  let broker: Broker;
  let target: ComfyTarget;
  beforeAll(async () => {
    const adapter = new ComfyAdapter({ url: await listen(comfy.server), pollMs: 10 });
    broker = new Broker({ comfyui: adapter, hold: new HoldAdapter(30_000, 10) }, { graceMs: 0, log: () => {} });
    front = createFront(broker, adapter, { clients: { prod: 'tok' } });
    target = { base: await listen(front), headers: { authorization: 'Bearer tok' }, broker: true };
  });
  afterAll(() => {
    broker.stop();
    front.close();
    comfy.server.close();
  });

  it('does not count time waiting for its turn, and tells the job why it waits', async () => {
    const hold = broker.submit('hold', { seen: Date.now() as number, released: false }, { client: 'dev', rank: 0 });
    await sleep(30);
    const waits: (string | null)[] = [];
    const done = withCallContext({ priority: 'background', onWait: (w) => waits.push(w) }, () => submitAndWait({ '1': { class_type: 'X', inputs: {} } }, { workflow: 'krea', timeoutMs: 150, pollMs: 20, target }));
    await sleep(400);
    (hold.work as { released: boolean }).released = true;
    const entry = await done;
    expect(savedImages(entry).map((i) => i.filename)).toEqual(['out.png']);
    expect(waits[0]).toBe('Waiting for the GPU (next)');
    expect(waits.at(-1)).toBeNull();
    const sent = comfy.queued.at(-1)!;
    expect((sent.extra as { gd: { workflow: string; rank: number } }).gd).toMatchObject({ workflow: 'krea', rank: 2 });
  });

  it('describes queue positions and a program that does not answer', () => {
    expect(waitReason('running')).toBeNull();
    expect(waitReason('queued; position=3')).toBe('Waiting for the GPU (2 ahead)');
    expect(waitReason('queued; position=1; waiting=comfyui not answering')).toBe('Waiting for the GPU: comfyui not answering');
  });
});
