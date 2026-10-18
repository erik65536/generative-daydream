import { describe, expect, it } from 'vitest';
import { applyEdit, studioView } from '../src/worldgen/studio';
import { listArt, planAssets } from '../src/worldgen/art';
import { rebuildZoneMap, spliceAreaContent, spliceTownContent, writeZoneContent } from '../src/worldgen/rezone';
import type { AreaContentOut, TownContentOut } from '../src/worldgen/schemas';
import { GROUND, base64ToBytes, type WorldDefinition } from '@gd/shared';
import { genWorld, validateWorld } from './helpers';

describe('world studio', () => {
  it('renames a person everywhere and keeps the world valid', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    const giver = w.npcs.find((n) => w.quests.some((q) => q.giverNpcId === n.id && q.objectives.some((o) => o.description.includes(n.name))))
      ?? w.npcs.find((n) => w.quests.some((q) => q.objectives.some((o) => o.description.includes(n.name))))!;
    const old = giver.name;
    expect(applyEdit(w, { type: 'npc', id: giver.id, name: 'Zebulon Quartermain' })).toBeNull();
    expect(giver.name).toBe('Zebulon Quartermain');
    const texts = w.quests.flatMap((q) => [q.title, q.summary, ...q.objectives.map((o) => o.description)]).join(' ');
    expect(texts).not.toContain(old);
    expect(texts).toContain('Zebulon Quartermain');
    validateWorld(w);
    expect(applyEdit(w, { type: 'quest', id: 'missing', title: 'x' })).toMatch(/No such/);
  });

  it('owner briefs and re-rolls mark exactly that asset (and its variants) for repainting', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    // Pretend everything is painted.
    for (const r of planAssets(w, 'full')) w.assets[r.key] = { ...r, status: 'ok', file: `${r.key}.png` };
    expect(planAssets(w, 'full')).toHaveLength(0);
    const npc = w.npcs[0]!;
    const key = `spr_npc_${npc.id}`;
    applyEdit(w, { type: 'art', key, brief: 'A tall figure in a yellow raincoat' });
    const plan = planAssets(w, 'full');
    expect(plan.every((r) => r.key === key || r.ref === key)).toBe(true);
    expect(plan.find((r) => r.key === key)?.prompt).toBe('A tall figure in a yellow raincoat');
    const entry = listArt(w).find((a) => a.key === key)!;
    expect(entry.defaultBrief).not.toBe(entry.brief);
    // Clearing the brief returns to the world's own; nothing left to paint.
    applyEdit(w, { type: 'art', key, brief: null });
    expect(planAssets(w, 'full')).toHaveLength(0);
    // A re-roll repaints with a new roll number; limiting to other keys paints nothing.
    w.artOverrides = { [key]: { roll: 1 } };
    expect(planAssets(w, 'full', new Set(['tex_nothing']))).toHaveLength(0);
    expect(planAssets(w, 'full', new Set([key])).find((r) => r.key === key)?.roll).toBe(1);
    // Editing a role's description repaints that element.
    const ts = Object.values(w.tilesets)[0]!;
    applyEdit(w, { type: 'role', tilesetId: ts.id, role: 'floor', prompt: 'Cracked turquoise tiles' });
    expect(planAssets(w, 'full').some((r) => r.key === `tex_${ts.id}_floor`)).toBe(true);
    expect(studioView(w).world).not.toHaveProperty('generationLog');
  });
});

/** Every exit of a place still leads to a place whose matching exit leads back. */
function exitsConnect(w: WorldDefinition, zoneId: string) {
  const z = w.zones.find((x) => x.id === zoneId)!;
  for (const f of z.features.filter((x) => x.kind === 'exit' || x.kind === 'door')) {
    const back = w.zones.find((x) => x.id === f.targetZoneId)?.features.find((x) => x.id === f.targetFeatureId);
    expect(back, `${f.id} -> ${f.targetZoneId}/${f.targetFeatureId}`).toBeTruthy();
    expect(back!.targetZoneId).toBe(z.id);
    expect(back!.targetFeatureId).toBe(f.id);
  }
}

