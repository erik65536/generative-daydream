/**
 * Balancing is minutes of solid simulation. On a worker thread it leaves the rest of a build (Luna's calls, the
 * GPU queue) running meanwhile instead of freezing the process.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { BalanceReport, Ruleset } from '@gd/shared';
import { balanceRuleset, type BalanceOptions } from './balance';

type Message = { progress: [string, number] } | { done: { ruleset: Ruleset; report: BalanceReport } } | { error: string };

/** Balance a copy of `r` on another thread; resolves with the balanced ruleset. */
export function balanceOffThread(r: Ruleset, opts: BalanceOptions): Promise<{ ruleset: Ruleset; report: BalanceReport }> {
  const { onProgress, ...rest } = opts;
  // Tests run TypeScript without a loader a worker could inherit.
  if (process.env.VITEST) return Promise.resolve({ ruleset: r, report: balanceRuleset(r, opts) });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { ruleset: r, opts: rest } });
    worker.on('message', (m: Message) => {
      if ('progress' in m) onProgress?.(...m.progress);
      else if ('done' in m) resolve(m.done);
      else reject(new Error(m.error));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => code && reject(new Error(`the balancing thread stopped (${code})`)));
  });
}

if (!isMainThread && parentPort && workerData?.ruleset) {
  const port = parentPort;
  const { ruleset, opts } = workerData as { ruleset: Ruleset; opts: BalanceOptions };
  try {
    const report = balanceRuleset(ruleset, { ...opts, onProgress: (msg, frac) => port.postMessage({ progress: [msg, frac] } satisfies Message) });
    port.postMessage({ done: { ruleset, report } } satisfies Message);
  } catch (e) {
    port.postMessage({ error: (e as Error).message } satisfies Message);
  }
}
