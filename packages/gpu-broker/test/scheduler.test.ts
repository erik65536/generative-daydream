import { describe, expect, it } from 'vitest';
import { AdapterDown, Broker, type GpuAdapter } from '../src/scheduler';

interface W {
  name: string;
  /** Resolves when the test lets this piece finish. */
  gate?: Promise<void>;
  down?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake GPU program that records what ran and what was unloaded, in one shared log. */
function fake(name: string, log: string[], opts: { freeBetweenModels?: boolean; alive?: () => boolean } = {}): GpuAdapter<W> {
  return {
    name,
    freeBetweenModels: opts.freeBetweenModels,
    alive: async () => opts.alive?.() ?? true,
    unload: async () => void log.push(`unload ${name}`),
    run: async (w, ctx) => {
      if (w.down) {
        w.down = false;
        throw new AdapterDown('gone');
      }
      log.push(`run ${w.name}`);
      await Promise.race([w.gate ?? Promise.resolve(), new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))))]);
      return w.name;
    },
  };
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

const settle = async (b: Broker, ...ids: string[]) => {
  for (let i = 0; i < 200 && ids.some((id) => ['queued', 'running'].includes(b.get(id)!.state)); i++) await sleep(5);
};

const runs = (log: string[]) => log.filter((l) => l.startsWith('run ')).map((l) => l.slice(4));

describe('GPU broker scheduler', () => {
  it('runs the most urgent work first, and unloads everything before its first piece', async () => {
    const log: string[] = [];
    const b = new Broker({ comfy: fake('comfy', log), other: fake('other', log) }, { graceMs: 0, log: () => {} });
    const g = gate();
    const a = b.submit('comfy', { name: 'build-1', gate: g.p }, { client: 'prod', rank: 2, model: 'krea' });
    await sleep(10);
    const c = b.submit('comfy', { name: 'build-2' }, { client: 'prod', rank: 2, model: 'krea' });
    const d = b.submit('comfy', { name: 'player' }, { client: 'dev', rank: 0, model: 'krea' });
    g.open();
    await settle(b, a.id, c.id, d.id);
    expect(log.slice(0, 2).sort()).toEqual(['unload comfy', 'unload other']);
    expect(runs(log)).toEqual(['build-1', 'player', 'build-2']);
  });

  it('prefers work for the loaded model, and unloads when switching program or model', async () => {
    const log: string[] = [];
    const b = new Broker({ comfy: fake('comfy', log, { freeBetweenModels: true }), st: fake('st', log) }, { graceMs: 0, log: () => {} });
    const g = gate();
    const first = b.submit('comfy', { name: 'krea-1', gate: g.p }, { client: 'prod', model: 'krea' });
    await sleep(10);
    const sam = b.submit('comfy', { name: 'sam' }, { client: 'dev', model: 'sam3' });
    const krea = b.submit('comfy', { name: 'krea-2' }, { client: 'dev', model: 'krea' });
    const st = b.submit('st', { name: 'skintokens' }, { client: 'dev', model: 'skintokens' });
    g.open();
    await settle(b, first.id, sam.id, krea.id, st.id);
    expect(runs(log)).toEqual(['krea-1', 'krea-2', 'sam', 'skintokens']);
    const after = log.slice(log.indexOf('run krea-2'));
    expect(after).toEqual(['run krea-2', 'unload comfy', 'run sam', 'unload comfy', 'run skintokens']);
  });

  it("waits a moment for the same caller's next piece before switching models", async () => {
    const log: string[] = [];
    const b = new Broker({ comfy: fake('comfy', log) }, { graceMs: 150, log: () => {} });
    const a = b.submit('comfy', { name: 'prod-krea-1' }, { client: 'prod', model: 'krea' });
    await settle(b, a.id);
    const other = b.submit('comfy', { name: 'dev-sam' }, { client: 'dev', model: 'sam3' });
    await sleep(40);
    const next = b.submit('comfy', { name: 'prod-krea-2' }, { client: 'prod', model: 'krea' });
    await settle(b, other.id, next.id);
    expect(runs(log)).toEqual(['prod-krea-1', 'prod-krea-2', 'dev-sam']);
  });

  it('passes the GPU to another caller after the hold limit', async () => {
    const log: string[] = [];
    const b = new Broker({ comfy: fake('comfy', log) }, { graceMs: 0, holdMs: 0, log: () => {} });
    const g = gate();
    const ids = [b.submit('comfy', { name: 'p1', gate: g.p }, { client: 'prod', model: 'krea' }).id];
    await sleep(10);
    ids.push(b.submit('comfy', { name: 'p2' }, { client: 'prod', model: 'krea' }).id);
    ids.push(b.submit('comfy', { name: 'd1' }, { client: 'dev', model: 'krea' }).id);
    g.open();
    await settle(b, ...ids);
    expect(runs(log)).toEqual(['p1', 'd1', 'p2']);
  });

  it('cancels queued and running work', async () => {
    const log: string[] = [];
    const b = new Broker({ comfy: fake('comfy', log) }, { graceMs: 0, log: () => {} });
    const running = b.submit('comfy', { name: 'long', gate: new Promise(() => {}) }, { client: 'prod' });
    const queued = b.submit('comfy', { name: 'never' }, { client: 'prod' });
    await sleep(10);
    expect(b.cancel(queued.id)).toBe(true);
    expect(b.cancel(running.id)).toBe(true);
    await settle(b, running.id, queued.id);
    expect(running.state).toBe('cancelled');
    expect(queued.state).toBe('cancelled');
    expect(runs(log)).toEqual(['long']);
  });

  it('keeps work waiting while its program does not answer, and runs it when it comes back', async () => {
    const log: string[] = [];
    let up = false;
    const b = new Broker({ comfy: fake('comfy', log, { alive: () => up }) }, { graceMs: 0, retryDownMs: 20, log: () => {} });
    const it = b.submit('comfy', { name: 'paint', down: true }, { client: 'prod' });
    await sleep(60);
    expect(it.state).toBe('queued');
    expect(b.isDown('comfy')).toBe(true);
    up = true;
    await settle(b, it.id);
    expect(it.state).toBe('done');
    expect(it.result).toBe('paint');
  });
});
