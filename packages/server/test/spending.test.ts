import { describe, expect, it } from 'vitest';
import { checkBudget, costOf, chargeUsage, BudgetExceeded } from '../src/genai/spend';
import { withCallContext } from '../src/genai/context';
import { genai } from '../src/genai/service';
import { installSpendLedger } from '../src/spending';
import { inviteUser, setDailyLimit, spentToday } from '../src/storage';
import type { ProviderConfig } from '../src/genai/types';

const paid: ProviderConfig = { type: 'openai-responses', model: 'gpt-6-luna', pricing: { inputPerM: 1, cachedPerM: 0.1, outputPerM: 5 } };

describe('AI spending', () => {
  it('prices calls from the provider, halves flex, and ignores local models', () => {
    expect(costOf(paid, { input: 1_000_000, cached: 0, output: 0 })).toBeCloseTo(1);
    expect(costOf(paid, { input: 1_000_000, cached: 1_000_000, output: 200_000 })).toBeCloseTo(0.1 + 1);
    expect(costOf({ ...paid, serviceTier: 'flex' }, { input: 1_000_000 })).toBeCloseTo(0.5);
    expect(costOf({ type: 'openai-chat', baseUrl: 'http://127.0.0.1:1' }, { input: 1_000_000 })).toBe(0);
  });

  it('prices a model asked for by name at its own price, not the provider’s', () => {
    const luna: ProviderConfig = { type: 'openai-responses', model: 'gpt-6-luna', serviceTier: 'flex' };
    // gpt-6.1-sol list prices: $2 input, $0.10 cached, $10 output per million; flex halves them.
    expect(costOf(luna, { input: 1_000_000, cached: 500_000, output: 100_000 }, 'gpt-6.1-sol')).toBeCloseTo(0.5 * (1 + 0.05 + 1));
    expect(costOf(luna, { input: 1_000_000 }, 'gpt-6-luna')).toBeCloseTo(0.05);
    expect(costOf({ ...luna, modelPricing: { 'gpt-6.1-sol': { inputPerM: 4 } } }, { input: 1_000_000 }, 'gpt-6.1-sol')).toBeCloseTo(2);
  });

  it('charges the user a call is for and refuses them past their daily budget', () => {
    genai().config.spending = { dailyPerUserUsd: 0.01, dailyTotalUsd: 1000 };
    installSpendLedger();
    const u = inviteUser(`t_spend_${Date.now().toString(36)}`).user;
    withCallContext({ priority: 'interactive', userId: u.id }, () => {
      expect(() => checkBudget(paid)).not.toThrow();
      chargeUsage(paid, { input: 6000 });
      chargeUsage(paid, { input: 6000 });
      expect(spentToday(u.id).usd).toBeCloseTo(0.012);
      expect(() => checkBudget(paid)).toThrow(BudgetExceeded);
      // An administrator raises this player's own budget.
      setDailyLimit(u.id, 1);
      expect(() => checkBudget(paid)).not.toThrow();
    });
    // Local models are never refused.
    withCallContext({ priority: 'interactive', userId: u.id }, () => {
      setDailyLimit(u.id, 0);
      expect(() => checkBudget({ type: 'openai-chat' })).not.toThrow();
    });
  });
});
