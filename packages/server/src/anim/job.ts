/**
 * The animation job: one actor per run, then it queues itself again while actors wait, so a world's other jobs
 * (a build, the studio) take turns with it rather than waiting hours. It runs beside them: a world's one-job rule
 * does not apply to it, and it saves only its actor's records onto the world as it is on disk at that moment.
 *
 * Order: what the owner asked for in the studio, the heroes, the people and creatures of the first place, then
 * everyone else by place, bosses last.
 * An actor that fails keeps its still image; it is tried again only once its picture changes (or on request).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AssetRecord, WorldDefinition } from '@gd/shared';
import type { Job as WorldGenJob } from '../jobs/job';
import { loadWorld, saveWorld, worldAssetDir } from '../storage';
import { enqueueAnimation } from '../jobs/queue';
import { actorSprites, bodyPlan, needsAnimation } from './actors';
import { animateActor, animationConfig, jobDir, saveAnimation, type AnimateOptions } from './animator';

/** A redo asked for in the studio (from which step), kept in the actor's job directory until done. */
const redoFile = (worldId: string, key: string) => path.join(jobDir(worldId, key), 'redo.json');
/** A failure for this picture: not tried again until the picture changes or a redo is asked for. */
const failFile = (worldId: string, key: string) => path.join(jobDir(worldId, key), 'failed.json');

export function requestRedo(worldId: string, key: string, from: NonNullable<AnimateOptions['redoFrom']>) {
  fs.mkdirSync(jobDir(worldId, key), { recursive: true });
  fs.writeFileSync(redoFile(worldId, key), JSON.stringify({ from }));
  fs.rmSync(failFile(worldId, key), { force: true });
}

function failedFor(worldId: string, rec: AssetRecord): boolean {
  try {
    return (JSON.parse(fs.readFileSync(failFile(worldId, rec.key), 'utf8')) as { file?: string }).file === rec.file;
  } catch {
    return false;
  }
}

function redoOf(worldId: string, key: string): AnimateOptions['redoFrom'] | undefined {
  try {
    return (JSON.parse(fs.readFileSync(redoFile(worldId, key), 'utf8')) as { from: AnimateOptions['redoFrom'] }).from;
  } catch {
    return undefined;
  }
}

/** Actors still to animate, most wanted first. */
export function animationQueue(w: WorldDefinition): AssetRecord[] {
  const cfg = animationConfig();
  if (!cfg) return [];
  const zoneOrder = new Map(w.zones.map((z, i) => [z.id, z.id === w.startZoneId ? -1 : i]));
  const where = new Map<string, number>();
  // Companions travel in the party: they come first, with the heroes.
  for (const n of w.npcs) where.set(`spr_npc_${n.id}`, n.companion ? -15 : zoneOrder.get(n.zoneId) ?? 99);
  for (const z of w.zones) for (const f of z.familyIds ?? []) for (const m of w.families.find((x) => x.id === f)?.members ?? []) {
    const k = `spr_mon_${f}_${m.archetype}`;
    where.set(k, Math.min(where.get(k) ?? 99, zoneOrder.get(z.id) ?? 99));
  }
  // What the owner asked for in the studio first, then the companions and heroes, the first place, the rest by place, bosses last.
  const rank = (k: string) => (redoOf(w.id, k) ? -20 : k.startsWith('spr_hero_') ? -10 : k.startsWith('spr_boss_') ? 1000 : where.get(k) ?? 500);
  return actorSprites(w)
    .filter((a) => (needsAnimation(a) && !failedFor(w.id, a)) || !!redoOf(w.id, a.key))
    .filter((a) => bodyPlan(a) === 'humanoid' || !!cfg.skintokens)
    .sort((a, b) => rank(a.key) - rank(b.key));
}

/** Queue the world's animation job when it has actors waiting (and none is queued). */
export function queueAnimation(w: WorldDefinition, owner: { id: string; name: string }) {
  if (animationQueue(w).length) enqueueAnimation(w.id, owner);
}

export async function runAnimateJob(job: WorldGenJob, worldId: string): Promise<void> {
  const w0 = loadWorld(worldId);
  if (!w0) throw new Error('The daydream no longer exists.');
  const todo = animationQueue(w0);
  const rec = todo[0];
  if (!rec) return;
  const body = bodyPlan(rec);
  job.step = `Animating ${rec.key} (${todo.length} to go)`;
  job.push(`Animating ${rec.key} as a ${body}`, 'step');
  try {
    const image = fs.readFileSync(path.join(worldAssetDir(worldId), rec.file!));
    const r = await animateActor({ worldId, key: rec.key, image, body }, { redoFrom: redoOf(worldId, rec.key), onStep: (m) => job.push(m) });
    // Onto the world as it is now (a build or the studio may have saved it meanwhile), and only if the picture
    // is still the one animated.
    const w = loadWorld(worldId);
    if (w && w.assets[rec.key]?.file === rec.file) {
      saveAnimation(w, rec.key, r, animationConfig()?.scale ?? 2);
      saveWorld(w);
    }
    fs.rmSync(redoFile(worldId, rec.key), { force: true });
    job.push(`Animated ${rec.key}: ${Object.keys(r.clips).length} clips`, 'step');
  } catch (e) {
    const msg = (e as Error).message;
    // Stopped (by its owner or an administrator): not a failure; the actor waits for the next run.
    if (job.cancelled || msg === 'cancelled') throw e;
    fs.mkdirSync(jobDir(worldId, rec.key), { recursive: true });
    fs.writeFileSync(failFile(worldId, rec.key), JSON.stringify({ file: rec.file, error: msg.slice(0, 2000) }));
    fs.rmSync(redoFile(worldId, rec.key), { force: true });
    job.push(`Could not animate ${rec.key}: ${msg.slice(0, 300)}`, 'warn');
  }
  const w = loadWorld(worldId);
  if (w && !job.cancelled) queueAnimation(w, job.owner);
}

/** Why an actor has no sheets (for the studio): waiting, failed with this error, or none (animated). */
export function animationState(w: WorldDefinition, rec: AssetRecord): { state: 'animated' | 'waiting' | 'failed' | 'off'; error?: string } {
  if (!animationConfig()) return { state: 'off' };
  if (redoOf(w.id, rec.key)) return { state: 'waiting' };
  if (!needsAnimation(rec)) return { state: 'animated' };
  if (failedFor(w.id, rec)) {
    try {
      return { state: 'failed', error: (JSON.parse(fs.readFileSync(failFile(w.id, rec.key), 'utf8')) as { error?: string }).error };
    } catch {
      return { state: 'failed' };
    }
  }
  return { state: 'waiting' };
}

/** Actors whose animation failed for their current picture, with the error. */
export function failedActors(w: WorldDefinition): { key: string; error?: string }[] {
  if (!animationConfig()) return [];
  return actorSprites(w)
    .filter((a) => needsAnimation(a) && failedFor(w.id, a) && !redoOf(w.id, a.key))
    .map((a) => ({ key: a.key, error: animationState(w, a).error }));
}

/** Try a failed actor again: its failure is forgotten and the world's animation job queued (its other steps are kept). */
export function retryActor(w: WorldDefinition, key: string): boolean {
  const rec = w.assets[key];
  if (!rec || !failedFor(w.id, rec)) return false;
  fs.rmSync(failFile(w.id, key), { force: true });
  queueAnimation(w, { id: w.ownerId, name: w.ownerName });
  return true;
}
