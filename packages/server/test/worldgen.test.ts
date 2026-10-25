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
    expect(w.npcs.some((n) => n.canJoinParty)).toBe(true);
  });
});

describe('populating a place', () => {
  it('gathers packs in open rooms, not passages, and puts the boss in its lair', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles');
    const z = w.zones.find((x) => x.kind === 'dungeon' || x.kind === 'wilderness')!;
    // Two 14 m rooms joined by a long 2 m corridor.
    const room = (x: number, y: number) => (x > 1 && x < 15 && y > 1 && y < 15) || (x > 45 && x < 59 && y > 1 && y < 15);
    const nav = new Nav(makeNav(60, 16, (x, y) => room(x, y) || (x >= 15 && x <= 45 && y > 7 && y < 9)));
    z.spawns = [];
    z.features = z.features.filter((f) => f.kind !== 'trap' && f.kind !== 'exit' && f.kind !== 'door');
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
