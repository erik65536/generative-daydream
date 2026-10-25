/**
 * The broker's one queue for the GPU: every client's work (production, development, CLI runs), one piece at a
 * time across all GPU programs. Rank first (0: a player waits), then work for the model already loaded, with a
 * short grace after each piece for the same caller's next one (callers submit, wait, submit again), and a limit
 * on how long one caller keeps the GPU while another of the same rank waits. Before work for another program, or
 * for another model of a program that cannot hold two, the loaded one is unloaded. See docs/gpu-broker.md.
 */
import crypto from 'node:crypto';

/** One GPU program behind the broker. */
export interface GpuAdapter<W = any> {
  readonly name: string;
  /** Changing models inside this program needs an unload first (ComfyUI: they do not fit together). */
  readonly freeBetweenModels?: boolean;
  /** Answering at all. Work for a program that does not answer waits; other programs' work goes ahead. */
  alive(): Promise<boolean>;
  /** Do the work. `signal` aborts it (cancelled). Throw AdapterDown when the program stopped answering. */
  run(work: W, ctx: RunContext): Promise<unknown>;
  /** Give back every byte of GPU memory this program holds. */
  unload(): Promise<void>;
}

export interface RunContext {
  id: string;
  signal: AbortSignal;
  progress(p: number, step?: string): void;
}

/** The program stopped answering: its work goes back in the queue and waits for it. */
export class AdapterDown extends Error {}

export type ItemState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Item<W = any> {
  id: string;
  /** ComfyUI-style queue number, in order of submission. */
  number: number;
  adapter: string;
  /** Work for the same adapter and model runs back to back without unloading. */
  model: string;
  /** Lower runs first: 0 a player waits, 1 studio, 2 world builds, 3 background animation. */
  rank: number;
  client: string;
  /** The caller's own description (the game's prompt tag: process, job, world). */
  tag?: Record<string, unknown>;
  work: W;
  state: ItemState;
  submittedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  result?: unknown;
  progress?: { p: number; step?: string };
  controller: AbortController;
}

