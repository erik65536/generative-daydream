import { describe, expect, it } from 'vitest';
import { Rng, codexSections, rx, type Ruleset } from '@gd/shared';
import { compileRuleset } from '../src/rules/compile';
import { defaultIntent } from '../src/rules/defaults';
import { balanceRuleset } from '../src/rules/balance';
import { buildPack, fitPack, fittedPack } from '../src/rules/encounters';
import { makeParty, runFight } from '../src/rules/sim';
import { THEMES } from '../src/rules/defaults';

/** Every reference inside a compiled ruleset points at something that exists. */
function referenceErrors(r: Ruleset): string[] {
  const ix = rx(r);
  const errs: string[] = [];
  for (const s of r.skills) {
    if (s.cost && !ix.pool.has(s.cost.poolId)) errs.push(`${s.id}: pool ${s.cost.poolId}`);
    for (const e of s.effects) {
      if (e.kind === 'status' && e.statusId !== '$family' && !ix.status.has(e.statusId)) errs.push(`${s.id}: status ${e.statusId}`);
      if (e.kind === 'damage' && e.subtypeId && e.subtypeId !== '$family' && !ix.subtype.has(e.subtypeId)) errs.push(`${s.id}: subtype ${e.subtypeId}`);
      if (e.kind === 'damage' && e.typeId && !ix.type.has(e.typeId)) errs.push(`${s.id}: type ${e.typeId}`);
      if (e.kind === 'surface' && !ix.surface.has(e.surfaceId)) errs.push(`${s.id}: surface ${e.surfaceId}`);
    }
  }
  for (const c of r.classes) {
    for (const id of c.startingSkills) if (!ix.skill.has(id)) errs.push(`${c.id}: starting skill ${id}`);
    for (const n of c.nodes) if (n.skillId && !ix.skill.has(n.skillId)) errs.push(`${c.id}: node ${n.id} skill ${n.skillId}`);
    for (const [slot, base] of Object.entries(c.startingGear)) if (!ix.slot.has(slot) || !ix.item.has(base)) errs.push(`${c.id}: gear ${slot}=${base}`);
    for (const b of [0, 1, 2]) if (!c.nodes.some((n) => n.branch === c.branches[b]!.id && n.tier === 0)) errs.push(`${c.id}: branch ${b} has no tier-0 node`);
  }
  for (const i of r.items) if (i.slotId && !ix.slot.has(i.slotId)) errs.push(`${i.id}: slot ${i.slotId}`);
  for (const role of Object.keys(r.monsters) as (keyof Ruleset['monsters'])[]) for (const s of r.monsters[role].skills) if (!ix.skill.has(s)) errs.push(`monster ${role}: ${s}`);
  if (r.slots.filter((s) => s.kind === 'weapon').length !== 1) errs.push('exactly one weapon slot');
  return errs;
}

