/**
 * ComfyUI behind the broker. A queued prompt is sent to ComfyUI only when its turn comes, under the broker's own id
 * (ComfyUI takes a caller's prompt_id), so callers read its outcome from ComfyUI's /history as before. Unloading is
 * ComfyUI's /free; cancelling removes the prompt from ComfyUI's queue or interrupts it.
 */
import { AdapterDown, type GpuAdapter, type RunContext } from '../scheduler';

export interface ComfyWork {
  prompt: unknown;
  client_id?: string;
  extra_data?: Record<string, unknown>;
}

export interface ComfyOptions {
  url: string;
  freeBetweenModels?: boolean;
  /** How often /history is read while a prompt runs. */
  pollMs?: number;
  /** How long ComfyUI may stop answering while a prompt runs (a big model loading) before it counts as down. */
  silentMs?: number;
}

/** ComfyUI refused the prompt (validation): kept so /history can answer with the error. */
export class ComfyRejected extends Error {
  constructor(message: string, readonly body: unknown) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ComfyAdapter implements GpuAdapter<ComfyWork> {
  readonly name = 'comfyui';
  readonly url: string;
  readonly freeBetweenModels: boolean;
  private readonly pollMs: number;
  private readonly silentMs: number;

  constructor(o: ComfyOptions) {
    this.url = o.url.replace(/\/+$/, '');
    this.freeBetweenModels = o.freeBetweenModels ?? true;
    this.pollMs = o.pollMs ?? 500;
    this.silentMs = o.silentMs ?? 120_000;
  }

  private async call(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
    try {
      return await fetch(this.url + path, { ...init, signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000) });
    } catch (e) {
      throw new AdapterDown(`ComfyUI at ${this.url}: ${(e as Error).message}`);
    }
  }

  private post(path: string, body: unknown) {
    return this.call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async alive(): Promise<boolean> {
    try {
      return (await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(4000) })).ok;
    } catch {
      return false;
    }
  }

  async unload(): Promise<void> {
    await this.post('/free', { unload_models: true, free_memory: true });
  }

  async run(work: ComfyWork, ctx: RunContext): Promise<unknown> {
    const res = await this.post('/prompt', { prompt: work.prompt, prompt_id: ctx.id, client_id: work.client_id, extra_data: work.extra_data ?? {} });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.prompt_id !== ctx.id) throw new ComfyRejected(`ComfyUI refused the prompt: ${JSON.stringify(body.error ?? body).slice(0, 600)}`, body);
    let quietSince = 0;
    for (;;) {
      if (ctx.signal.aborted) {
        await this.drop(ctx.id).catch(() => undefined);
        throw new Error('cancelled');
      }
      await sleep(this.pollMs);
      let entry: { status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] } } | undefined;
      try {
        const h = await fetch(`${this.url}/history/${ctx.id}`, { signal: AbortSignal.timeout(15_000) });
        entry = ((await h.json()) as Record<string, typeof entry>)[ctx.id];
        quietSince = 0;
      } catch (e) {
        // ComfyUI can stop answering for a while under load; the prompt is still queued there.
        quietSince ||= Date.now();
        if (Date.now() - quietSince > this.silentMs) throw new AdapterDown(`ComfyUI stopped answering: ${(e as Error).message}`);
        continue;
      }
      if (!entry) continue;
      if (entry.status?.status_str === 'error') {
        const err = entry.status.messages?.find((m) => m[0] === 'execution_error' || m[0] === 'execution_interrupted');
        throw new Error(err?.[0] === 'execution_interrupted' ? 'interrupted' : String(err?.[1]?.exception_message ?? 'execution error').slice(0, 400));
      }
      if (entry.status?.completed) return undefined;
    }
  }

  /** Take our prompt off ComfyUI: removed while pending, interrupted while running. */
  private async drop(id: string) {
    const q = (await (await this.call('/queue', { timeoutMs: 5000 })).json()) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    if ((q.queue_pending ?? []).some((p) => p[1] === id)) await this.post('/queue', { delete: [id] });
    else if ((q.queue_running ?? []).some((p) => p[1] === id)) await this.post('/interrupt', { prompt_id: id });
  }
}