const snapshot = (w: WorldDefinition, skip: Set<string>) => w.zones.filter((z) => !skip.has(z.id)).map((z) => JSON.stringify(z));

describe('zone regeneration', () => {
  it('gives each kind of place a new, valid map without touching any other place', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    for (const kind of ['wilderness', 'dungeon', 'town'] as const) {
      const z = w.zones.find((x) => x.kind === kind)!;
      const before = JSON.stringify(z);
      const others = snapshot(w, new Set([z.id]));
      const exits = z.features.filter((f) => f.kind === 'exit' || f.kind === 'door').map((f) => `${f.id}>${f.targetZoneId}/${f.targetFeatureId}/${f.facing ?? ''}`).sort();
      const people = w.npcs.filter((n) => n.zoneId !== z.id).map((n) => JSON.stringify(n));
      const groups = new Set(z.spawns.map((s) => s.groupId)).size;
      const res = rebuildZoneMap(w, z.id, { seed: `t-${kind}` });
      expect(JSON.stringify(z)).not.toBe(before);
      expect(validateWorld(w)).toEqual([]);
      expect(snapshot(w, new Set([z.id]))).toEqual(others);
      expect(w.npcs.filter((n) => n.zoneId !== z.id).map((n) => JSON.stringify(n))).toEqual(people);
      // Same ways out (ids, targets, edges), still connected both ways.
      expect(z.features.filter((f) => f.kind === 'exit' || f.kind === 'door').map((f) => `${f.id}>${f.targetZoneId}/${f.targetFeatureId}/${f.facing ?? ''}`).sort()).toEqual(exits);
      exitsConnect(w, z.id);
      expect(new Set(z.spawns.map((s) => s.groupId)).size).toBe(groups - res.droppedPacks);
      // People and monsters stand on open ground.
      const g = base64ToBytes(z.ground);
      const walk = (x: number, y: number) => [GROUND.floor, GROUND.floorAlt, GROUND.path].includes(g[y * z.width + x] as 1);
      for (const p of [...z.spawns, ...w.npcs.filter((n) => n.zoneId === z.id)]) expect(walk(p.x, p.y), `${'id' in p ? p.id : ''} at ${p.x},${p.y}`).toBe(true);
    }
  });

  it('follows an edited layout plan and keeps town doors paired with their interiors', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    const town = w.zones.find((x) => x.kind === 'town')!;
    const structure = town.layout?.structure === 'grid' ? 'hub' : 'grid';
    const doors = town.features.filter((f) => f.kind === 'door').map((f) => `${f.id}>${f.targetZoneId}`).sort();
    rebuildZoneMap(w, town.id, { plan: { structure, enclosed: true, hazard: 'none' }, seed: 'plan' });
    expect(town.layout?.structure).toBe(structure);
    expect(town.layout?.enclosed).toBe(true);
    expect(town.indoor).toBe(true);
    expect(w.tilesets[town.tilesetId]!.outdoor).toBe(false);
    expect(town.features.filter((f) => f.kind === 'door').map((f) => `${f.id}>${f.targetZoneId}`).sort()).toEqual(doors);
    exitsConnect(w, town.id);
    expect(validateWorld(w)).toEqual([]);
    expect(() => rebuildZoneMap(w, w.zones.find((x) => x.kind === 'interior')!.id)).toThrow(/town/);
  });

  it('splices new residents and side quests into one town without renumbering anything else', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.', 'medium');
    const town = w.zones.find((x) => x.kind === 'town')!;
    const mine = (id: string) => id === town.id || w.zones.find((x) => x.id === id)?.parentZoneId === town.id;
    const otherZoneIds = w.zones.filter((x) => !mine(x.id)).map((x) => x.id);
    const otherNpcs = w.npcs.filter((n) => !mine(n.zoneId)).map((n) => n.id);
    const residents = w.npcs.filter((n) => mine(n.zoneId) && !n.essential).map((n) => n.id);
    const story = w.npcs.filter((n) => mine(n.zoneId) && n.essential).map((n) => n.id);
    const otherQuests = w.quests.filter((q) => q.main || q.zoneId !== town.id).map((q) => q.id);
    for (const id of residents) w.assets[`spr_npc_${id}`] = { key: `spr_npc_${id}`, kind: 'sprite', prompt: 'x', status: 'ok', file: 'x.png' };

    const content = await writeZoneContent(w, town.id, 'a night market on stilts');
    const res = spliceTownContent(w, town.id, content as TownContentOut, 'c1');
    rebuildZoneMap(w, town.id, { seed: 'c1' });
    expect(res.added.length).toBeGreaterThan(0);
    expect(validateWorld(w)).toEqual([]);
    exitsConnect(w, town.id);
    for (const i of w.zones.filter((x) => x.parentZoneId === town.id)) exitsConnect(w, i.id);
    expect(w.zones.filter((x) => !mine(x.id)).map((x) => x.id)).toEqual(otherZoneIds);
    expect(w.npcs.filter((n) => !mine(n.zoneId)).map((n) => n.id)).toEqual(otherNpcs);
    for (const id of story) expect(mine(w.npcs.find((n) => n.id === id)!.zoneId)).toBe(true);
    for (const id of otherQuests) expect(w.quests.some((q) => q.id === id)).toBe(true);
    // Nothing points at someone who left; their portraits are gone, new ids never collide.
    const ids = new Set(w.npcs.map((n) => n.id));
    expect(ids.size).toBe(w.npcs.length);
    for (const q of w.quests) for (const id of [q.giverNpcId, q.turnInNpcId, ...q.objectives.map((o) => o.npcId)]) if (id) expect(ids.has(id), `${q.id} -> ${id}`).toBe(true);
    for (const id of residents.filter((x) => !ids.has(x))) expect(w.assets[`spr_npc_${id}`]).toBeUndefined();
    expect(w.quests.filter((q) => !q.main && q.zoneId === town.id).every((q) => /_r\d+_/.test(q.id))).toBe(true);
    // Every merchant and innkeeper has a building.
    for (const n of w.npcs.filter((x) => mine(x.zoneId) && ['merchant', 'innkeeper'].includes(x.role))) expect(n.zoneId).not.toBe(town.id);

    // A second round removes the first round's quests and items cleanly.
    const firstItems = Object.keys(w.uniqueItems).filter((u) => u.includes(`${town.id.slice(2)}_r1_`));
    spliceTownContent(w, town.id, content as TownContentOut, 'c2');
    rebuildZoneMap(w, town.id, { seed: 'c2' });
    expect(validateWorld(w)).toEqual([]);
    for (const u of firstItems) {
      expect(w.uniqueItems[u]).toBeUndefined();
      expect(w.zones.some((x) => x.features.some((f) => f.items?.includes(u)))).toBe(false);
    }
  });

  it('replaces a wild\'s lore notes and shrine name', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    const wild = w.zones.find((x) => x.kind === 'wilderness')!;
    const others = snapshot(w, new Set([wild.id]));
    const content = (await writeZoneContent(w, wild.id, '')) as AreaContentOut;
    content.shrineName = 'The Drowned Bell';
    spliceAreaContent(w, wild.id, content);
    rebuildZoneMap(w, wild.id, { seed: 'lore' });
    expect(validateWorld(w)).toEqual([]);
    expect(snapshot(w, new Set([wild.id]))).toEqual(others);
    expect(wild.features.find((f) => f.kind === 'shrine' && !f.id.includes('fx_'))?.name).toBe('The Drowned Bell');
    const notes = wild.features.filter((f) => f.kind === 'lore');
    expect(notes.length).toBe(content.loreNotes.length);
    for (const f of notes) expect(w.lore.some((l) => l.id === f.loreId)).toBe(true);
    expect(new Set(w.lore.map((l) => l.id)).size).toBe(w.lore.length);
  });
});
