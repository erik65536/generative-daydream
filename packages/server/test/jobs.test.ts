import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { globalDb, loadWorld } from '../src/storage';
import { activeJob, claimNext, enqueue, enqueueAnimation, getJobRecord, JobConflict, latestJob, logTail, requestCancel } from '../src/jobs/queue';
import { Job, JobYield, workerState } from '../src/jobs/job';
import { startWorker } from '../src/jobs/worker';
import { runGeneration, startWorldGeneration } from '../src/worldgen/pipeline';
import { mockModels, plainPlaces, validateWorld, type MockModels } from './helpers';

const owner = { id: 'u_jobs', name: 'Jobs' };
const input = { theme: 'A drowned city of bell towers and lantern boats.', size: 'small' as const, length: 'short' as const, communication: 2 as const, combatMode: 'solo' as const };
const wid = () => `w_jt_${crypto.randomBytes(4).toString('hex')}`;
const expireLease = (id: string) => globalDb().prepare('UPDATE jobs SET lease_until = 1 WHERE id = ?').run(id);

describe('durable jobs', () => {
  // Only this file makes jobs; leftovers from earlier runs would be claimed first.
  let models: MockModels, restore: () => void;
  beforeAll(async () => {
    globalDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE status IN ('queued', 'running', 'waiting')`).run();
    models = await mockModels();
    restore = plainPlaces();
  });
  afterAll(() => {
    restore();
    models.stop();
  });

  it('queues one job per world, leases it, and hands it to another worker when the lease runs out', () => {
    const w = wid();
    const rec = enqueue('art', w, owner, { level: 'full' }, { priority: 0 });
    expect(rec.status).toBe('queued');
    expect(() => enqueue('art', w, owner, {})).toThrow(JobConflict);
    const claimed = claimNext('worker-a');
    expect(claimed?.id).toBe(rec.id);
    expect(claimed?.status).toBe('running');
    expect(claimNext('worker-b')?.id).not.toBe(rec.id);
    expireLease(rec.id); // worker-a died
    const again = claimNext('worker-b');
    expect(again?.id).toBe(rec.id);
    expect(again?.attempts).toBe(2);
    requestCancel(rec.id);
    expect(getJobRecord(rec.id)?.cancelRequested).toBe(true);
    globalDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(rec.id);
  });

  it('a build paused at a safe point resumes from its checkpoints and makes the same world', async () => {
    const w = wid();
    const rec = enqueue('world', w, owner, { input, seed: 'resume-seed' }, { priority: -10 });
    globalDb().prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(rec.id);
    // First run: the worker is asked to restart when the story stage begins.
    class Restarting extends Job {
      begin(id: string, counts?: { done?: number; total?: number }) {
        if (id === 'story') workerState.yieldRequested = true;
        super.begin(id, counts);
      }
    }
    const first = new Restarting(w, input, owner, getJobRecord(rec.id));
    await expect(runGeneration(first, 'resume-seed')).rejects.toBeInstanceOf(JobYield);
    workerState.yieldRequested = false;
    const conceptBefore = first.preview.title;
    // Second run (a fresh worker): earlier steps come from checkpoints.
    const second = new Job(w, input, owner, getJobRecord(rec.id));
    await runGeneration(second, 'resume-seed');
    second.finish('done');
    expect(second.log.some((l) => l.msg.startsWith('Concept: kept'))).toBe(true);
    expect(second.preview.title).toBe(conceptBefore);
    const world = loadWorld(w)!;
    expect(world.status).toBe('ready');
    expect(validateWorld(world)).toEqual([]);
    expect(getJobRecord(rec.id)?.status).toBe('done');
    expect(logTail(rec.id).length).toBeGreaterThan(5);
  });

  it('a worker builds a queued world end to end', async () => {
    const { worldId } = startWorldGeneration(input, owner);
    expect(loadWorld(worldId)?.status).toBe('generating');
    const worker = startWorker({ quiet: true });
    try {
      for (let i = 0; i < 120 && loadWorld(worldId)?.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 500));
      for (let i = 0; i < 20 && globalDb().prepare('SELECT status FROM jobs WHERE world_id = ?').get(worldId)?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 250));
    } finally {
      await worker.drain();
      workerState.yieldRequested = false;
    }
    expect(loadWorld(worldId)?.status).toBe('ready');
    expect((globalDb().prepare('SELECT status FROM jobs WHERE world_id = ?').get(worldId) as { status: string }).status).toBe('done');
  });

  it('when one of two stages running together ends, the other is what the job shows it is doing', () => {
    const job = new Job(wid(), input, owner);
    job.plan([{ id: 'places', label: 'Painting places' }, { id: 'balance', label: 'Balancing' }]);
    job.begin('places');
    job.push('Painting places', 'step');
    job.begin('balance');
    job.push('Balancing', 'step');
    expect(job.step).toBe('Balancing');
    job.end('balance');
    expect(job.step).toBe('Painting places');
    // A resumed build passes stages it finished before; they announce themselves and end again.
    job.push('Balancing', 'step');
    job.end('balance');
    expect(job.step).toBe('Painting places');
  });

  it('animation runs beside the world jobs, queued once, after them', () => {
    const w = wid();
    enqueueAnimation(w, owner);
    enqueueAnimation(w, owner);
    const anims = globalDb().prepare(`SELECT id, priority FROM jobs WHERE world_id = ? AND kind = 'animate' AND status = 'queued'`).all(w) as { id: string; priority: number }[];
    expect(anims).toHaveLength(1);
    // It neither blocks nor shows as the world's job.
    expect(activeJob(w)).toBeUndefined();
    expect(latestJob(w)).toBeUndefined();
    const art = enqueue('art', w, owner, { level: 'full' }, { priority: 5 });
    expect(activeJob(w)?.id).toBe(art.id);
    // Everything else is claimed first.
    expect(claimNext('t-anim')?.id).toBe(art.id);
    expect(claimNext('t-anim')?.id).toBe(anims[0]!.id);
    globalDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE world_id = ?`).run(w);
  });
});
