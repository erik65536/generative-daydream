/**
 * Exclusive GPU scheduling for local model servers that cannot hold several models at once.
 *
 * Within a process, calls to providers in the same `gpu` group run one at a time, most urgent first (a player
 * waiting on an NPC before a world build). Across processes (the web server and job workers), a lease in the
 * shared database decides who uses the GPU; a process keeps it while it has work, so batches stay on one
 * model, but hands it over between calls when a more urgent caller is waiting, or after a while to anyone.
 * When the next call needs a different model, the resident one is unloaded first (llama.cpp router
 * `/models/unload`, ComfyUI `/free`). Models load on demand when the server receives a request for them.
 */
import { globalDb, tx } from '../storage';
import { HOLDER } from '../jobs/queue';
import type { ProviderConfig } from './types';

interface Resident {
  provider: string;
  model: string;
  cfg: ProviderConfig;
}

const root = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function unloadModel(cfg: ProviderConfig, model: string): Promise<void> {
  try {
    if (cfg.type === 'comfyui') {
      await fetch(`${root(cfg.baseUrl ?? 'http://127.0.0.1:8188')}/free`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(30_000),
      });
    } else if (cfg.baseUrl) {
      // llama.cpp router mode
      await fetch(`${root(cfg.baseUrl)}/models/unload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(30_000),
      });
    }
  } catch (e) {
    console.warn(`[gpu] unload of ${model} failed: ${(e as Error).message}`);
  }
}

/**
 * Make sure nothing but `keep` occupies the servers of a GPU group, including models another process (or a
 * crashed run) left loaded: ComfyUI is told to free its models, and every loaded llama.cpp router model is unloaded.
 */
async function evictOthers(members: Map<string, ProviderConfig>, keepProvider: string, keepModel: string): Promise<void> {
  const seen = new Set<string>();
  for (const [name, cfg] of members) {
    const base = root(cfg.baseUrl ?? (cfg.type === 'comfyui' ? 'http://127.0.0.1:8188' : ''));
    if (!base || seen.has(`${cfg.type === 'comfyui' ? 'c' : 'l'}:${base}`)) continue;
    seen.add(`${cfg.type === 'comfyui' ? 'c' : 'l'}:${base}`);
    if (cfg.type === 'comfyui') {
      if (name !== keepProvider && members.get(keepProvider)?.type !== 'comfyui') await unloadModel(cfg, 'comfyui');
      continue;
    }
    try {
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5_000) });
      const data = (await res.json()) as { data?: { id: string; status?: { value?: string } }[] };
      for (const m of data.data ?? []) if (m.status?.value && m.status.value !== 'unloaded' && m.id !== keepModel) await unloadModel(cfg, m.id);
    } catch {
      // Not a router (or unreachable): nothing to evict.
    }
  }
}

// ------------------------------------------------------------------------------------ cross-process lease

const LEASE_MS = 45_000;
/** Holding the GPU longer than this while someone else waits (at any priority) hands it over. */
const MAX_HOLD_MS = 90_000;
/** A waiter that stopped polling (its process died) no longer counts. */
const WAITER_STALE_MS = 5_000;

const db = globalDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS gpu_lease (grp TEXT PRIMARY KEY, holder TEXT NOT NULL, model TEXT NOT NULL, until INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS gpu_wait (grp TEXT NOT NULL, holder TEXT NOT NULL, rank INTEGER NOT NULL, since INTEGER NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY (grp, holder));
`);
const q = {
  lease: db.prepare('SELECT holder, model, until FROM gpu_lease WHERE grp = ?'),
  take: db.prepare('INSERT INTO gpu_lease (grp, holder, model, until) VALUES (?, ?, ?, ?) ON CONFLICT(grp) DO UPDATE SET holder = excluded.holder, model = excluded.model, until = excluded.until'),
  renew: db.prepare('UPDATE gpu_lease SET until = ? WHERE grp = ? AND holder = ?'),
  free: db.prepare('UPDATE gpu_lease SET until = 0 WHERE grp = ? AND holder = ?'),
  wait: db.prepare('INSERT INTO gpu_wait (grp, holder, rank, since, seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(grp, holder) DO UPDATE SET rank = excluded.rank, seen = excluded.seen'),
  unwait: db.prepare('DELETE FROM gpu_wait WHERE grp = ? AND holder = ?'),
  better: db.prepare('SELECT COUNT(*) AS n FROM gpu_wait WHERE grp = ? AND holder != ? AND seen > ? AND (rank < ? OR (rank = ? AND since < ?))'),
  others: db.prepare('SELECT MIN(rank) AS r FROM gpu_wait WHERE grp = ? AND holder != ? AND seen > ?'),
};

interface Item {
  rank: number;
  seq: number;
  run: () => Promise<void>;
}

/** Groups this process holds, freed if it exits (so others need not wait for the lease to run out). */
const held = new Set<string>();
process.on('exit', () => {
  for (const g of held) q.free.run(g, HOLDER);
});

class GpuGroup {
  readonly members = new Map<string, ProviderConfig>();
  resident: Resident | null = null;
  private queue: Item[] = [];
  private seq = 0;
  private pumping = false;
  private heldSince = 0;
  private waitingSince = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  readonly switches: { at: number; from?: string; to: string }[] = [];
  constructor(public readonly name: string, private idleMs: () => number) {}

  /** Run a call on the GPU: rank 0 is most urgent. `onWait` hears when the GPU is busy elsewhere. */
  run<T>(provider: string, model: string, cfg: ProviderConfig, fn: () => Promise<T>, rank = 2, onWait?: (why: string | null) => void): Promise<T> {
    this.members.set(provider, cfg);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        rank,
        seq: this.seq++,
        run: async () => {
          if (this.idleTimer) clearTimeout(this.idleTimer);
          await this.acquire(rank, onWait);
          if (this.resident && (this.resident.model !== model || this.resident.provider !== provider)) {
            console.log(`[gpu:${this.name}] ${this.resident.model} → ${model}`);
            await unloadModel(this.resident.cfg, this.resident.model);
            this.switches.push({ at: Date.now(), from: this.resident.model, to: model });
            this.resident = null;
          }
          if (!this.resident) {
            // Taking the GPU from an unknown state: clear out anything else first.
            await evictOthers(this.members, provider, model);
            this.resident = { provider, model, cfg };
          }
          q.take.run(this.name, HOLDER, model, Date.now() + LEASE_MS);
          const renew = setInterval(() => q.renew.run(Date.now() + LEASE_MS, this.name, HOLDER), LEASE_MS / 3);
          let result: { ok: true; v: T } | { ok: false; e: unknown };
          try {
            result = { ok: true, v: await fn() };
          } catch (e) {
            result = { ok: false, e };
          } finally {
            clearInterval(renew);
            this.scheduleIdle();
          }
          // Settle the lease before the caller continues (it may be about to exit).
          this.handOver();
          if (result.ok) resolve(result.v);
          else reject(result.e);
        },
      });
      void this.pump();
    });
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
        const item = this.queue.shift()!;
        await item.run().catch(() => undefined);
        this.handOver();
      }
    } finally {
      this.pumping = false;
      this.handOver();
    }
  }

  /** Wait until this process may use the GPU. */
  private async acquire(rank: number, onWait?: (why: string | null) => void) {
    let told = false;
    for (;;) {
      const now = Date.now();
      const got = tx(() => {
        const l = q.lease.get(this.name) as { holder: string; model: string; until: number } | undefined;
        const mine = !!l && l.holder === HOLDER && l.until >= now;
        const free = !l || l.until < now;
        const ahead = (q.better.get(this.name, HOLDER, now - WAITER_STALE_MS, rank, rank, this.waitingSince || now) as { n: number }).n;
        if (mine || (free && !ahead)) {
          // Another process used the GPU since: what we thought was resident may be gone or replaced.
          if (!mine && l && l.holder !== HOLDER) this.resident = null;
          q.take.run(this.name, HOLDER, this.resident?.model ?? l?.model ?? '', now + LEASE_MS);
          q.unwait.run(this.name, HOLDER);
          return true;
        }
        q.wait.run(this.name, HOLDER, rank, this.waitingSince || now, now);
        return false;
      });
      if (got) {
        held.add(this.name);
        if (!this.heldSince) this.heldSince = Date.now();
        this.waitingSince = 0;
        if (told) onWait?.(null);
        return;
      }
      if (!this.waitingSince) this.waitingSince = now;
      if (!told && now - this.waitingSince > 5_000) {
        told = true;
        onWait?.('Waiting for the GPU (another part of the server is using it)');
      }
      await sleep(250);
    }
  }

  /** Between calls: keep the GPU for our next call, or give it to someone waiting. */
  private handOver() {
    const now = Date.now();
    const next = this.queue.length ? Math.min(...this.queue.map((i) => i.rank)) : Infinity;
    const other = (q.others.get(this.name, HOLDER, now - WAITER_STALE_MS) as { r: number | null }).r;
    const someoneElse = other !== null && other !== undefined;
    const keep = next !== Infinity && (!someoneElse || (other! >= next && now - this.heldSince < MAX_HOLD_MS));
    if (keep) return;
    q.free.run(this.name, HOLDER);
    held.delete(this.name);
    this.heldSince = 0;
  }

  private scheduleIdle() {
    const ms = this.idleMs();
    if (!ms) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.release(), ms);
  }

  /** Unload what this process loaded (after a batch of work, or when idle), unless someone else has the GPU now. */
  release(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({
        rank: 9,
        seq: this.seq++,
        run: async () => {
          const l = q.lease.get(this.name) as { holder: string; model: string; until: number } | undefined;
          const ours = !l || l.holder === HOLDER || l.until < Date.now();
          if (this.resident && ours && (!l || l.holder === HOLDER || l.model === this.resident.model)) {
            console.log(`[gpu:${this.name}] unloading ${this.resident.model}`);
            await unloadModel(this.resident.cfg, this.resident.model);
          }
          this.resident = null;
          resolve();
        },
      });
      void this.pump();
    });
  }
}

export class GpuScheduler {
  private groups = new Map<string, GpuGroup>();
  constructor(private idleMs: () => number) {}
  group(name: string): GpuGroup {
    let g = this.groups.get(name);
    if (!g) this.groups.set(name, (g = new GpuGroup(name, this.idleMs)));
    return g;
  }
  async releaseAll() {
    await Promise.all([...this.groups.values()].map((g) => g.release()));
  }
  status() {
    return [...this.groups.values()].map((g) => ({ group: g.name, resident: g.resident?.model ?? null, switches: g.switches.length }));
  }
}
