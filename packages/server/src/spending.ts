/**
 * Budgets for paid models. Each user has a monthly one (set by an administrator, $10 unless changed; administrators
 * are unlimited unless the configuration says otherwise), and the whole server has a daily ceiling, so one key cannot
 * be run up by anyone. Plugged into the model gateway in every process that calls models (web server and worker).
 */
import { setSpendLedger } from './genai/spend';
import { genai } from './genai/service';
import { getUser, recordSpend, spentThisMonth, spentTodayTotal } from './storage';

/** A user's monthly budget in dollars (Infinity when unlimited). */
export function monthlyBudgetFor(userId: string): number {
  const u = getUser(userId);
  if (!u) return 0;
  if (u.isAdmin && genai().config.spending?.adminsUnlimited !== false) return Infinity;
  return u.monthlyBudgetUsd;
}

export function installSpendLedger() {
  setSpendLedger({
    record: (userId, usd) => recordSpend(userId, usd),
    refusal: (userId) => {
      const s = genai().config.spending ?? {};
      if (s.dailyTotalUsd !== undefined && spentTodayTotal() >= s.dailyTotalUsd) return 'The server has used its AI budget for today. It resets at midnight.';
      if (userId === 'system') return null;
      const budget = monthlyBudgetFor(userId);
      if (spentThisMonth(userId).usd >= budget) return `You have used your AI budget for this month ($${budget.toFixed(2)}). It starts again on the 1st.`;
      return null;
    },
  });
}
