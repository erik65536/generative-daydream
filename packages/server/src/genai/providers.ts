/** Concrete GenAI provider adapters. */
import { chargeUsage } from './spend';
import { Agent, fetch as undiciFetch } from 'undici';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { GenAIError, type DecisionAnswer, type DecisionProvider, type DecisionRequest, type ImageProvider, type ImageRequest, type ProviderConfig, type StructuredRequest, type TextProvider, type TextRequest } from './types';
import { ROOT_DIR } from '../paths';
import { strictSchema } from './json';
import { callContext } from './context';
import { promptBody } from '../gpu/presence';
import { dropPrompt } from '../gpu/comfyqueue';

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
 * Local models can take many minutes before the first byte (no streaming), so the default 300 s header timeout
 * of Node's fetch is disabled; the per-provider `timeoutMs` abort signal is the only limit.
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

/** Instruction appended when the provider cannot enforce a schema natively. */
export function schemaInstruction(req: StructuredRequest): string {
  return `\n\nRespond with ONLY a single JSON object (no markdown, no commentary) that matches this JSON Schema named "${req.schemaName}":\n${JSON.stringify(req.schema)}`;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

// ---------------------------------------------------------------------------- OpenAI-compatible chat

/** Works with OpenAI, llama.cpp server, LM Studio, vLLM, Ollama (/v1), OpenRouter, etc. */
export class OpenAIChatProvider implements TextProvider {
  constructor(private cfg: ProviderConfig) {}

  private headers() {
    const key = resolveSecret(this.cfg.apiKey);
    return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(this.cfg.headers ?? {}) };
  }

  private messages(req: TextRequest, systemExtra = '') {
    const msgs: any[] = [];
    if (req.system || systemExtra) msgs.push({ role: 'system', content: (req.system ?? '') + systemExtra });
    req.messages.forEach((m, i) => {
      const isLastUser = i === req.messages.length - 1 && m.role === 'user';
      if (isLastUser && req.images?.length) {
        msgs.push({
          role: 'user',
          content: [{ type: 'text', text: m.content }, ...req.images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b.toString('base64')}` } }))],
        });
      } else msgs.push({ role: m.role, content: m.content });
    });
    return msgs;
  }

  private async call(body: Record<string, unknown>): Promise<string> {
    let data: any;
    try {
      data = await httpJson(`${trimSlash(this.cfg.baseUrl ?? 'https://api.openai.com/v1')}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ...body, ...(this.cfg.extraBody ?? {}) }),
        timeoutMs: this.cfg.timeoutMs,
      });
    } catch (e) {
      // Retrying can't help when the server's context window is too small; say what to change.
      if (/exceeds the available context size|Context size has been exceeded|context_length_exceeded|maximum context length/i.test((e as Error).message))
        throw new GenAIError(`Context window too small for this request (prompt + ${body.max_tokens ?? '?'} output tokens). For llama.cpp, start the server with --parallel 1 --ctx-size 16384 or more.`, false);
      throw e;
    }
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.length) return content;
    if (Array.isArray(content)) return content.map((p: any) => p.text ?? '').join('');
    // Some reasoning servers put everything in reasoning_content when the budget runs out.
    if (choice?.message?.reasoning_content) throw new GenAIError('Model returned only reasoning (increase maxTokens)');
    throw new GenAIError(`Empty completion: ${JSON.stringify(data).slice(0, 300)}`);
  }

  text(req: TextRequest, model?: string, extra?: Record<string, unknown>): Promise<string> {
    return this.call({ model: model ?? this.cfg.model, messages: this.messages(req), temperature: req.temperature, max_tokens: req.maxTokens, ...extra });
  }

  structured(req: StructuredRequest, model?: string, extra?: Record<string, unknown>): Promise<string> {
    const mode = this.cfg.structured ?? 'json_schema';
    const body: Record<string, unknown> = { model: model ?? this.cfg.model, temperature: req.temperature, max_tokens: req.maxTokens, ...extra };
    if (mode === 'json_schema') {
      body.messages = this.messages(req, schemaInstruction(req));
      body.response_format = { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema, strict: false } };
    } else if (mode === 'json_object') {
      body.messages = this.messages(req, schemaInstruction(req));
      body.response_format = { type: 'json_object' };
    } else body.messages = this.messages(req, schemaInstruction(req));
    return this.call(body);
  }
}

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
    const key = resolveSecret(this.cfg.apiKey);
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

  structured(req: StructuredRequest, model?: string, extra?: Record<string, unknown>) {
    const mode = this.cfg.structured ?? 'strict';
    // Strict structured outputs: the schema is enforced while decoding (see strictSchema for what that covers).
    if (mode === 'strict') return this.call(req, model, { type: 'json_schema', name: req.schemaName, schema: strictSchema(req.schema as never), strict: true }, extra);
    if (mode === 'json_schema') return this.call(req, model, { type: 'json_schema', name: req.schemaName, schema: req.schema, strict: false }, extra);
    return this.call({ ...req, system: (req.system ?? '') + schemaInstruction(req) }, model, mode === 'json_object' ? { type: 'json_object' } : undefined, extra);
  }
}

