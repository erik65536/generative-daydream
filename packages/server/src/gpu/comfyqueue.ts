/**
 * ComfyUI's own queue, as the admin GPU page shows and controls it: what is running and pending (from any process,
 * the server's or a CLI run's, labelled by the tag in each prompt's extra_data), what finished lately, the GPU's
 * memory, and removing or interrupting a prompt.
 */
import { execFile } from 'node:child_process';
import type { PromptTag } from './presence';

export interface PromptOrigin {
  /** server / worker / cli: a tagged prompt from that kind of process; animator: the animator's Python steps;
   *  untagged: a Generative Daydream process on older code (most likely a CLI run); external: something else. */
  kind: 'server' | 'worker' | 'cli' | 'animator' | 'untagged' | 'external';
  label: string;
  holder?: string;
  jobId?: string;
  worldId?: string;
  jobKind?: string;
}

export interface ComfyPrompt {
  id: string;
  number: number;
  origin: PromptOrigin;
  /** The models it loads (from its loader nodes), or its workflow name when tagged. */
  workflow: string;
}

export interface ComfyQueue {
  up: boolean;
  error?: string;
  running: ComfyPrompt[];
  pending: ComfyPrompt[];
}

type QueueItem = [number, string, Record<string, { class_type?: string; inputs?: Record<string, unknown> }>, { client_id?: string; gd?: PromptTag }?, ...unknown[]];

const MODEL_INPUTS = ['unet_name', 'ckpt_name', 'model_name', 'checkpoint', 'model', 'dit_name', 'sam_model', 'vae_name'];

/** The model files a workflow loads, shortened (krea2_turbo_fp8_scaled.safetensors → krea2_turbo). */
export function workflowModels(prompt: QueueItem[2] | undefined): string {
  const names = new Set<string>();
  for (const node of Object.values(prompt ?? {})) {
    for (const k of MODEL_INPUTS) {
      const v = node?.inputs?.[k];
      if (typeof v === 'string' && /\.(safetensors|ckpt|pt|pth|gguf|bin)$/i.test(v)) names.add(v.replace(/\.[a-z]+$/i, '').replace(/_(fp8|fp16|bf16|int8).*$/i, ''));
    }
  }
  if (names.size) return [...names].slice(0, 3).join(', ');
  const types = [...new Set(Object.values(prompt ?? {}).map((n) => n?.class_type).filter(Boolean))];
  return types.slice(0, 2).join(', ') || 'workflow';
}

export function originOf(extra: QueueItem[3]): PromptOrigin {
  const t = extra?.gd;
  if (t?.holder) return { kind: t.role, label: t.label, holder: t.holder, jobId: t.jobId, worldId: t.worldId, jobKind: t.kind };
  const c = extra?.client_id ?? '';
  if (c === 'gd-animator') return { kind: 'animator', label: 'animator step' };
  if (c === 'generative-daydream') return { kind: 'untagged', label: 'untagged — a process on older code, most likely a CLI run' };
  return { kind: 'external', label: c ? `client ${c}` : 'queued outside Generative Daydream' };
}

const toPrompt = (it: QueueItem): ComfyPrompt => {
  const origin = originOf(it[3]);
  return { id: it[1], number: it[0], origin, workflow: it[3]?.gd?.workflow ?? workflowModels(it[2]) };
};

