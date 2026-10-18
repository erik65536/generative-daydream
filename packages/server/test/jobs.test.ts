import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { globalDb, loadWorld } from '../src/storage';
import { claimNext, enqueue, getJobRecord, JobConflict, logTail, requestCancel } from '../src/jobs/queue';
import { Job, JobYield, workerState } from '../src/jobs/job';
import { startWorker } from '../src/jobs/worker';
import { runGeneration, startWorldGeneration } from '../src/worldgen/pipeline';
import { validateWorld } from './helpers';

const owner = { id: 'u_jobs', name: 'Jobs' };
const input = { setting: 'A drowned city of bell towers and lantern boats.', size: 'small' as const, length: 'short' as const, communication: 2 as const, combatMode: 'solo' as const, art: 'none' as const };
const wid = () => `w_jt_${crypto.randomBytes(4).toString('hex')}`;
const expireLease = (id: string) => globalDb().prepare('UPDATE jobs SET lease_until = 1 WHERE id = ?').run(id);

describe('durable jobs', () => {
  // Only this file makes jobs; leftovers from earlier runs would be claimed first.
  beforeAll(() => void globalDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE status IN ('queued', 'running', 'waiting')`).run());

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
      phase(id: string, counts?: { done?: number; total?: number }) {
        if (id === 'story') workerState.yieldRequested = true;
        super.phase(id, counts);
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
});
