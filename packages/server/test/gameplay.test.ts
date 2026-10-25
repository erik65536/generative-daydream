import { describe, expect, it } from 'vitest';
import { SPACING, SQUEEZE, type ServerMessage } from '@gd/shared';
import { genWorld, hero } from './helpers';
import { instances } from '../src/game/manager';
import { Combat } from '../src/game/combat';
import { MonsterActor, CharActor, NpcActor } from '../src/game/actors';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('gameplay simulation', () => {
  it('plays through dialogue, travel and combat', async () => {
    Combat.instant = true;
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves', 'small', 'solo');
    const inst = instances.create(w, 'u1', 'Tester', 'test run', [hero(w, 'Mara', 'tank')]);
    const msgs: ServerMessage[] = [];
    inst.join({ userId: 'u1', send: (m) => msgs.push(m) });
    const p = inst.state.players.u1!;
    expect(msgs.some((m) => m.t === 'welcome')).toBe(true);
    expect(msgs.some((m) => m.t === 'zone')).toBe(true);
    // The opening main quest auto-started.
    const main = Object.keys(p.quests).find((id) => id.startsWith('q_main'));
    expect(main).toBeTruthy();

    // Talk to the first quest giver via the procedural brain.
    const q = inst.questDef(main!)!;
    const giver = q.objectives[0]!.npcId!;
    await inst.dialogue.open('u1', giver);
    expect(p.quests[main!]!.objectives[q.objectives[0]!.id]!.done).toBe(true);
    await inst.dialogue.say('u1', 'Hello! Is there any work for me?');
    const dlg = msgs.filter((m) => m.t === 'dialog').pop();
    expect(dlg && dlg.t === 'dialog' && dlg.dialog?.messages.length).toBeGreaterThan(0);
    inst.dialogue.close('u1');

    // Travel to a wilderness zone and pick a fight.
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    inst.transfer(p, wild.id);
    expect(p.zoneId).toBe(wild.id);
    const zone = inst._live(wild.id);
    const monster = [...zone.actors.values()].find((a) => a instanceof MonsterActor && a.alive()) as MonsterActor;
    expect(monster).toBeTruthy();
    const me = inst._charActors('u1')[0]! as CharActor;
    // Give our hero a fighting chance and teleport next to the pack.
    me.ch.level = 3;
    me.x = monster.x + 1.2;
    me.y = monster.y;
    inst.handle('u1', { t: 'use_skill', charId: me.id, skillId: 'attack', targetId: monster.id });
    await wait(20);
    const combat = inst._combats()[0];
    expect(combat).toBeTruthy();
    // Play the player's turns automatically: attack the nearest enemy or end turn.
    for (let i = 0; i < 400 && !combat!.ended; i++) {
      const act = combat!.active;
      if (act instanceof CharActor) {
        const enemies = combat!.participants().filter((x) => x.alive() && x instanceof MonsterActor);
        const target = enemies.sort((a, b) => Math.hypot(a.x - act.x, a.y - act.y) - Math.hypot(b.x - act.x, b.y - act.y))[0];
        if (target && act.ap >= 2) {
          if (Math.hypot(target.x - act.x, target.y - act.y) > 1.6) combat!.move(act, { x: target.x + (target.x > act.x ? -1.1 : 1.1), y: target.y });
          const err = combat!.useSkill(act, 'attack', target);
          if (err) combat!.endTurn(act);
        } else combat!.endTurn(act);
      }
      await wait(2);
    }
    expect(combat!.ended).toBe(true);
    expect(p.stats.kills + p.stats.deaths).toBeGreaterThan(0);
    inst.leave({ userId: 'u1', send: () => {} } as never);
    void NpcActor;
  }, 60000);
});

describe('companions', () => {
  it('travel with the player from the start, AI-played, and can be talked to', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles', 'small', 'party_npc');
    const companions = w.npcs.filter((n) => n.companion);
    expect(companions.length).toBe(3);
    expect(new Set(companions.map((n) => n.companion!.classId)).size).toBe(Math.min(3, w.ruleset.classes.length));
    const inst = instances.create(w, 'uc', 'Tester', 'companions', [hero(w, 'Lead', 'ranged')]);
    const msgs: { t: string; dialog?: { npcId: string } | null }[] = [];
    inst.join({ userId: 'uc', send: (m) => msgs.push(m as never) });
    const p = inst.state.players.uc!;
    expect(p.party.map((c) => c.npcId)).toEqual([undefined, ...companions.map((n) => n.id)]);
    expect(p.party.slice(1).every((c) => c.aiControlled && c.kinId === w.npcs.find((n) => n.id === c.npcId)!.companion!.kinId)).toBe(true);
    // They walk with the party, never stand about in town.
    const town = inst._live(w.startZoneId);
    expect(companions.some((n) => town.actors.has(n.id))).toBe(false);
    expect(inst._charActors('uc').length).toBe(4);
    // Clicking one opens a conversation with them.
    const [lead, first] = inst._charActors('uc');
    first!.x = lead!.x + 1;
    first!.y = lead!.y;
    inst.handle('uc', { t: 'interact', targetId: first!.id });
    await wait(5);
    expect(msgs.filter((m) => m.t === 'dialog').pop()?.dialog?.npcId).toBe(first!.ch.npcId);
    // (It builds a world of its own, balance simulation included: up to a few minutes on a busy machine.)
  }, 300_000);
});

describe('combat movement', () => {
  it('lets allies squeeze past each other at a cost, but never stand together', async () => {
    Combat.instant = true;
    const w = await genWorld('A sunburnt frontier of mesas and copper mines', 'small', 'party_manual');
    const inst = instances.create(w, 'ua', 'Tester', 'ally pass', [hero(w, 'Ana', 'tank'), hero(w, 'Bo', 'ranged')]);
    inst.join({ userId: 'ua', send: () => {} });
    const p = inst.state.players.ua!;
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    inst.transfer(p, wild.id);
    const zone = inst._live(wild.id);
    const monster = [...zone.actors.values()].find((a) => a instanceof MonsterActor && a.alive()) as MonsterActor;
    const [a, b] = inst._charActors('ua') as CharActor[];
    a!.x = monster.x + 1.2;
    a!.y = monster.y;
    inst.handle('ua', { t: 'use_skill', charId: a!.id, skillId: 'attack', targetId: monster.id });
    await wait(20);
    const combat = inst._combats()[0]!;
    expect(combat).toBeTruthy();
    // Put Bo a metre from Ana, with open ground a metre beyond him.
    const [dx, dy] = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([x, y]) => [1, 2].every((k) => combat.standable(a!, { x: a!.x + x! * k, y: a!.y + y! * k })))!;
    b!.x = a!.x + dx!;
    b!.y = a!.y + dy!;
    expect(combat.occupant({ x: b!.x + 0.3, y: b!.y }, a)).toBe(b);
    // Nobody stops inside someone else.
    expect(combat.pathFor(a!, { x: b!.x, y: b!.y })).toBeNull();
    const beyond = { x: b!.x + dx!, y: b!.y + dy! };
    expect(combat.pathFor(a!, beyond)).not.toBeNull();
    // Walking straight through Bo costs extra for every metre within his body (sampled each quarter metre).
    const inside = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].filter((t) => Math.abs(t - 1) < SPACING - 0.01).length * 0.25;
    expect(combat.pathCost(a!, [beyond])).toBeCloseTo(2 + inside * SQUEEZE, 5);
  }, 300_000);
});