// ---------------------------------------------------------------------------- Anthropic (official SDK)

/** Anthropic structured outputs require closed objects. */
function closeObjects(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closeObjects);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === '$schema') continue;
    out[k] = closeObjects(v);
  }
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

export class AnthropicProvider implements TextProvider {
  private client: Anthropic;
  constructor(private cfg: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: resolveSecret(cfg.apiKey) ?? process.env.ANTHROPIC_API_KEY,
      baseURL: cfg.baseUrl,
      timeout: cfg.timeoutMs ?? 600_000,
      maxRetries: 2,
    });
  }

  private params(req: TextRequest, model?: string) {
    const content: Anthropic.ContentBlockParam[] = [];
    const msgs: Anthropic.MessageParam[] = req.messages.map((m, i) => {
      const isLastUser = i === req.messages.length - 1 && m.role === 'user';
      if (isLastUser && req.images?.length) {
        for (const img of req.images) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.toString('base64') } });
        content.push({ type: 'text', text: m.content });
        return { role: 'user', content };
      }
      return { role: m.role, content: m.content };
    });
    return {
      model: model ?? this.cfg.model ?? 'claude-opus-5-5',
      max_tokens: Math.max(req.maxTokens ?? 16000, 4000),
      system: req.system,
      messages: msgs,
    };
  }

  /** Uses the beta endpoint so server-side refusal fallbacks are enabled (disable with fallbacks: false in extraBody). */
  private async create(params: Record<string, unknown>): Promise<Anthropic.Message> {
    const { fallbacks, ...rest } = params as Record<string, unknown> & { fallbacks?: unknown };
    if (fallbacks === false) return this.client.messages.create(rest as unknown as Anthropic.MessageCreateParamsNonStreaming);
    return (await this.client.beta.messages.create({
      ...rest,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: fallbacks ?? 'default',
    } as never)) as unknown as Anthropic.Message;
  }

  private extract(res: Anthropic.Message): string {
    if (res.stop_reason === 'refusal') throw new GenAIError('Model declined the request', false);
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    if (!text) throw new GenAIError(`Empty response (stop_reason=${res.stop_reason})`);
    return text;
  }

  async text(req: TextRequest, model?: string, extra?: Record<string, unknown>) {
    const res = await this.create({ ...this.params(req, model), ...(this.cfg.extraBody ?? {}), ...extra });
    return this.extract(res);
  }

  async structured(req: StructuredRequest, model?: string, extra?: Record<string, unknown>) {
    if (this.cfg.structured === 'prompt') return this.text({ ...req, system: (req.system ?? '') + schemaInstruction(req) }, model, extra);
    const res = await this.create({
      ...this.params(req, model),
      output_config: { format: { type: 'json_schema', schema: closeObjects(req.schema) as Record<string, unknown> } },
      ...(this.cfg.extraBody ?? {}),
      ...extra,
    });
    return this.extract(res);
  }
}

// ---------------------------------------------------------------------------- Google Gemini

export class GoogleProvider implements TextProvider {
  constructor(private cfg: ProviderConfig) {}

