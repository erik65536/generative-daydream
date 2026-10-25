/**
 * The one ComfyUI client: where ComfyUI is (or the GPU broker in front of it), its token, and queueing a workflow
 * and waiting for it. Behind the broker (provider "broker": true) a prompt can wait for its turn: the broker says so
 * in an X-Broker-State header, and that time does not count against the deadline; the job is told it is waiting.
 * A broker that restarted no longer knows a prompt (404), which is then sent again. See docs/gpu-broker.md.
 */
import crypto from 'node:crypto';
import { genai } from './service';
import { callContext } from './context';
import { resolveSecret } from './providers';
import type { ProviderConfig } from './types';
import { promptBody } from '../gpu/presence';
import { dropPrompt } from '../gpu/comfyqueue';

export interface ComfyTarget {
  base: string;
  headers: Record<string, string>;
  /** The GPU broker, not ComfyUI itself. */
  broker: boolean;
}

export interface ComfyImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface ComfyEntry {
  outputs?: Record<string, Record<string, unknown> & { images?: ComfyImage[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] };
}

export class ComfyError extends Error {}

/** The configured ComfyUI provider (the first of type comfyui). */
export function comfyProvider(): [string, ProviderConfig] | undefined {
  return Object.entries(genai().config.providers).find(([, p]) => p.type === 'comfyui');
}

export function comfyTarget(cfg: ProviderConfig | undefined = comfyProvider()?.[1]): ComfyTarget {
  const base = (process.env.COMFY_URL ?? cfg?.baseUrl ?? 'http://127.0.0.1:8188').replace(/\/+$/, '');
  const token = resolveSecret(cfg?.apiKey);
  return { base, headers: token ? { authorization: `Bearer ${token}` } : {}, broker: !!cfg?.broker };
}

export const comfyBase = () => comfyTarget().base;
export const comfyHeaders = () => comfyTarget().headers;

