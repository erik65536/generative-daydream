/** Provider-agnostic GenAI interfaces. Every purpose in the engine goes through these. */

export const PURPOSES = [
  'world.design', // concept, atlas, story — needs the smartest model
  'world.content', // per-zone NPCs, quests, tilesets — many calls
  'npc.decision', // structured NPC action choice at runtime
  'npc.dialogue', // optional separate spoken-response model
  'narration', // flavor text for actions, quest updates
  'image.texture', // ground / wall textures
  'image.sprite', // characters, monsters, objects
  'image.icon', // item icons
  'image.check', // vision model judging generated images
] as const;
export type Purpose = (typeof PURPOSES)[number];

export type ProviderType = 'procedural' | 'openai-chat' | 'openai-responses' | 'anthropic' | 'google' | 'comfyui' | 'openai-image' | 'google-image';

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  /** Literal key, or "env:VAR_NAME". */
  apiKey?: string;
  model?: string;
  /** How to request JSON: native schema, JSON mode, or by prompting only. */
  structured?: 'json_schema' | 'json_object' | 'prompt';
  timeoutMs?: number;
  /** Max parallel requests to this provider. */
  concurrency?: number;
  /** Extra body parameters merged into every request (e.g. top_p, reasoning settings). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** ComfyUI: path to an API-format workflow JSON with {{placeholders}}. */
  workflow?: string;
  /** ComfyUI: checkpoint/model name substituted into {{checkpoint}}. */
  checkpoint?: string;
  steps?: number;
  cfg?: number;
  /** Strip <think>...</think> blocks emitted by reasoning models. */
  stripThinking?: boolean;
  /** Supports image inputs (for image.check). */
  vision?: boolean;
}

export interface PurposeConfig {
  provider: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  /** image.check: minimum score (0-10) to accept an image. */
  minScore?: number;
  /** image.*: max generation attempts per asset. */
  maxAttempts?: number;
  /** image.*: generation size. */
  width?: number;
  height?: number;
  negativePrompt?: string;
  extraBody?: Record<string, unknown>;
}

export interface GenAIConfig {
  providers: Record<string, ProviderConfig>;
  purposes: Partial<Record<Purpose, PurposeConfig>>;
  /** Combine NPC decision + speech in one call (faster on local models). */
  combineNpcDecisionAndDialogue: boolean;
  /** Max parallel zone-content generations during world creation. */
  worldGenParallelism: number;
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
  negativePrompt?: string;
  width: number;
  height: number;
  seed: number;
  /** Hint for providers that support transparent backgrounds. */
  transparent?: boolean;
}

export interface TextProvider {
  text(req: TextRequest, model?: string, extra?: Record<string, unknown>): Promise<string>;
  /** Returns raw text that should contain JSON matching the schema. */
  structured(req: StructuredRequest, model?: string, extra?: Record<string, unknown>): Promise<string>;
}

export interface ImageProvider {
  generate(req: ImageRequest, model?: string, extra?: Record<string, unknown>): Promise<Buffer>;
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
