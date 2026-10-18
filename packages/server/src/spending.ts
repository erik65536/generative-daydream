/**
 * Daily budgets for paid models. Each user has one (an administrator's per-user setting, else the server
 * default), and the whole server has a ceiling, so one key cannot be run up by anyone. Plugged into the model
 * gateway in every process that calls models (web server and worker).
 */
import { setSpendLedger } from './genai/spend';
import { genai } from './genai/service';
import { getUser, recordSpend, spentToday, spentTodayTotal } from './storage';

/** A user's daily budget in dollars (Infinity when unlimited). */
export function dailyLimitFor(userId: string): number {
  const s = genai().config.spending ?? {};
  const u = getUser(userId);
  if (u?.dailyLimitUsd !== null && u?.dailyLimitUsd !== undefined) return u.dailyLimitUsd;
  if (u?.isAdmin && s.adminsUnlimited !== false) return Infinity;
  return s.dailyPerUserUsd ?? Infinity;
}

export function installSpendLedger() {
  setSpendLedger({
    record: (userId, usd) => recordSpend(userId, usd),
    refusal: (userId) => {
      const s = genai().config.spending ?? {};
      if (s.dailyTotalUsd !== undefined && spentTodayTotal() >= s.dailyTotalUsd) return 'The server has used its AI budget for today. It resets at midnight.';
      if (userId === 'system') return null;
      const limit = dailyLimitFor(userId);
      if (spentToday(userId).usd >= limit) return `You have used your AI budget for today ($${limit.toFixed(2)}). It resets at midnight.`;
      return null;
    },
  });
}
