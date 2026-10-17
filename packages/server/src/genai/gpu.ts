/**
 * Exclusive GPU scheduling for local model servers that cannot hold several models at once.
 * All calls to providers in the same `gpu` group are serialized; when the next call needs a different
 * model, the resident one is unloaded first (llama.cpp router `/models/unload`, ComfyUI `/free`).
 * Models load on demand when the server receives a request for them.
 */
import type { ProviderConfig } from './types';

interface Resident {
  provider: string;
  model: string;
  cfg: ProviderConfig;
}

const root = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, '');

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

class GpuGroup {
  readonly members = new Map<string, ProviderConfig>();
  resident: Resident | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  readonly switches: { at: number; from?: string; to: string }[] = [];
  constructor(public readonly name: string, private idleMs: () => number) {}

  run<T>(provider: string, model: string, cfg: ProviderConfig, fn: () => Promise<T>): Promise<T> {
    this.members.set(provider, cfg);
    const job = this.chain.then(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
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
      try {
        return await fn();
      } finally {
        this.scheduleIdle();
      }
    });
    this.chain = job.catch(() => undefined);
    return job;
  }

  private scheduleIdle() {
    const ms = this.idleMs();
    if (!ms) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.release(), ms);
  }

  /** Unload whatever is resident (after a batch of work, or when idle). */
  release(): Promise<void> {
    const job = this.chain.then(async () => {
      if (!this.resident) return;
      console.log(`[gpu:${this.name}] unloading ${this.resident.model}`);
      await unloadModel(this.resident.cfg, this.resident.model);
      this.resident = null;
    });
    this.chain = job.catch(() => undefined);
    return job;
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
