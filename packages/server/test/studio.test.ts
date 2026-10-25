import { describe, expect, it } from 'vitest';
import { applyEdit, studioView } from '../src/worldgen/studio';
import { listArt, planAssets } from '../src/worldgen/art';
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

  it('plans one base image per actor: people from the front, creatures in the view the prompt writer picks', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    const plan = planAssets(w, 'full');
    expect(plan.some((r) => r.key.includes('@'))).toBe(false);
    const people = plan.filter((r) => r.key.startsWith('spr_npc_') || r.key.startsWith('spr_hero_'));
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((r) => r.view === 'front')).toBe(true);
    expect(plan.filter((r) => r.key.startsWith('spr_mon_')).every((r) => r.view === undefined)).toBe(true);
  });

  it('owner briefs and re-rolls mark exactly that asset for repainting', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    // Pretend everything is painted.
    for (const r of planAssets(w, 'full')) w.assets[r.key] = { ...r, status: 'ok', file: `${r.key}.png` };
    expect(planAssets(w, 'full')).toHaveLength(0);
    const npc = w.npcs[0]!;
    const key = `spr_npc_${npc.id}`;
    applyEdit(w, { type: 'art', key, brief: 'A tall figure in a yellow raincoat' });
    const plan = planAssets(w, 'full');
    expect(plan.every((r) => r.key === key)).toBe(true);
    expect(plan.find((r) => r.key === key)?.prompt).toBe('A tall figure in a yellow raincoat');
    const entry = listArt(w).find((a) => a.key === key)!;
    expect(entry.defaultBrief).not.toBe(entry.brief);
    // Clearing the brief returns to the world's own; nothing left to paint.
    applyEdit(w, { type: 'art', key, brief: null });
    expect(planAssets(w, 'full')).toHaveLength(0);
    // A re-roll repaints with a new roll number; limiting to other keys paints nothing.
    w.artOverrides = { [key]: { roll: 1 } };
    expect(planAssets(w, 'full', new Set(['spr_nothing']))).toHaveLength(0);
    expect(planAssets(w, 'full', new Set([key])).find((r) => r.key === key)?.roll).toBe(1);
    expect(studioView(w).world).not.toHaveProperty('generationLog');
  });

  it('links every way out to a way back', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    for (const z of w.zones)
      for (const f of z.features.filter((x) => x.kind === 'exit')) {
        const back = w.zones.find((x) => x.id === f.targetZoneId)?.features.find((x) => x.id === f.targetFeatureId);
        expect(back, `${f.id} -> ${f.targetZoneId}/${f.targetFeatureId}`).toBeTruthy();
        expect(back!.targetZoneId).toBe(z.id);
        expect(back!.targetFeatureId).toBe(f.id);
      }
    expect(validateWorld(w)).toEqual([]);
  });
});
