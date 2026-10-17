import { describe, expect, it } from 'vitest';
import { genWorld, validateWorld } from './helpers';

describe('procedural world generation', () => {
  it('generates a valid fantasy world', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles');
    expect(w.status).toBe('ready');
    expect(validateWorld(w)).toEqual([]);
    expect(w.quests.some((q) => q.main)).toBe(true);
    expect(w.finalQuestId).toBeTruthy();
  });
  it('generates a valid sci-fi world with companions', async () => {
    const w = await genWorld('A derelict space station orbiting a dying star, robots and aliens', 'medium', 'party_npc');
    expect(validateWorld(w)).toEqual([]);
    expect(w.terminology.gold).toBe('Credits');
    expect(w.npcs.some((n) => n.canJoinParty)).toBe(true);
  });
});
