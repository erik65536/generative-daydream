/** Concrete GenAI provider adapters. */
import { chargeUsage } from './spend';
import { Agent, fetch as undiciFetch } from 'undici';
import fs from 'node:fs';
import path from 'node:path';
import { GenAIError, type DecisionAnswer, type DecisionProvider, type DecisionRequest, type ImageProvider, type ImageRequest, type ProviderConfig, type StructuredRequest, type TextProvider, type TextRequest } from './types';
import { ROOT_DIR } from '../paths';
import { strictSchema } from './json';
import { ComfyError, comfyTarget, savedImages, submitAndWait, viewImage } from './comfyclient';

/**
 * A key from the config: "env:NAME" reads an environment variable (.env in development); "credential:NAME" reads a
 * systemd credential (LoadCredentialEncrypted=NAME), a file only this service can read and that, unlike the
 * environment, child processes (the animator's Python, Chromium) do not inherit. Anything else is the key itself.
 */
export function resolveSecret(v?: string): string | undefined {
  if (!v) return undefined;
  if (v.startsWith('env:')) return process.env[v.slice(4)] || undefined;
  if (v.startsWith('credential:')) {
    const name = v.slice(11);
    const dir = process.env.CREDENTIALS_DIRECTORY;
    if (!dir || !/^[\w.-]+$/.test(name)) return undefined;
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return v;
}

/**
 * A flex-tier answer with long reasoning can take many minutes before the first byte (no streaming), so the default
 * 300 s header timeout of Node's fetch is disabled; the per-provider `timeoutMs` abort signal is the only limit.
 */
const patientAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 30_000 } });

async function httpJson(url: string, init: RequestInit & { timeoutMs?: number }): Promise<any> {
  let res: Response;
  try {
    res = (await undiciFetch(url, { ...(init as object), dispatcher: patientAgent, signal: AbortSignal.timeout(init.timeoutMs ?? 180_000) })) as unknown as Response;
  } catch (e) {
    throw new GenAIError(`Request to ${url} failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new GenAIError(`HTTP ${res.status} from ${url}: ${text.slice(0, 600)}`, retryable);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GenAIError(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

// ---------------------------------------------------------------------------- OpenAI Responses API

/** Tokens used on OpenAI this process (for cost reports in tools and logs). */
export const openaiUsage = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, decisionCalls: 0, decisionInput: 0 };

/** Rough spend in dollars at gpt-6-luna prices (flex halves text). */
export function openaiCost(flex = true): number {
  const k = flex ? 0.5 : 1;
  return k * ((openaiUsage.input - openaiUsage.cached) * 0.1 + openaiUsage.cached * 0.01 + openaiUsage.output * 0.5) / 1e6 + (openaiUsage.decisionInput * 0.1) / 1e6;
}

export class OpenAIResponsesProvider implements TextProvider {
  constructor(private cfg: ProviderConfig) {}

  private async call(req: TextRequest, model: string | undefined, format: unknown, extra?: Record<string, unknown>): Promise<string> {
    const key = resolveSecret(this.cfg.apiKey) ?? process.env.OPENAI_API_KEY;
    const input = req.messages.map((m, i) => {
      const isLastUser = i === req.messages.length - 1 && m.role === 'user';
      if (isLastUser && req.images?.length)
        return { role: 'user', content: [{ type: 'input_text', text: m.content }, ...req.images.map((b) => ({ type: 'input_image', image_url: `data:image/png;base64,${b.toString('base64')}` }))] };
      return { role: m.role, content: m.content };
    });
    const body: Record<string, unknown> = { model: model ?? this.cfg.model, instructions: req.system, input, max_output_tokens: req.maxTokens ? req.maxTokens + (this.cfg.reasoningTokens ?? 0) : undefined, ...(this.cfg.serviceTier ? { service_tier: this.cfg.serviceTier } : {}), ...(this.cfg.extraBody ?? {}), ...extra };
    // Reasoning models take no sampling temperature.
    if (req.temperature !== undefined && !/^(o\d|gpt-[5-9])/.test(String(body.model))) body.temperature = req.temperature;
    if (format) body.text = { format };
    const data = await httpJson(`${trimSlash(this.cfg.baseUrl ?? 'https://api.openai.com/v1')}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(this.cfg.headers ?? {}) },
      body: JSON.stringify(body),
      timeoutMs: this.cfg.timeoutMs,
    });
    const u = data.usage;
    if (u) {
      chargeUsage(this.cfg, { input: u.input_tokens, cached: u.input_tokens_details?.cached_tokens, output: u.output_tokens }, String(body.model));
      openaiUsage.calls++;
      openaiUsage.input += u.input_tokens ?? 0;
      openaiUsage.cached += u.input_tokens_details?.cached_tokens ?? 0;
      openaiUsage.output += u.output_tokens ?? 0;
      openaiUsage.reasoning += u.output_tokens_details?.reasoning_tokens ?? 0;
    }
    if (data.status === 'incomplete') throw new GenAIError(`Response incomplete (${data.incomplete_details?.reason ?? 'unknown'}); raise maxTokens or reasoningTokens`, false);
    if (typeof data.output_text === 'string') return data.output_text;
    const parts: string[] = [];
    for (const o of data.output ?? []) if (o.type === 'message') for (const c of o.content ?? []) if (c.type === 'output_text') parts.push(c.text);
    if (!parts.length) throw new GenAIError(`No text in response: ${JSON.stringify(data).slice(0, 300)}`);
    return parts.join('');
  }

  text(req: TextRequest, model?: string, extra?: Record<string, unknown>) {
    return this.call(req, model, undefined, extra);
  }

  /** Strict structured outputs: the schema is enforced while decoding (see strictSchema for what that covers). */
  structured(req: StructuredRequest, model?: string, extra?: Record<string, unknown>) {
    return this.call(req, model, { type: 'json_schema', name: req.schemaName, schema: strictSchema(req.schema as never), strict: true }, extra);
  }
}

