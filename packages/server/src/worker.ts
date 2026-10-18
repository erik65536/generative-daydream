/**
 * The job worker as its own process: builds worlds, paints, runs studio tasks. Restarting the web server never
 * touches it; restarting it re-queues its jobs at their next safe point and they resume from checkpoints.
 *
 *   npm run worker -w @gd/server
 *
 * In development `npm run dev` runs it and restarts it when server code changes: a change touches
 * data/.worker-reload, and the worker then pauses its jobs at the next safe point and exits with code 75
 * (the dev script starts it again with the new code).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths';
import { startWorker } from './jobs/worker';
import { HOLDER } from './jobs/queue';
import { genai } from './genai/service';

export const RELOAD_FILE = path.join(DATA_DIR, '.worker-reload');
const mtime = () => {
  try {
    return fs.statSync(RELOAD_FILE).mtimeMs;
  } catch {
    return 0;
  }
};

const worker = startWorker();
console.log(`[worker ${HOLDER}] ready; running up to ${genai().config.jobConcurrency ?? 1} job(s) at a time`);

let stopping = false;
async function stop(code: number, why: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${why}${worker.busy() ? `; pausing ${worker.busy()} job(s) at their next safe point…` : ''}`);
  await worker.drain();
  process.exit(code);
}

const seen = mtime();
setInterval(() => {
  if (mtime() !== seen) void stop(75, 'code changed, restarting');
}, 1000);
process.on('SIGINT', () => void stop(0, 'stopping'));
process.on('SIGTERM', () => void stop(0, 'stopping'));