export async function readQueue(base: string): Promise<ComfyQueue> {
  try {
    const res = await fetch(`${base}/queue`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { up: false, error: `HTTP ${res.status}`, running: [], pending: [] };
    const data = (await res.json()) as { queue_running?: QueueItem[]; queue_pending?: QueueItem[] };
    return {
      up: true,
      running: (data.queue_running ?? []).map(toPrompt),
      pending: (data.queue_pending ?? []).map(toPrompt).sort((a, b) => a.number - b.number),
    };
  } catch (e) {
    return { up: false, error: (e as Error).message, running: [], pending: [] };
  }
}

export interface ComfyHistory {
  /** Prompts finished in the last hour. */
  lastHour: number;
  /** Images saved by those prompts. */
  imagesLastHour: number;
  failures: { id: string; at: number; message: string; origin: PromptOrigin; workflow: string }[];
}

let historyCache: { base: string; t: number; v: ComfyHistory } | null = null;

/** Recent history (cached for 20 s: entries carry whole workflows, so it is not fetched on every poll). */
export async function readHistory(base: string): Promise<ComfyHistory | null> {
  if (historyCache && historyCache.base === base && Date.now() - historyCache.t < 20_000) return historyCache.v;
  try {
    const res = await fetch(`${base}/history?max_items=64`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { prompt?: QueueItem; outputs?: Record<string, { images?: unknown[] }>; status?: { status_str?: string; messages?: [string, { timestamp?: number; exception_message?: string }][] } }>;
    const hourAgo = Date.now() - 3600_000;
    const v: ComfyHistory = { lastHour: 0, imagesLastHour: 0, failures: [] };
    for (const [id, e] of Object.entries(data)) {
      const msgs = e.status?.messages ?? [];
      const at = Math.max(0, ...msgs.map((m) => m[1]?.timestamp ?? 0));
      if (e.status?.status_str === 'error') {
        const err = msgs.find((m) => m[0] === 'execution_error' || m[0] === 'execution_interrupted');
        v.failures.push({ id, at, message: err?.[0] === 'execution_interrupted' ? 'interrupted' : String(err?.[1]?.exception_message ?? 'execution error').slice(0, 300), origin: originOf(e.prompt?.[3]), workflow: e.prompt?.[3]?.gd?.workflow ?? workflowModels(e.prompt?.[2]) });
      } else if (at >= hourAgo) {
        v.lastHour++;
        for (const o of Object.values(e.outputs ?? {})) v.imagesLastHour += o.images?.length ?? 0;
      }
    }
    v.failures.sort((a, b) => b.at - a.at).splice(10);
    historyCache = { base, t: Date.now(), v };
    return v;
  } catch {
    return null;
  }
}

/** Take a prompt off ComfyUI: removed while pending, interrupted while running (only if it is still the one running). */
export async function dropPrompt(base: string, id: string): Promise<'removed' | 'interrupted' | 'gone'> {
  const q = await readQueue(base);
  if (!q.up) throw new Error(`ComfyUI is not answering (${q.error})`);
  const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (q.pending.some((p) => p.id === id)) {
    await post('/queue', { delete: [id] });
    return 'removed';
  }
  if (q.running.some((p) => p.id === id)) {
    // Newer ComfyUI interrupts only this prompt; older ones whatever runs, which was just checked to be it.
    await post('/interrupt', { prompt_id: id });
    return 'interrupted';
  }
  return 'gone';
}

/** Every prompt queued for a job: removed or interrupted. */
export async function dropJobPrompts(base: string, jobId: string): Promise<number> {
  const q = await readQueue(base);
  let n = 0;
  for (const p of [...q.pending, ...q.running]) if (p.origin.jobId === jobId && (await dropPrompt(base, p.id).catch(() => 'gone')) !== 'gone') n++;
  return n;
}

export interface Device {
  name: string;
  vramUsedMb: number;
  vramTotalMb: number;
  utilization?: number;
  source: 'nvidia-smi' | 'comfyui';
}

let deviceCache: { t: number; v: Device | null } | null = null;

function nvidiaSmi(): Promise<Device | null> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 2500, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const [name, used, total, util] = String(out).split('\n')[0]!.split(',').map((s) => s.trim());
      if (!name || !Number(total)) return resolve(null);
      resolve({ name, vramUsedMb: Number(used), vramTotalMb: Number(total), utilization: Number(util), source: 'nvidia-smi' });
    });
  });
}

async function comfyDevice(base: string): Promise<Device | null> {
  try {
    const s = (await (await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(3000) })).json()) as { devices?: { name: string; vram_total: number; vram_free: number }[] };
    const d = s.devices?.[0];
    return d ? { name: d.name, vramUsedMb: Math.round((d.vram_total - d.vram_free) / 2 ** 20), vramTotalMb: Math.round(d.vram_total / 2 ** 20), source: 'comfyui' } : null;
  } catch {
    return null;
  }
}

/** The GPU's memory in use (nvidia-smi on this machine, else ComfyUI's report), cached for 3 s. */
export async function readDevice(base: string): Promise<Device | null> {
  if (deviceCache && Date.now() - deviceCache.t < 3000) return deviceCache.v;
  const v = process.env.GD_NO_NVIDIA_SMI ? await comfyDevice(base) : ((await nvidiaSmi()) ?? (await comfyDevice(base)));
  deviceCache = { t: Date.now(), v };
  return v;
}