// ---------------------------------------------------------------------------- ComfyUI

/**
 * ComfyUI runs the asset workflow (config/comfyui/krea2_cutout.json): Krea 2 paints the subject on its chroma-key
 * backdrop and the cutter model (BiRefNet) marks it, in one queued job; the result is the painting with the mask as
 * its alpha channel.
 */
export class ComfyUIProvider implements ImageProvider {
  private template: unknown;
  constructor(private cfg: ProviderConfig) {
    const file = cfg.workflow ?? 'config/comfyui/krea2_cutout.json';
    this.template = JSON.parse(fs.readFileSync(path.resolve(ROOT_DIR, file), 'utf8'));
    if (!Object.values(this.template as Record<string, { class_type?: string }>).some((n) => n.class_type === 'RemoveBackground'))
      throw new GenAIError(`ComfyUI workflow ${file} has no cutter (RemoveBackground): art needs the painting with its cutout mask, as config/comfyui/krea2_cutout.json makes`, false);
  }

  private fill(node: unknown, vars: Record<string, string | number>): unknown {
    if (typeof node === 'string') {
      const whole = node.match(/^\{\{(\w+)\}\}$/);
      if (whole && whole[1]! in vars) return vars[whole[1]!];
      return node.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
    }
    if (Array.isArray(node)) return node.map((n) => this.fill(n, vars));
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, this.fill(v, vars)]));
    return node;
  }

  async generate(req: ImageRequest, model?: string): Promise<Buffer> {
    const checkpoint = model ?? this.cfg.checkpoint ?? this.cfg.model ?? 'krea2_turbo_fp8_scaled.safetensors';
    const workflow = this.fill(this.template, {
      prompt: req.prompt,
      seed: req.seed,
      width: req.width,
      height: req.height,
      checkpoint,
      steps: this.cfg.steps ?? 8,
      cfg: this.cfg.cfg ?? 1,
      cutter: this.cfg.cutter ?? 'birefnet.safetensors',
    });
    return this.run(workflow, checkpoint);
  }

  /** Queue a workflow and wait for its first image. */
  private async run(workflow: unknown, model: string): Promise<Buffer> {
    const target = comfyTarget(this.cfg);
    try {
      const img = savedImages(await submitAndWait(workflow, { workflow: model, timeoutMs: this.cfg.timeoutMs ?? 300_000, pollMs: 750, target }))[0];
      if (!img) throw new GenAIError('ComfyUI saved no image');
      return await viewImage(img, target);
    } catch (e) {
      if (!(e instanceof ComfyError)) throw e;
      if (e.message === 'cancelled') throw new GenAIError('cancelled', false);
      throw new GenAIError(e.message === 'timed out' ? 'ComfyUI timed out' : `ComfyUI error: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------- decision models

/**
 * OpenAI decision models (POST /v1/decisions): questions answered independently over shared evidence, as
 * probabilities. Our question types map onto theirs: choice -> choice, score -> score levels, noul -> predicate.
 */
export class OpenAIDecisionProvider implements DecisionProvider {
  constructor(private cfg: ProviderConfig) {}
  async decide(req: DecisionRequest, model?: string): Promise<Record<string, DecisionAnswer>> {
    const key = resolveSecret(this.cfg.apiKey) ?? process.env.OPENAI_API_KEY;
    const state = typeof req.state === 'string' ? req.state : req.state.map((m) => `${m.role}: ${m.content}`).join('\n');
    const names = Object.keys(req.questions);
    const questions = names.map((name) => {
      const q = req.questions[name]!;
      if (q.type === 'choice') return { type: 'choice', name, instructions: q.instructions, choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description: description ?? value })) };
      if (q.type === 'score') return { type: 'score', name, instructions: q.instructions, levels: q.criteria.map((label) => ({ label, description: label })) };
      return { type: 'predicate', name, instructions: q.instructions };
    });
    const content = [{ type: 'input_text', text: state }, ...(req.images ?? []).map((b) => ({ type: 'input_image', image_url: `data:image/png;base64,${b.toString('base64')}` }))];
    const data = await httpJson(`${trimSlash(this.cfg.baseUrl ?? 'https://api.openai.com/v1')}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(this.cfg.headers ?? {}) },
      body: JSON.stringify({ model: model ?? this.cfg.model ?? 'gpt-6-luna', input: [{ role: 'user', content }], questions, ...(this.cfg.extraBody ?? {}) }),
      timeoutMs: this.cfg.timeoutMs ?? 120_000,
    });
    if (!Array.isArray(data?.answers)) throw new GenAIError(`Decision model returned no answers: ${JSON.stringify(data).slice(0, 300)}`);
    openaiUsage.decisionCalls++;
    openaiUsage.decisionInput += data.usage?.input_tokens ?? 0;
    chargeUsage(this.cfg, { input: data.usage?.input_tokens, output: data.usage?.output_tokens });
    const out: Record<string, DecisionAnswer> = {};
    for (const a of data.answers as { type: string; name: string; probability?: number; choice?: string; score?: number; confidence?: number; probabilities?: { value: string; label?: string; probability: number }[] }[]) {
      const probs = Object.fromEntries((a.probabilities ?? []).map((p) => [p.value, p.probability]));
      if (a.type === 'predicate') out[a.name] = { type: 'noul', noul: a.probability ?? 0.5 };
      else if (a.type === 'choice') out[a.name] = { type: 'choice', choice: String(a.choice), probabilities: probs, confidence: a.confidence ?? 0 };
      else if (a.type === 'score') {
        const q = req.questions[a.name];
        const legend = q?.type === 'score' ? Object.fromEntries(q.criteria.map((c, i) => [String(i), c])) : {};
        out[a.name] = { type: 'score', score: a.score ?? 0, legend, probabilities: probs, confidence: a.confidence ?? 0 };
      }
      // A refusal leaves the question unanswered; callers treat missing answers as neutral.
    }
    return out;
  }
}

