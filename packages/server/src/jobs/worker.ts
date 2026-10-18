/**
 * Runs queued jobs. Each claimed job holds a lease it renews while working; if this process stops, the lease
 * runs out and another worker (or this one, restarted) resumes the job from its checkpoints.
 *
 * Asked to restart (new code in development), the worker finishes in-flight steps, stops its jobs at their next
 * safe point, re-queues them and exits; the restarted worker continues them.
 */
import type { WorldDefinition } from '@gd/shared';
import { genai } from '../genai/service';
import { withCallContext } from '../genai/context';
import { loadWorld, saveWorld } from '../storage';
import { placeholderWorld, runArtJob, runGeneration, runRulesJob } from '../worldgen/pipeline';
import { runStudioJob, type StudioTask } from '../worldgen/studio';
import { Job, JobYield, workerState } from './job';
import { claimNext, HOLDER, purgeOldLogs, renewLease, requeue, type JobRecord } from './queue';

/** A job that keeps dying (crashes the worker, say) is given up after this many starts. */
const MAX_ATTEMPTS = 6;

async function execute(rec: JobRecord, job: Job): Promise<void> {
  const world = (): WorldDefinition => {
    const w = loadWorld(rec.worldId);
    if (!w) throw new Error('The daydream no longer exists.');
    return w;
  };
  const p = rec.params as Record<string, unknown>;
  switch (rec.kind) {
    case 'world':
      return runGeneration(job, p.seed as string);
    case 'rules':
      return runRulesJob(job, world(), p.mode === 'rebalance' ? 'rebalance' : 'regenerate');
    case 'art':
      return runArtJob(job, world(), p.level === 'full' ? 'full' : 'essential');
    case 'studio':
      return runStudioJob(job, world(), p.task as StudioTask);
  }
}

async function run(rec: JobRecord): Promise<void> {
  const input = rec.kind === 'world' ? (rec.params as { input: WorldDefinition['input'] }).input : loadWorld(rec.worldId)?.input;
  const job = new Job(rec.worldId, input ?? ({} as WorldDefinition['input']), { id: rec.ownerId, name: rec.ownerName }, rec);
  job.status = 'running';
  if (rec.attempts > 1) job.push(`Resuming (start ${rec.attempts})`, 'step');
  const renew = setInterval(() => renewLease(rec.id), 15_000);
  try {
    if (rec.attempts > MAX_ATTEMPTS) throw new Error(`stopped unexpectedly ${MAX_ATTEMPTS} times`);
    // The daydream's owner pays for its building, painting and studio work.
    await withCallContext({ priority: rec.kind === 'studio' ? 'studio' : 'background', onWait: (why) => job.waiting(why), userId: rec.ownerId }, () => execute(rec, job));
    job.finish(job.cancelled ? 'cancelled' : 'done');
  } catch (e) {
    if (e instanceof JobYield) {
      job.push('Paused for a worker restart; it continues where it left off.', 'step');
      job.flush();
      requeue(rec.id);
      return;
    }
    const msg = (e as Error).message;
    if (job.cancelled || msg === 'cancelled') {
      job.push('Stopped.', 'step');
      job.finish('cancelled');
    } else {
      console.error(`[worker] job ${rec.id} (${rec.kind} ${rec.worldId}) failed:`, e);
      job.push(`Failed: ${msg}`, 'error');
      job.finish('failed', msg);
    }
    // A world whose first build ended is marked so the lobby says so.
    if (rec.kind === 'world') {
      const w = loadWorld(rec.worldId);
      if (w && w.status === 'generating') {
        const failed = placeholderWorld(rec.worldId, (rec.params as { input: WorldDefinition['input'] }).input, { id: rec.ownerId, name: rec.ownerName });
        failed.status = 'failed';
        saveWorld(failed);
      }
    }
  } finally {
    clearInterval(renew);
  }
}

export interface Worker {
  /** Jobs running now. */
  busy(): number;
  /** Stop taking jobs, stop running ones at their next safe point, and wait for them (re-queued). */
  drain(): Promise<void>;
}

export function startWorker(opts: { concurrency?: number; quiet?: boolean } = {}): Worker {
  const max = Math.max(1, opts.concurrency ?? genai().config.jobConcurrency ?? 1);
  const running = new Set<Promise<void>>();
  let draining = false;
  const tick = () => {
    while (!draining && !workerState.yieldRequested && running.size < max) {
      const rec = claimNext();
      if (!rec) break;
      if (!opts.quiet) console.log(`[worker ${HOLDER}] ${rec.attempts > 1 ? 'resuming' : 'starting'} ${rec.kind} job ${rec.id} for ${rec.worldId}`);
      const p = run(rec).finally(async () => {
        running.delete(p);
        // Free the GPU once there is nothing left to do (the next job may need other models).
        if (!running.size) await genai().releaseGpu().catch(() => undefined);
      });
      running.add(p);
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  purgeOldLogs();
  return {
    busy: () => running.size,
    async drain() {
      draining = true;
      workerState.yieldRequested = true;
      clearInterval(timer);
      await Promise.allSettled([...running]);
    },
  };
}
