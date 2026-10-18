/** Routes each GenAI purpose to its configured provider, with validation, retries and logging. */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR, DATA_DIR } from '../paths';
import { AnthropicProvider, ComfyUIProvider, GoogleProvider, LlamaDecisionProvider, OpenAIChatProvider, OpenAIImageProvider, OpenAIResponsesProvider } from './providers';
import { GpuScheduler } from './gpu';
import { callContext, priorityOf, PRIORITY_RANK } from './context';
import { parseModelJson } from './json';
import {
  GenAIError, PURPOSES, ProceduralOnly,
  type DecisionAnswer, type DecisionProvider, type DecisionRequest, type GenAIConfig, type ImageProvider, type ImageRequest, type ProviderConfig, type Purpose, type PurposeConfig, type TextProvider, type TextRequest,
} from './types';

export const DEFAULT_CONFIG: GenAIConfig = {
  providers: { procedural: { type: 'procedural' } },
  purposes: Object.fromEntries(PURPOSES.map((p) => [p, { provider: 'procedural' }])) as GenAIConfig['purposes'],
  combineNpcDecisionAndDialogue: true,
  worldGenParallelism: 2,
};

export function loadGenAIConfig(): GenAIConfig {
  const file = process.env.GD_GENAI_CONFIG ?? path.join(CONFIG_DIR, 'genai.json');
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GenAIConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    providers: { procedural: { type: 'procedural' }, ...(raw.providers ?? {}) },
    purposes: { ...DEFAULT_CONFIG.purposes, ...(raw.purposes ?? {}) },
  };
}

class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export interface CallLog {
  at: number;
  purpose: Purpose;
  provider: string;
  ms: number;
  ok: boolean;
  error?: string;
  attempt: number;
  promptChars: number;
  responseChars?: number;
  preview?: string;
}

export interface StructuredOptions<T extends z.ZodType> {
  system?: string;
  prompt: string;
  schema: T;
  name: string;
  history?: TextRequest['messages'];
  temperature?: number;
  maxTokens?: number;
  images?: Buffer[];
  /** Extra semantic validation; return an error string to trigger a retry. */
  validate?: (v: z.infer<T>) => string | null;
}

export class GenAI {
  private textProviders = new Map<string, TextProvider>();
  private imageProviders = new Map<string, ImageProvider>();
  private limiters = new Map<string, Limiter>();
  private decisionProviders = new Map<string, DecisionProvider>();
  readonly gpu = new GpuScheduler(() => this.config.gpuIdleUnloadMs ?? 300_000);
  private gpuMembersRegistered = false;
  readonly recent: CallLog[] = [];
  private logFile: string;

  constructor(public config: GenAIConfig) {
    fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
    this.logFile = path.join(DATA_DIR, 'logs', 'genai.jsonl');
  }

  purpose(p: Purpose): PurposeConfig {
    return this.config.purposes[p] ?? { provider: 'procedural' };
  }

  providerConfig(name: string): ProviderConfig {
    const c = this.config.providers[name];
    if (!c) throw new GenAIError(`Unknown provider "${name}"`, false);
    return c;
  }

  isProcedural(p: Purpose): boolean {
    const pc = this.config.purposes[p];
    return !pc || pc.provider === 'procedural' || this.config.providers[pc.provider]?.type === 'procedural';
  }

  describe(): { purpose: Purpose; provider: string; type: string; model?: string; gpu?: string }[] {
    return PURPOSES.map((p) => {
      const pc = this.purpose(p);
      const prov = this.config.providers[pc.provider];
      return { purpose: p, provider: pc.provider, type: prov?.type ?? 'missing', model: pc.model ?? prov?.model ?? prov?.checkpoint, gpu: prov?.gpu };
    });
  }

  private limiter(name: string): Limiter {
    let l = this.limiters.get(name);
    if (!l) {
      l = new Limiter(this.config.providers[name]?.concurrency ?? 2);
      this.limiters.set(name, l);
    }
    return l;
  }

