import { expect } from 'vitest';
import { base64ToBytes, GROUND, findPath, type CharacterSpec, type ClassRole, type WorldDefinition } from '@gd/shared';
import { WorldGenJob, runGeneration } from '../src/worldgen/pipeline';
import { loadWorld } from '../src/storage';

export async function genWorld(setting: string, size: 'small' | 'medium' = 'small', combatMode: 'solo' | 'party_npc' | 'party_manual' = 'solo'): Promise<WorldDefinition> {
  const job = new WorldGenJob(`w_test_${Math.random().toString(36).slice(2, 8)}`, { setting, size, length: 'short', communication: 2, combatMode, art: 'none', seed: 'test-seed' }, { id: 'u1', name: 'Tester' });
  await runGeneration(job);
  return loadWorld(job.worldId)!;
}

export function validateWorld(w: WorldDefinition) {
  const zoneIds = new Set(w.zones.map((z) => z.id));
  const npcIds = new Set(w.npcs.map((n) => n.id));
  const errors: string[] = [];
  for (const z of w.zones) {
    const g = base64ToBytes(z.ground);
    expect(g.length).toBe(z.width * z.height);
    const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < z.width && y < z.height && [GROUND.floor, GROUND.floorAlt, GROUND.path].includes(g[y * z.width + x] as 1);
    for (const f of z.features) {
      if ((f.kind === 'exit' || f.kind === 'door') && (!f.targetZoneId || !zoneIds.has(f.targetZoneId))) errors.push(`${z.id}: bad exit ${f.id} -> ${f.targetZoneId}`);
      if (f.targetFeatureId) {
        const tz = w.zones.find((x) => x.id === f.targetZoneId);
        if (!tz?.features.some((x) => x.id === f.targetFeatureId)) errors.push(`${z.id}: exit ${f.id} target feature ${f.targetFeatureId} missing`);
      }
    }
    // Every exit must be reachable from the entry.
    if (z.kind !== 'interior') for (const f of z.features.filter((f) => f.kind === 'exit' || f.kind === 'door')) {
      const p = findPath(z.entry, f, { width: z.width, height: z.height, passable: walk, stopWithin: 1.5 });
      if (!p) errors.push(`${z.id} (${z.kind}): exit ${f.id} unreachable from entry`);
    }
  }
  for (const n of w.npcs) if (!zoneIds.has(n.zoneId)) errors.push(`npc ${n.id} zone ${n.zoneId} missing`);
  for (const q of w.quests) {
    if (!q.objectives.length) errors.push(`quest ${q.id} has no objectives`);
    for (const o of q.objectives) {
      if (o.npcId && !npcIds.has(o.npcId)) errors.push(`quest ${q.id} objective ${o.id} npc ${o.npcId}`);
      if (o.zoneId && !zoneIds.has(o.zoneId)) errors.push(`quest ${q.id} zone ${o.zoneId}`);
      if (o.itemUniqueId && !w.uniqueItems[o.itemUniqueId]) errors.push(`quest ${q.id} item ${o.itemUniqueId}`);
      if (o.targetId && !w.bosses.some((b) => b.id === o.targetId)) errors.push(`quest ${q.id} boss ${o.targetId}`);
      if (o.type === 'collect') {
        const placed = w.zones.some((z) => z.features.some((f) => f.items?.includes(o.itemUniqueId!))) || w.bosses.some((b) => b.drops.includes(o.itemUniqueId!)) || q.grantsOnStart?.includes(o.itemUniqueId!);
        if (!placed) errors.push(`quest ${q.id} collect item ${o.itemUniqueId} not placed`);
      }
      if (o.type === 'interact' && !w.zones.some((z) => z.features.some((f) => f.id === o.featureId))) errors.push(`quest ${q.id} interact feature missing`);
    }
  }
  for (const b of w.bosses) if (!w.zones.find((z) => z.id === b.zoneId)?.spawns.some((s) => s.bossId === b.id)) errors.push(`boss ${b.id} not spawned`);
  return errors;
}


/** A character spec for the world's class with the given role (or the first class). */
export function hero(w: WorldDefinition, name: string, role: ClassRole = 'tank'): CharacterSpec {
  const cls = w.ruleset.classes.find((c) => c.role === role) ?? w.ruleset.classes[0]!;
  return { name, classId: cls.id, kinId: w.ruleset.kins[0]!.id, presentation: 'androgynous', pronouns: 'they/them' };
}