// ---------------------------------------------------------------------------- speech to text

/** OpenAI transcription (POST /v1/audio/transcriptions): a recorded utterance in, its words out. */
export class OpenAITranscribeProvider {
  constructor(private cfg: ProviderConfig) {}
  async transcribe(audio: Buffer, mime: string, model?: string, language?: string): Promise<string> {
    const key = resolveSecret(this.cfg.apiKey) ?? process.env.OPENAI_API_KEY;
    const form = new FormData();
    const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext}`);
    form.append('model', model ?? this.cfg.model ?? 'gpt-4o-mini-transcribe');
    if (language) form.append('language', language);
    const res = await fetch(`${trimSlash(this.cfg.baseUrl ?? 'https://api.openai.com/v1')}/audio/transcriptions`, {
      method: 'POST',
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(this.cfg.headers ?? {}) },
      body: form,
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string }; usage?: { type?: string; seconds?: number; input_tokens?: number; output_tokens?: number } };
    if (!res.ok) throw new GenAIError(`Transcription failed (${res.status}): ${data.error?.message ?? 'unknown error'}`, res.status === 429 || res.status >= 500);
    const u = data.usage;
    if (u) chargeUsage(this.cfg, u.type === 'duration' ? { seconds: u.seconds ?? 0 } : { input: u.input_tokens, output: u.output_tokens });
    return (data.text ?? '').trim();
  }
}