  /**
   * Run a provider call: through its exclusive GPU group when it has one (most urgent first), within the
   * provider's concurrency limit, and retried while the provider is busy, rate-limited or unreachable. A
   * player-facing call gives up after a few seconds (the game falls back); background work waits much longer
   * and tells its job why it is waiting instead of failing.
   */
  private async exec<T>(purpose: Purpose, providerName: string, model: string | undefined, fn: () => Promise<T>): Promise<T> {
    const cfg = this.providerConfig(providerName);
    const m = model ?? cfg.model ?? cfg.checkpoint ?? providerName;
    if (cfg.gpu && !this.gpuMembersRegistered) {
      // Every provider sharing a GPU group is known up front, so eviction covers servers not used yet.
      this.gpuMembersRegistered = true;
      for (const [n, c] of Object.entries(this.config.providers)) if (c.gpu) this.gpu.group(c.gpu).members.set(n, c);
    }
    const priority = priorityOf(purpose);
    const onWait = callContext()?.onWait;
    const once = () => (cfg.gpu ? this.gpu.group(cfg.gpu).run(providerName, m, cfg, () => this.limiter(providerName).run(fn), PRIORITY_RANK[priority], onWait) : this.limiter(providerName).run(fn));
    const deadline = Date.now() + (priority === 'interactive' ? 12_000 : (this.config.waitForModelsMs ?? 30 * 60_000));
    let delay = priority === 'interactive' ? 1000 : 3000;
    let waiting = false;
    for (;;) {
      try {
        const out = await once();
        if (waiting) onWait?.(null);
        return out;
      } catch (e) {
        if (!isTransient(e) || Date.now() + delay > deadline) {
          if (waiting) onWait?.(null);
          throw e;
        }
        waiting = true;
        onWait?.(`Waiting for ${providerName}: ${(e as Error).message.slice(0, 80)} (retrying in ${Math.round(delay / 1000)}s)`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(60_000, delay * 2);
      }
    }
  }

  /** Unload every local model (call after a batch of work such as world generation). */
  releaseGpu(): Promise<void> {
    return this.gpu.releaseAll();
  }

  /** Is this purpose served by a decision model (choice/score/yes-no answers) rather than an LLM? */
  isDecision(p: Purpose): boolean {
    const pc = this.config.purposes[p];
    return !!pc && this.config.providers[pc.provider]?.type === 'llamacpp-decision';
  }

  async decide(p: Purpose, req: DecisionRequest): Promise<Record<string, DecisionAnswer>> {
    const pc = this.purpose(p);
    let prov = this.decisionProviders.get(pc.provider);
    if (!prov) {
      const cfg = this.providerConfig(pc.provider);
      if (cfg.type !== 'llamacpp-decision') throw new GenAIError(`Provider "${pc.provider}" is not a decision model`, false);
      prov = new LlamaDecisionProvider(cfg);
      this.decisionProviders.set(pc.provider, prov);
    }
    const t0 = Date.now();
    try {
      const out = await this.exec(p, pc.provider, pc.model, () => prov!.decide(req, pc.model));
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt: 1, promptChars: JSON.stringify(req.state).length, preview: Object.entries(out).map(([k, v]) => `${k}=${v.type === 'choice' ? v.choice : v.type === 'score' ? v.score.toFixed(2) : v.noul.toFixed(2)}`).join(' ').slice(0, 160) });
      return out;
    } catch (e) {
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 300), attempt: 1, promptChars: 0 });
      throw e;
    }
  }

  private text_(name: string): TextProvider {
    let p = this.textProviders.get(name);
    if (p) return p;
    const cfg = this.providerConfig(name);
    switch (cfg.type) {
      case 'openai-chat': p = new OpenAIChatProvider(cfg); break;
      case 'openai-responses': p = new OpenAIResponsesProvider(cfg); break;
      case 'anthropic': p = new AnthropicProvider(cfg); break;
      case 'google': p = new GoogleProvider(cfg); break;
      case 'procedural': throw new ProceduralOnly();
      default: throw new GenAIError(`Provider "${name}" (${cfg.type}) cannot generate text`, false);
    }
    this.textProviders.set(name, p);
    return p;
  }

  private image_(name: string): ImageProvider {
    let p = this.imageProviders.get(name);
    if (p) return p;
    const cfg = this.providerConfig(name);
    switch (cfg.type) {
      case 'comfyui': p = new ComfyUIProvider(cfg); break;
      case 'openai-image': p = new OpenAIImageProvider(cfg); break;
      case 'google-image':
      case 'google': p = new GoogleProvider(cfg); break;
      case 'procedural': throw new ProceduralOnly();
      default: throw new GenAIError(`Provider "${name}" (${cfg.type}) cannot generate images`, false);
    }
    this.imageProviders.set(name, p);
    return p;
  }

  private log(entry: CallLog) {
    this.recent.push(entry);
    if (this.recent.length > 200) this.recent.shift();
    fs.appendFile(this.logFile, JSON.stringify(entry) + '\n', () => {});
  }

  /** Plain text generation. */
  async text(p: Purpose, req: TextRequest): Promise<string> {
    const pc = this.purpose(p);
    const provider = this.text_(pc.provider);
    const t0 = Date.now();
    try {
      const out = await this.exec(p, pc.provider, pc.model, () =>
        provider.text({ ...req, temperature: req.temperature ?? pc.temperature, maxTokens: req.maxTokens ?? pc.maxTokens }, pc.model, pc.extraBody),
      );
      const cleaned = out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt: 1, promptChars: JSON.stringify(req.messages).length, responseChars: cleaned.length, preview: cleaned.slice(0, 160) });
      return cleaned;
    } catch (e) {
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 300), attempt: 1, promptChars: 0 });
      throw e;
    }
  }

  /** Structured generation validated with zod, retried with the validation error as feedback. */
  async structured<T extends z.ZodType>(p: Purpose, opts: StructuredOptions<T>): Promise<z.infer<T>> {
    const pc = this.purpose(p);
    const provider = this.text_(pc.provider);
    const jsonSchema = z.toJSONSchema(opts.schema, { unrepresentable: 'any' }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const retries = pc.retries ?? 2;
    const messages = [...(opts.history ?? []), { role: 'user' as const, content: opts.prompt }];
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const t0 = Date.now();
      let raw = '';
      try {
        raw = await this.exec(p, pc.provider, pc.model, () =>
          provider.structured(
            { system: opts.system, messages, schema: jsonSchema, schemaName: opts.name, temperature: opts.temperature ?? pc.temperature, maxTokens: opts.maxTokens ?? pc.maxTokens, images: opts.images },
            pc.model,
            pc.extraBody,
          ),
        );
        const parsed = parseModelJson(raw);
        const result = opts.schema.safeParse(parsed);
        if (!result.success) throw new Error(`Schema validation failed: ${z.prettifyError(result.error).slice(0, 800)}`);
        const semantic = opts.validate?.(result.data);
        if (semantic) throw new Error(`Content problem: ${semantic}`);
        this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt, promptChars: opts.prompt.length + (opts.system?.length ?? 0), responseChars: raw.length });
        return result.data;
      } catch (e) {
        lastErr = e as Error;
        this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: lastErr.message.slice(0, 400), attempt, promptChars: opts.prompt.length, responseChars: raw.length, preview: raw.slice(0, 200) });
        if (e instanceof GenAIError && !e.retryable) break;
        if (raw) {
          // Give the model its own output and the error so it can correct itself.
          messages.push({ role: 'assistant', content: raw.slice(0, 6000) });
          messages.push({ role: 'user', content: `That response was invalid. ${lastErr.message}\nReturn the complete corrected JSON object only.` });
        }
      }
    }
    throw lastErr ?? new Error('structured generation failed');
  }

  async image(p: Purpose, req: Omit<ImageRequest, 'width' | 'height'> & Partial<Pick<ImageRequest, 'width' | 'height'>>): Promise<Buffer> {
    const pc = this.purpose(p);
    const provider = this.image_(pc.provider);
    const t0 = Date.now();
    const full: ImageRequest = {
      ...req,
      width: req.width ?? pc.width ?? 1024,
      height: req.height ?? pc.height ?? 1024,
      negativePrompt: [req.negativePrompt, pc.negativePrompt].filter(Boolean).join(', '),
    };
    try {
      const buf = await this.exec(p, pc.provider, pc.model, () => provider.generate(full, pc.model, pc.extraBody));
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt: 1, promptChars: req.prompt.length, responseChars: buf.length });
      return buf;
    } catch (e) {
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 300), attempt: 1, promptChars: req.prompt.length });
      throw e;
    }
  }
}

/** Worth retrying: the provider is busy, rate-limited, overloaded or unreachable (not a bad request). */
export function isTransient(e: unknown): boolean {
  if (e instanceof ProceduralOnly) return false;
  if (e instanceof GenAIError && !e.retryable) return false;
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string }; status?: number };
  const text = `${err.message ?? ''} ${err.code ?? ''} ${err.cause?.code ?? ''} ${err.cause?.message ?? ''} ${err.status ?? ''}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR|socket hang up|network|timed? ?out|(408|409|425|429|500|502|503|504|529)|overloaded|rate.?limit|too many requests|temporarily|unavailable|loading model/i.test(text);
}

let instance: GenAI | null = null;
export function genai(): GenAI {
  if (!instance) instance = new GenAI(loadGenAIConfig());
  return instance;
}
export function reloadGenAI(): GenAI {
  instance = new GenAI(loadGenAIConfig());
  return instance;
}
