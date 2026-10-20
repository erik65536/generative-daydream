/** Provider-agnostic GenAI interfaces. Every purpose in the engine goes through these. */

export const PURPOSES = [
  'world.design', // concept, atlas, story — needs the smartest model
  'world.content', // per-place people, quests, lore — many calls
  'npc.decision', // structured NPC action choice at runtime
  'npc.dialogue', // optional separate spoken-response model
  'narration', // flavor text for actions, quest updates
  'image.sprite', // characters, monsters, objects
  'image.icon', // item icons
  'image.check', // vision model judging generated images
  'image.prompt', // LLM that turns asset briefs into Krea prompts and picks each one's chroma-key backdrop
  'speech.input', // speech-to-text: what a player says to the people of the world
] as const;
export type Purpose = (typeof PURPOSES)[number];

export type ProviderType = 'procedural' | 'openai-chat' | 'openai-responses' | 'anthropic' | 'google' | 'comfyui' | 'llamacpp-decision' | 'openai-decision' | 'openai-transcribe';

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  /** Literal key, or "env:VAR_NAME". */
  apiKey?: string;
  model?: string;
  /** How to request JSON: native schema, JSON mode, or by prompting only. */
  structured?: 'strict' | 'json_schema' | 'json_object' | 'prompt';
  timeoutMs?: number;
  /** Max parallel requests to this provider. */
  concurrency?: number;
  /** OpenAI: processing tier ("flex" is half price and slower; busy flex capacity is waited out, not billed). */
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  /** Prices in dollars per million tokens (cached input defaults to a tenth, output to five times input). Paid providers are metered against users' daily budgets. */
  pricing?: { inputPerM: number; cachedPerM?: number; outputPerM?: number; perMinute?: number };
  /** Prices for other models asked of this provider per call (e.g. a stronger fallback model), by model name. */
  modelPricing?: Record<string, { inputPerM: number; cachedPerM?: number; outputPerM?: number }>;
  /** Reasoning models: output tokens added to every request's limit for the model's thinking (billed only when used). */
  reasoningTokens?: number;
  /** Extra body parameters merged into every request (e.g. top_p, reasoning settings). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** ComfyUI: path to an API-format workflow JSON with {{placeholders}} (assets: the painting with the cutter mask as alpha). */
  workflow?: string;
  /** ComfyUI: checkpoint/model name substituted into {{checkpoint}}. */
  checkpoint?: string;
  steps?: number;
  cfg?: number;
  /** Strip <think>...</think> blocks emitted by reasoning models. */
  stripThinking?: boolean;
  /** ComfyUI: background-removal model substituted into {{cutter}} (default birefnet.safetensors). */
  cutter?: string;
  /** Supports image inputs (for image.check). */
  vision?: boolean;
  /**
   * Name of an exclusive GPU group. Providers in the same group never have models resident at the same time:
   * the scheduler unloads the previous model (llama.cpp router /models/unload, ComfyUI /free) before switching.
   */
  gpu?: string;
}

export interface PurposeConfig {
  provider: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  /** A stronger model of the same provider to fall back to when an answer is not good enough (null: no fallback). */
  strongModel?: string | null;
  /** image.check: minimum score (0-10) to accept an image. */
  minScore?: number;
  /** image.*: max generation attempts per asset. */
  maxAttempts?: number;
  /** image.*: generation size. */
  width?: number;
  height?: number;
  extraBody?: Record<string, unknown>;
}

export interface GenAIConfig {
  providers: Record<string, ProviderConfig>;
  purposes: Partial<Record<Purpose, PurposeConfig>>;
  /** Combine NPC decision + speech in one call (faster on local models). */
  combineNpcDecisionAndDialogue: boolean;
  /** Max parallel zone-content generations during world creation. */
  worldGenParallelism: number;
  /** Unload a GPU-group model after this long without use (ms). 0 = keep loaded. */
  gpuIdleUnloadMs?: number;
  /** Jobs (world builds, painting, studio tasks) one worker runs at once. Default 1: a single local GPU. */
  jobConcurrency?: number;
  /** How long background work waits for a busy, rate-limited or unreachable model before failing (ms). */
  waitForModelsMs?: number;
  /** Daily budgets for paid models, in dollars: per user (an admin can set each user's own) and for the whole server. */
  spending?: { dailyPerUserUsd?: number; dailyTotalUsd?: number; adminsUnlimited?: boolean };
  /** Actor animation (packages/server/animator): mesh, rig and clip sheets for characters and creatures. */
  animation?: AnimationConfig;
}

export interface AnimationConfig {
  /** A Python with numpy, scipy and Pillow (ComfyUI's embedded Python has them). */
  python: string;
  /** Humanoid clip library: a glTF with UE-style bone names (Quaternius Universal Animation Library). */
  library: string;
  /** SkinTokens checkout and its own Python, for bodies other than humanoids. Without it, those keep their still image. */
  skintokens?: { dir: string; python: string; device?: 'cuda' | 'cpu' };
  /** The ComfyUI provider meshing runs on (default: the first comfyui provider). */
  comfyProvider?: string;
  /** Sheet pixels per game picture pixel (default 2). */
  scale?: number;
}

// ------------------------------------------------------------------------------- decision models

/** Questions for decision models (llama.cpp /v1/systemone). Each is answered independently. */
export type DecisionQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string };

export type DecisionAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number };

export interface DecisionRequest {
  state: string | ChatMessage[];
  questions: Record<string, DecisionQuestion>;
  images?: Buffer[];
}

export interface DecisionProvider {
  decide(req: DecisionRequest, model?: string): Promise<Record<string, DecisionAnswer>>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TextRequest {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Image attachments (PNG) for vision-capable models. */
  images?: Buffer[];
}

export interface StructuredRequest extends TextRequest {
  schema: Record<string, unknown>;
  schemaName: string;
}

export interface ImageRequest {
  prompt: string;
  width: number;
  height: number;
  seed: number;
}

export interface TextProvider {
  text(req: TextRequest, model?: string, extra?: Record<string, unknown>): Promise<string>;
  /** Returns raw text that should contain JSON matching the schema. */
  structured(req: StructuredRequest, model?: string, extra?: Record<string, unknown>): Promise<string>;
}

export interface ImageProvider {
  generate(req: ImageRequest, model?: string): Promise<Buffer>;
}

export class GenAIError extends Error {
  constructor(message: string, public readonly retryable = true) {
    super(message);
  }
}

export class ProceduralOnly extends Error {
  constructor() {
    super('Purpose is configured as procedural');
  }
}