export interface BrokerOptions {
  /** How long one caller's run of work may keep the GPU while another caller of the same rank waits. */
  holdMs?: number;
  /** After a piece of work, how long to wait for the same caller's next piece before switching models. */
  graceMs?: number;
  /** How often a program that did not answer is asked again. */
  retryDownMs?: number;
  /** Finished items are kept this long (callers read their outcome). */
  keepMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export class Broker {
  private items = new Map<string, Item>();
  private number = 0;
  /** What is loaded on the GPU (null: nothing); `known` false until the first unload of everything. */
  private resident: { adapter: string; model: string } | null = null;
  private known = false;
  private holder: { client: string; since: number } | null = null;
  private last: { client: string; rank: number; at: number } | null = null;
  private down = new Map<string, number>();
  private running: Item | null = null;
  private wake: (() => void) | null = null;
  private pumping = false;
  private stopped = false;
  private readonly o: Required<Omit<BrokerOptions, 'log'>> & { log: (m: string) => void };

  constructor(readonly adapters: Record<string, GpuAdapter>, opts: BrokerOptions = {}) {
    this.o = { holdMs: 180_000, graceMs: 1500, retryDownMs: 3000, keepMs: 3600_000, now: Date.now, log: (m) => console.log(`[broker] ${m}`), ...opts };
  }

  /** Queue a piece of work; `id` may be the caller's own (a UUID). */
  submit<W>(adapter: string, work: W, info: { client: string; rank?: number; model?: string; tag?: Record<string, unknown> }, id?: string): Item<W> {
    const a = this.adapters[adapter];
    if (!a) throw new Error(`no adapter "${adapter}"`);
    if (id && this.items.has(id)) throw new Error(`id ${id} is already in use`);
    const item: Item<W> = {
      id: id ?? crypto.randomUUID(),
      number: ++this.number,
      adapter,
      model: info.model ?? adapter,
      rank: Number.isFinite(info.rank) ? Number(info.rank) : 2,
      client: info.client,
      tag: info.tag,
      work,
      state: 'queued',
      submittedAt: this.o.now(),
      controller: new AbortController(),
    };
    this.items.set(item.id, item);
    this.poke();
    return item;
  }

  get(id: string): Item | undefined {
    return this.items.get(id);
  }

  /** Remove queued work, or abort running work. False when there is nothing to stop. */
  cancel(id: string): boolean {
    const it = this.items.get(id);
    if (!it) return false;
    if (it.state === 'queued') {
      this.finish(it, 'cancelled');
      this.poke();
      return true;
    }
    if (it.state === 'running') {
      it.controller.abort();
      return true;
    }
    return false;
  }

  /** Queued work in the order it would run (approximately: the next pick also looks at what is loaded). */
  queued(): Item[] {
    return [...this.items.values()].filter((i) => i.state === 'queued').sort((a, b) => a.rank - b.rank || a.submittedAt - b.submittedAt);
  }

  /** 1-based place among queued work (0: not queued). */
  position(id: string): number {
    return this.queued().findIndex((i) => i.id === id) + 1;
  }

  isDown(adapter: string): boolean {
    return this.down.has(adapter);
  }

  snapshot() {
    const view = (i: Item) => ({ id: i.id, adapter: i.adapter, model: i.model, rank: i.rank, client: i.client, tag: i.tag, state: i.state, submittedAt: i.submittedAt, startedAt: i.startedAt, progress: i.progress });
    return {
      resident: this.resident,
      running: this.running ? view(this.running) : null,
      queued: this.queued().map(view),
      down: [...this.down.keys()],
      holder: this.holder,
    };
  }

  stop() {
    this.stopped = true;
    this.poke();
  }

  // ------------------------------------------------------------------------------------------------ the loop

  private poke() {
    const w = this.wake;
    this.wake = null;
    w?.();
    if (!this.pumping) void this.pump();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.stopped) {
        this.prune();
        const now = this.o.now();
        const next = this.pick(now);
        if (!next) {
          if (!this.queued().length) break;
          await this.sleep(this.down.size ? this.o.retryDownMs : 1000);
          await this.recheckDown();
          continue;
        }
        if ('wait' in next) {
          await this.sleep(Math.max(10, next.wait - now));
          continue;
        }
        await this.runItem(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** The next piece of work, a time to wait until (the grace after a caller's last piece), or nothing to do. */
  pick(now: number): Item | { wait: number } | null {
    const q = this.queued().filter((i) => !this.down.has(i.adapter));
    if (!q.length) return null;
    const top = q.filter((i) => i.rank === q[0]!.rank);
    const r = this.resident;
    const loaded = (i: Item) => !!r && i.adapter === r.adapter && i.model === r.model;
    const h = this.holder;
    const othersWait = !!h && top.some((i) => i.client !== h.client);
    const expired = othersWait && now - h!.since >= this.o.holdMs;
    const pick = expired ? top.find((i) => i.client !== h!.client)! : (top.find(loaded) ?? top[0]!);
    // Switching models: first give the caller that just ran a moment to send its next piece for this model.
    const l = this.last;
    if (!expired && r && !loaded(pick) && l && l.client !== pick.client && now - l.at < this.o.graceMs && pick.rank >= l.rank) return { wait: l.at + this.o.graceMs };
    return pick;
  }

  private async runItem(it: Item) {
    const a = this.adapters[it.adapter]!;
    it.state = 'running';
    it.startedAt = this.o.now();
    this.running = it;
    if (!this.holder || this.holder.client !== it.client) this.holder = { client: it.client, since: it.startedAt };
    try {
      await this.makeRoom(it);
      this.resident = { adapter: it.adapter, model: it.model };
      it.result = await a.run(it.work, { id: it.id, signal: it.controller.signal, progress: (p, step) => (it.progress = { p, step }) });
      this.finish(it, 'done');
    } catch (e) {
      if (it.controller.signal.aborted) this.finish(it, 'cancelled', 'cancelled');
      else if (e instanceof AdapterDown) {
        // The program is gone (restarted, crashed, the PC is off): the work waits for it, and what is loaded is unknown.
        this.markDown(it.adapter, (e as Error).message);
        this.known = false;
        this.resident = null;
        it.state = 'queued';
        it.startedAt = undefined;
      } else this.finish(it, 'failed', (e as Error).message);
    } finally {
      this.running = null;
      this.last = { client: it.client, rank: it.rank, at: this.o.now() };
    }
  }

  /** Unload what is in the way of this item's model. */
  private async makeRoom(it: Item) {
    if (!this.known) {
      // Taking the GPU from an unknown state (just started, or a program came back): clear out every program.
      for (const [name, a] of Object.entries(this.adapters)) {
        if (this.down.has(name) && name !== it.adapter) continue;
        await a.unload().catch((e) => {
          if (name === it.adapter) throw e;
        });
      }
      this.known = true;
      this.resident = null;
      return;
    }
    const r = this.resident;
    if (!r || (r.adapter === it.adapter && r.model === it.model)) return;
    if (r.adapter !== it.adapter || this.adapters[it.adapter]!.freeBetweenModels) {
      this.o.log(`${r.adapter}:${r.model} → ${it.adapter}:${it.model}`);
      try {
        await this.adapters[r.adapter]!.unload();
      } catch (e) {
        if (!(e instanceof AdapterDown)) throw e;
        // The other program is gone, and with it what it held.
        this.markDown(r.adapter, (e as Error).message);
      }
      this.resident = null;
    }
  }

  private finish(it: Item, state: ItemState, error?: string) {
    it.state = state;
    it.finishedAt = this.o.now();
    if (error) it.error = error;
    if (state === 'failed') this.o.log(`${it.adapter}:${it.model} for ${it.client} failed: ${error}`);
  }

  private markDown(adapter: string, why: string) {
    if (!this.down.has(adapter)) this.o.log(`${adapter} is not answering (${why}); its work waits`);
    this.down.set(adapter, this.o.now());
  }

  private async recheckDown() {
    for (const name of [...this.down.keys()]) {
      if (await this.adapters[name]!.alive().catch(() => false)) {
        this.down.delete(name);
        this.o.log(`${name} is answering again`);
      }
    }
  }

  private prune() {
    const old = this.o.now() - this.o.keepMs;
    for (const [id, it] of this.items) if (it.finishedAt && it.finishedAt < old) this.items.delete(id);
  }
}