describe('generated rulesets', () => {
  it('every genre default compiles into a consistent ruleset', () => {
    for (const genre of Object.keys(THEMES) as (keyof typeof THEMES)[]) {
      const r = compileRuleset(defaultIntent(genre), { genre, maxLevel: 8 });
      expect(referenceErrors(r), genre).toEqual([]);
      expect(r.classes.length).toBeGreaterThanOrEqual(3);
      expect(r.attributes.length).toBeGreaterThanOrEqual(3);
      // No skip-turn or taunt effects exist in the vocabulary.
      expect(r.statuses.every((s) => !s.control || ['root', 'silence', 'disarm', 'slow'].includes(s.control))).toBe(true);
    }
  });

  it('writes a complete codex for every genre', () => {
    for (const genre of Object.keys(THEMES) as (keyof typeof THEMES)[]) {
      const r = compileRuleset(defaultIntent(genre), { genre, maxLevel: 8 });
      const text = JSON.stringify(codexSections(r));
      expect(text, genre).not.toMatch(/undefined|NaN|\[object/);
      expect(codexSections(r).map((s) => s.id)).toContain('classes');
    }
  });

  it('the simulator runs real fights deterministically', () => {
    const r = compileRuleset(defaultIntent('fantasy'), { genre: 'fantasy', maxLevel: 8 });
    const fight = () => {
      const rng = new Rng('det');
      const party = makeParty(r, { classes: r.classes.slice(0, 4).map((c) => c.id), level: 3, rng });
      return runFight(r, { party, pack: buildPack(r, rng, { mode: 'party_manual', level: 3, kind: 'normal' }), potions: 0, difficulty: 'normal', seed: 'x' });
    };
    const a = fight(), b = fight();
    expect(a).toEqual(b);
    expect(a.rounds).toBeGreaterThan(1);
  });

  it('balances a party world toward its targets and makes difficulty matter', () => {
    const r = compileRuleset(defaultIntent('scifi'), { genre: 'scifi', maxLevel: 8 });
    const rep = balanceRuleset(r, { mode: 'party_manual', seed: 'test', quick: true, budgetMs: 45_000 });
    const normal = rep.scenarios.filter((s) => s.difficulty === 'normal' && s.id.includes(':normal:'));
    expect(normal.length).toBeGreaterThan(0);
    // Normal fights are winnable but cost something.
    for (const s of normal) {
      expect(s.winRate, s.label).toBeGreaterThanOrEqual(0.8);
      expect(s.hpLost, s.label).toBeGreaterThan(0.05);
    }
    expect(rep.scenarios.filter((s) => s.ok).length / rep.scenarios.length).toBeGreaterThanOrEqual(0.5);
    // Brutal hits harder than story at every tuned level.
    for (const k of r.difficulty.brutal.enemyDmg) {
      const story = r.difficulty.story.enemyDmg.find((x) => x.level === k.level);
      if (story) expect(k.value).toBeGreaterThan(story.value);
    }
  }, 120_000);

  it('balances a solo world', () => {
    const r = compileRuleset(defaultIntent('fantasy'), { genre: 'fantasy', maxLevel: 8 });
    const rep = balanceRuleset(r, { mode: 'solo', seed: 'solo', quick: true, budgetMs: 40_000 });
    for (const s of rep.scenarios.filter((x) => x.id.startsWith('normal:normal'))) expect(s.winRate, s.label).toBeGreaterThanOrEqual(0.75);
  }, 120_000);

  it('fits packs to a smaller party than the world was built for', () => {
    const r = compileRuleset(defaultIntent('fantasy'), { genre: 'fantasy', maxLevel: 8 });
    const members = [0, 1, 2].map((i) => ({ id: `m${i}`, role: 'brute' as const }));
    const solo = fitPack(r, members, { mode: 'party_npc', partySize: 1, difficulty: 'story', rand: () => 0.99 });
    expect(solo.absent.length).toBeGreaterThan(0);
    expect(solo.scale).toBeLessThanOrEqual(1);
    const full = fitPack(r, members, { mode: 'party_npc', partySize: 3, difficulty: 'story', rand: () => 0.99 });
    expect(full).toEqual({ absent: [], scale: 1 });
    // A boss always stays.
    const boss = fitPack(r, [{ id: 'b', role: 'brute', boss: true }, ...members], { mode: 'party_manual', partySize: 1, difficulty: 'normal', rand: () => 0.99 });
    expect(boss.absent).not.toContain('b');
  });

  it('a lone hero can win fights in a companions world', () => {
    const r = compileRuleset(defaultIntent('fantasy'), { genre: 'fantasy', maxLevel: 8 });
    balanceRuleset(r, { mode: 'party_npc', seed: 'npc', quick: true, budgetMs: 30_000 });
    let wins = 0;
    const n = 12;
    for (let i = 0; i < n; i++) {
      const rng = new Rng(`lone:${i}`);
      const party = makeParty(r, { classes: [r.classes[i % r.classes.length]!.id], level: 3, rng });
      const pack = fittedPack(r, buildPack(r, rng, { mode: 'party_npc', level: 3, kind: 'normal' }), { mode: 'party_npc', partySize: 1, difficulty: 'normal', rng });
      if (runFight(r, { party, pack, potions: 0, difficulty: 'normal', seed: `l${i}` }).win) wins++;
    }
    expect(wins / n).toBeGreaterThanOrEqual(0.6);
  }, 120_000);
});
