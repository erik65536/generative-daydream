import { describe, expect, it } from 'vitest';
import { checkBudget, costOf, chargeUsage, BudgetExceeded } from '../src/genai/spend';
import { withCallContext } from '../src/genai/context';
import { genai } from '../src/genai/service';
import { installSpendLedger } from '../src/spending';
import { setMonthlyBudget, spentThisMonth } from '../src/storage';
import { activeUser } from './helpers';
import type { ProviderConfig } from '../src/genai/types';

const paid: ProviderConfig = { type: 'openai-responses', model: 'gpt-6-luna', pricing: { inputPerM: 1, cachedPerM: 0.1, outputPerM: 5 } };

describe('AI spending', () => {
  it('prices calls from the provider, halves flex, and leaves the GPU free', () => {
    expect(costOf(paid, { input: 1_000_000, cached: 0, output: 0 })).toBeCloseTo(1);
    expect(costOf(paid, { input: 1_000_000, cached: 1_000_000, output: 200_000 })).toBeCloseTo(0.1 + 1);
    expect(costOf({ ...paid, serviceTier: 'flex' }, { input: 1_000_000 })).toBeCloseTo(0.5);
    expect(costOf({ type: 'comfyui', baseUrl: 'http://127.0.0.1:1' }, { input: 1_000_000 })).toBe(0);
  });

  it('prices a model asked for by name at its own price, not the provider’s', () => {
    const luna: ProviderConfig = { type: 'openai-responses', model: 'gpt-6-luna', serviceTier: 'flex' };
    // gpt-6.1-sol list prices: $2 input, $0.10 cached, $10 output per million; flex halves them.
    expect(costOf(luna, { input: 1_000_000, cached: 500_000, output: 100_000 }, 'gpt-6.1-sol')).toBeCloseTo(0.5 * (1 + 0.05 + 1));
    expect(costOf(luna, { input: 1_000_000 }, 'gpt-6-luna')).toBeCloseTo(0.05);
    expect(costOf({ ...luna, modelPricing: { 'gpt-6.1-sol': { inputPerM: 4 } } }, { input: 1_000_000 }, 'gpt-6.1-sol')).toBeCloseTo(2);
  });

  it('charges the user a call is for and refuses them past their monthly budget', () => {
    genai().config.spending = { dailyTotalUsd: 1000 };
    installSpendLedger();
    const u = activeUser();
    setMonthlyBudget(u.id, 0.01);
    withCallContext({ priority: 'interactive', userId: u.id }, () => {
      expect(() => checkBudget(paid)).not.toThrow();
      chargeUsage(paid, { input: 6000 });
      chargeUsage(paid, { input: 6000 });
      expect(spentThisMonth(u.id).usd).toBeCloseTo(0.012);
      expect(() => checkBudget(paid)).toThrow(BudgetExceeded);
      // An administrator raises this player's own budget.
      setMonthlyBudget(u.id, 1);
      expect(() => checkBudget(paid)).not.toThrow();
    });
    // Painting on the GPU (and a free provider) is never refused.
    withCallContext({ priority: 'interactive', userId: u.id }, () => {
      setMonthlyBudget(u.id, 0);
      expect(() => checkBudget({ type: 'comfyui' })).not.toThrow();
      expect(() => checkBudget({ ...paid, pricing: { inputPerM: 0 } })).not.toThrow();
    });
  });
});
