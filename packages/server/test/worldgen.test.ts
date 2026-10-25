import { describe, expect, it } from 'vitest';
import { Nav, Rng, makeNav } from '@gd/shared';
import { populate } from '../src/worldgen/zones';
import { genWorld, validateWorld } from './helpers';

describe('world generation', () => {
  it('builds a valid world', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles');
    expect(w.status).toBe('ready');
    expect(validateWorld(w)).toEqual([]);
    expect(w.quests.some((q) => q.main)).toBe(true);
    expect(w.finalQuestId).toBeTruthy();
  });
  it('builds a valid medium world with companions', async () => {
    const w = await genWorld('A derelict space station orbiting a dying star, robots and aliens', 'medium', 'party_npc');
    expect(validateWorld(w)).toEqual([]);
    expect(w.npcs.filter((n) => n.companion).length).toBe(3);
    // A crafter (and the crafting station at their workshop) in every town of a world with crafting.
    if (w.ruleset.crafting.enabled) for (const t of w.zones.filter((z) => z.kind === 'town')) expect(t.features.some((f) => f.kind === 'craft_station')).toBe(true);
    // Fast travel is off unless chosen: no waypoints, no way home in a bottle.
    expect(w.zones.some((z) => z.features.some((f) => f.kind === 'waypoint'))).toBe(false);
    expect(w.ruleset.items.some((i) => i.use?.tool === 'recall')).toBe(false);
    // Every place sized within its kind, the world within its tile budget.
    expect(w.zones.reduce((n, z) => n + z.tiles[0] * z.tiles[1], 0)).toBeLessThanOrEqual(55);
    // Heroes are painted per class and kin; each kin is one gender.
    expect(w.ruleset.kins.every((k) => ['feminine', 'masculine', 'androgynous'].includes(k.presentation) && k.appearance)).toBe(true);
  }, 180_000);
});

describe('populating a place', () => {
  it('a party coming in through a narrow way in stands on the open ground past it', () => {
    // A 4 m gap through the barrier at the top edge, then a 2 m path 7 m long, into a 14 m clearing.
    const nav = new Nav(makeNav(30, 30, (x, y) => (x > 13 && x < 17 && y < 3) || (x > 14 && x < 16 && y < 10) || (x > 8 && x < 22 && y >= 10 && y < 24)));
    const a = nav.arrival({ x: 15, y: 4 }, 14);
    expect(a.y).toBeGreaterThan(10);
    expect(nav.walkable(a.x, a.y)).toBe(true);
    // A door on open ground: a step off it.
    const b = nav.arrival({ x: 15, y: 17 });
    expect(Math.hypot(b.x - 15, b.y - 17)).toBeLessThan(2.5);
  });

  it('gathers packs in open rooms, not passages, and puts the boss in its lair', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles');
    const z = w.zones.find((x) => x.kind === 'dungeon' || x.kind === 'wilderness')!;
    // Two 14 m rooms joined by a long 2 m corridor.
    const room = (x: number, y: number) => (x > 1 && x < 15 && y > 1 && y < 15) || (x > 45 && x < 59 && y > 1 && y < 15);
    const nav = new Nav(makeNav(60, 16, (x, y) => room(x, y) || (x >= 15 && x <= 45 && y > 7 && y < 9)));
    z.spawns = [];
    z.features = z.features.filter((f) => f.kind !== 'trap' && f.kind !== 'exit');
    z.entry = { x: 4, y: 8 };
    const boss = w.bosses.find((b) => b.zoneId === z.id) ?? { ...w.bosses[0]!, zoneId: z.id };
    if (!w.bosses.includes(boss)) w.bosses.push(boss);
    populate(w, z, nav, new Rng('t'), 400, [], new Map([[boss.id, { x: 52, y: 8 }]]));
    const packs = new Map<string, { x: number; y: number }[]>();
    for (const s of z.spawns) packs.set(s.groupId!, [...(packs.get(s.groupId!) ?? []), s]);
    for (const [, members] of packs) {
      const cx = members.reduce((a, m) => a + m.x, 0) / members.length;
      expect(cx < 15 || cx > 45).toBe(true);
    }
    const b = z.spawns.find((s) => s.bossId === boss.id)!;
    expect(Math.hypot(b.x - 52, b.y - 8)).toBeLessThan(4);
  });
});