  private async call(model: string, body: Record<string, unknown>): Promise<any> {
    const key = resolveSecret(this.cfg.apiKey) ?? process.env.GEMINI_API_KEY;
    const base = trimSlash(this.cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta');
    return httpJson(`${base}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-goog-api-key': key } : {}), ...(this.cfg.headers ?? {}) },
      body: JSON.stringify({ ...body, ...(this.cfg.extraBody ?? {}) }),
      timeoutMs: this.cfg.timeoutMs,
    });
  }

  private contents(req: TextRequest) {
    return req.messages.map((m, i) => {
      const parts: any[] = [{ text: m.content }];
      if (i === req.messages.length - 1 && m.role === 'user' && req.images?.length)
        for (const img of req.images) parts.push({ inlineData: { mimeType: 'image/png', data: img.toString('base64') } });
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });
  }

  private text_(data: any): string {
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const t = parts.filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('');
    if (!t) throw new GenAIError(`Empty Gemini response: ${JSON.stringify(data).slice(0, 300)}`);
    return t;
  }

  async text(req: TextRequest, model?: string, extra?: Record<string, unknown>) {
    const data = await this.call(model ?? this.cfg.model ?? 'gemini-2.5-flash', {
      systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
      contents: this.contents(req),
      generationConfig: { temperature: req.temperature, maxOutputTokens: req.maxTokens },
      ...extra,
    });
    return this.text_(data);
  }

  async structured(req: StructuredRequest, model?: string, extra?: Record<string, unknown>) {
    const native = (this.cfg.structured ?? 'json_schema') === 'json_schema';
    const data = await this.call(model ?? this.cfg.model ?? 'gemini-2.5-flash', {
      systemInstruction: { parts: [{ text: (req.system ?? '') + (native ? '' : schemaInstruction(req)) }] },
      contents: this.contents(req),
      generationConfig: {
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens,
        responseMimeType: 'application/json',
        ...(native ? { responseJsonSchema: req.schema } : {}),
      },
      ...extra,
    });
    return this.text_(data);
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
    const base = trimSlash(this.cfg.baseUrl ?? 'http://127.0.0.1:8188');
    const workflow = this.fill(this.template, {
      prompt: req.prompt,
      seed: req.seed,
      width: req.width,
      height: req.height,
      checkpoint: model ?? this.cfg.checkpoint ?? this.cfg.model ?? 'krea2_turbo_fp8_scaled.safetensors',
      steps: this.cfg.steps ?? 8,
      cfg: this.cfg.cfg ?? 1,
      cutter: this.cfg.cutter ?? 'birefnet.safetensors',
    });
    return this.run(base, workflow);
  }

  /** Queue a workflow and wait for its first image. */
  private async run(base: string, workflow: unknown): Promise<Buffer> {
    const queued = await httpJson(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: promptBody(workflow, 'image'),
      timeoutMs: 30_000,
    });
    const id = queued.prompt_id as string;
    if (!id) throw new GenAIError(`ComfyUI did not queue the prompt: ${JSON.stringify(queued).slice(0, 300)}`);
    const deadline = Date.now() + (this.cfg.timeoutMs ?? 300_000);
    const cancelled = callContext()?.cancelled;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 750));
      if (cancelled?.()) {
        await dropPrompt(base, id).catch(() => undefined);
        throw new GenAIError('cancelled', false);
      }
      const hist = await httpJson(`${base}/history/${id}`, { method: 'GET', timeoutMs: 15_000 });
      const entry = hist[id];
      if (!entry) continue;
      if (entry.status?.status_str === 'error') throw new GenAIError(`ComfyUI error: ${JSON.stringify(entry.status).slice(0, 400)}`);
      for (const out of Object.values(entry.outputs ?? {}) as any[]) {
        const img = out.images?.[0];
        if (img) {
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
          const res = await fetch(`${base}/view?${q}`);
          if (!res.ok) throw new GenAIError(`ComfyUI view failed: ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        }
      }
    }
    throw new GenAIError('ComfyUI timed out');
  }
}

// ---------------------------------------------------------------------------- llama.cpp decision models

/** Decision models answer choice / score / yes-no questions with probabilities (llama.cpp `/v1/systemone`). */
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

export class LlamaDecisionProvider implements DecisionProvider {
  constructor(private cfg: ProviderConfig) {}
  async decide(req: DecisionRequest, model?: string): Promise<Record<string, DecisionAnswer>> {
    const base = trimSlash(this.cfg.baseUrl ?? 'http://127.0.0.1:8080').replace(/\/v1$/, '');
    const data = await httpJson(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cfg.headers ?? {}) },
      body: JSON.stringify({
        model: model ?? this.cfg.model,
        state: req.state,
        questions: req.questions,
        images: req.images?.map((b) => `data:image/png;base64,${b.toString('base64')}`),
        ...(this.cfg.extraBody ?? {}),
      }),
      timeoutMs: this.cfg.timeoutMs ?? 120_000,
    });
    if (!data?.answers || typeof data.answers !== 'object') throw new GenAIError(`Decision model returned no answers: ${JSON.stringify(data).slice(0, 300)}`);
    return data.answers as Record<string, DecisionAnswer>;
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