/** fetch against ComfyUI (or the broker), with its token. */
export function comfyFetch(path: string, init: RequestInit = {}, t: ComfyTarget = comfyTarget()): Promise<Response> {
  return fetch(t.base + path, { ...init, headers: { ...t.headers, ...(init.headers as Record<string, string> | undefined) } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a job is told while its prompt waits in the broker's queue (null: not waiting). */
export function waitReason(state: string): string | null {
  if (!state.startsWith('queued')) return null;
  const pos = Number(/position=(\d+)/.exec(state)?.[1] ?? 0);
  const down = /waiting=([^;]+)/.exec(state)?.[1];
  return `Waiting for the GPU${down ? `: ${down}` : pos > 1 ? ` (${pos - 1} ahead)` : pos === 1 ? ' (next)' : ''}`;
}

/** Take a prompt off: the broker removes or interrupts it itself; plain ComfyUI is read first (see dropPrompt). */
async function cancelPrompt(t: ComfyTarget, id: string) {
  if (t.broker) await comfyFetch('/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [id] }), signal: AbortSignal.timeout(10_000) }, t);
  else await dropPrompt(t.base, id);
}

/**
 * Queue a workflow and wait for it to finish; returns its history entry. `workflow` names it for the admin page and
 * for the broker (work for the same name runs back to back without unloading). `timeoutMs` counts only time that
 * is not spent waiting in the broker's queue.
 */
export async function submitAndWait(prompt: unknown, opts: { workflow?: string; timeoutMs: number; pollMs?: number; target?: ComfyTarget }): Promise<ComfyEntry> {
  const t = opts.target ?? comfyTarget();
  const ctx = callContext();
  for (let attempt = 1; ; attempt++) {
    const res = await comfyFetch('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: promptBody(prompt, opts.workflow, crypto.randomUUID()), signal: AbortSignal.timeout(30_000) }, t);
    const queued = (await res.json().catch(() => ({}))) as { prompt_id?: string };
    if (!queued.prompt_id) throw new ComfyError(`ComfyUI did not queue the prompt: ${JSON.stringify(queued).slice(0, 400)}`);
    const id = queued.prompt_id;
    let used = 0;
    let last = Date.now();
    let told: string | null = null;
    let forgotten = false;
    while (used < opts.timeoutMs) {
      await sleep(opts.pollMs ?? 600);
      if (ctx?.cancelled?.()) {
        await cancelPrompt(t, id).catch(() => undefined);
        throw new ComfyError('cancelled');
      }
      let state = '';
      let entry: ComfyEntry | undefined;
      try {
        const h = await comfyFetch(`/history/${id}`, { signal: AbortSignal.timeout(15_000) }, t);
        if (h.status === 404 && t.broker) {
          forgotten = true;
          break;
        }
        state = h.headers.get('x-broker-state') ?? '';
        entry = ((await h.json()) as Record<string, ComfyEntry>)[id];
      } catch {
        // ComfyUI can stop answering for a while under load (a big model loading); the prompt is still queued.
      }
      const now = Date.now();
      const waiting = state.startsWith('queued');
      if (!waiting) used += now - last;
      last = now;
      const why = waitReason(state);
      if (why !== told) {
        told = why;
        ctx?.onWait?.(why);
      }
      if (!entry) continue;
      if (entry.status?.status_str === 'error') {
        const err = entry.status.messages?.find((m) => m[0] === 'execution_error' || m[0] === 'execution_interrupted');
        throw new ComfyError(err?.[0] === 'execution_interrupted' ? 'interrupted' : String(err?.[1]?.exception_message ?? 'execution error').slice(0, 400));
      }
      if (entry.status?.completed) return entry;
    }
    if (told) ctx?.onWait?.(null);
    if (!forgotten) throw new ComfyError('timed out');
    if (attempt >= 3) throw new ComfyError('the GPU broker keeps forgetting this prompt (restarting?)');
  }
}

/** Every image a finished prompt saved, in node order. */
export function savedImages(entry: ComfyEntry): ComfyImage[] {
  return Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
}

/** Download one saved image. */
export async function viewImage(img: ComfyImage, t: ComfyTarget = comfyTarget()): Promise<Buffer> {
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
  const res = await comfyFetch(`/view?${q}`, {}, t);
  if (!res.ok) throw new ComfyError(`ComfyUI view failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Run `fn` holding the whole GPU through the broker (a program this PC runs itself, outside ComfyUI, such as
 * SkinTokens): waits for the turn, keeps checking in while `fn` runs, and ends the turn after.
 */
export async function withBrokerHold<T>(model: string, rank: number, fn: () => Promise<T>, t: ComfyTarget = comfyTarget()): Promise<T> {
  const ctx = callContext();
  const json = { 'content-type': 'application/json' };
  const res = await comfyFetch('/broker/holds', { method: 'POST', headers: json, body: JSON.stringify({ model, rank, tag: { ...ctx?.tag, workflow: model } }) }, t);
  if (!res.ok) throw new ComfyError(`the GPU broker refused a hold: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  const check = async () => (await (await comfyFetch(`/broker/holds/${id}`, {}, t)).json()) as { state: string; position?: number; error?: string };
  const end = () => comfyFetch(`/broker/holds/${id}`, { method: 'DELETE' }, t).catch(() => undefined);
  try {
    for (let told = false; ; ) {
      if (ctx?.cancelled?.()) throw new ComfyError('cancelled');
      const s = await check();
      if (s.state === 'running') {
        if (told) ctx?.onWait?.(null);
        break;
      }
      if (s.state !== 'queued') throw new ComfyError(`the GPU broker ended the hold: ${s.error ?? s.state}`);
      if (!told) ctx?.onWait?.(`Waiting for the whole GPU (${model})`);
      told = true;
      await sleep(1000);
    }
    const ping = setInterval(() => void check().catch(() => undefined), 5000);
    try {
      return await fn();
    } finally {
      clearInterval(ping);
    }
  } finally {
    await end();
  }
}
