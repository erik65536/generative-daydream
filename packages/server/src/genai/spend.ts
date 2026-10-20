/**
 * Spending on paid (cloud) models: every call's cost is worked out from its provider's prices and charged to
 * whoever it was for (the user in the call context, or "system"), and calls are refused once a daily budget is
 * spent. The ledger itself lives in storage; it plugs in here so providers stay free of database code.
 */
import { callContext } from './context';
import type { ProviderConfig } from './types';
import { GenAIError } from './types';

export interface Usage { input?: number; cached?: number; output?: number; seconds?: number }

export interface SpendLedger {
  record(userId: string, usd: number): void;
  /** Why a user may not spend more today (or null when they may). */
  refusal(userId: string): string | null;
}

let ledger: SpendLedger | null = null;
export const setSpendLedger = (l: SpendLedger | null) => (ledger = l);

/** OpenAI list prices (standard tier, short context) of models asked for by name, per million tokens. */
const OPENAI_MODEL_PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
};

/**
 * Per-million-token prices: a model asked for by name (not the provider's own) at the provider's `modelPricing`
 * for it or its OpenAI list price; otherwise the provider's `pricing`, and OpenAI providers default to gpt-6-luna
 * list prices.
 */
export function pricesOf(cfg: ProviderConfig, model?: string): { input: number; cached: number; output: number } | null {
  const other = model && model !== cfg.model ? model : undefined;
  const mp = other ? cfg.modelPricing?.[other] : undefined;
  if (mp) return { input: mp.inputPerM, cached: mp.cachedPerM ?? mp.inputPerM / 10, output: mp.outputPerM ?? mp.inputPerM * 5 };
  if (other && (cfg.type === 'openai-responses' || cfg.type === 'openai-decision') && OPENAI_MODEL_PRICES[other]) return OPENAI_MODEL_PRICES[other];
  if (cfg.pricing) return { input: cfg.pricing.inputPerM, cached: cfg.pricing.cachedPerM ?? cfg.pricing.inputPerM / 10, output: cfg.pricing.outputPerM ?? cfg.pricing.inputPerM * 5 };
  if (cfg.type === 'openai-responses' || cfg.type === 'openai-decision') return { input: 0.1, cached: 0.01, output: 0.5 };
  // Transcription: audio input tokens and text output (gpt-4o-mini-transcribe list prices).
  if (cfg.type === 'openai-transcribe') return { input: 3, cached: 3, output: 5 };
  return null;
}

export const isMetered = (cfg: ProviderConfig) => !!pricesOf(cfg) && (cfg.pricing?.inputPerM ?? 1) > 0;

export function costOf(cfg: ProviderConfig, u: Usage, model?: string): number {
  const p = pricesOf(cfg, model);
  if (!p) return 0;
  // Audio billed by the minute (some transcription models report duration instead of tokens).
  if (u.seconds !== undefined) return (u.seconds / 60) * (cfg.pricing?.perMinute ?? 0.006);
  const tier = cfg.serviceTier === 'flex' ? 0.5 : 1;
  const input = u.input ?? 0, cached = Math.min(input, u.cached ?? 0);
  return (tier * ((input - cached) * p.input + cached * p.cached + (u.output ?? 0) * p.output)) / 1e6;
}

/** Charge a finished call to the user it ran for. */
export function chargeUsage(cfg: ProviderConfig, u: Usage, model?: string) {
  const usd = costOf(cfg, u, model);
  if (usd > 0) ledger?.record(callContext()?.userId ?? 'system', usd);
}

export class BudgetExceeded extends GenAIError {
  constructor(message: string) {
    super(message, false);
  }
}

/** Refuse a paid call when the user (or the whole server) has spent today's budget. */
export function checkBudget(cfg: ProviderConfig) {
  if (!ledger || !isMetered(cfg)) return;
  const why = ledger.refusal(callContext()?.userId ?? 'system');
  if (why) throw new BudgetExceeded(why);
}
