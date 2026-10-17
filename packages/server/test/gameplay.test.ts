import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@gd/shared';
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
    me.x = Math.round(monster.x) + 1;
    me.y = Math.round(monster.y);
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
          if (Math.hypot(target.x - act.x, target.y - act.y) > 1.6) await combat!.move(act, { x: Math.round(target.x) + (target.x > act.x ? -1 : 1), y: Math.round(target.y) });
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
  it('recruits an NPC companion through conversation', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles', 'small', 'party_npc');
    const inst = instances.create(w, 'uc', 'Tester', 'companions', [hero(w, 'Lead', 'ranged')]);
    inst.join({ userId: 'uc', send: () => {} });
    const comp = w.npcs.find((n) => n.canJoinParty)!;
    expect(comp).toBeTruthy();
    const p = inst.state.players.uc!;
    inst.transfer(p, comp.zoneId);
    await inst.dialogue.open('uc', comp.id);
    await inst.dialogue.say('uc', 'Would you travel with me?');
    expect(p.party.length).toBe(2);
    expect(p.party[1]!.npcId).toBe(comp.id);
    expect(inst._charActors('uc').length).toBe(2);
    await inst.dialogue.say('uc', 'It is time we parted ways.');
    expect(p.party.length).toBe(1);
  }, 60000);
});

describe('combat movement', () => {
  it('lets allies pass through each other at a cost, but never share a tile', async () => {
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
    a!.x = Math.round(monster.x) + 1;
    a!.y = Math.round(monster.y);
    inst.handle('ua', { t: 'use_skill', charId: a!.id, skillId: 'attack', targetId: monster.id });
    await wait(20);
    const combat = inst._combats()[0]!;
    expect(combat).toBeTruthy();
    // Put Bo on a free tile next to Ana, with a free tile beyond him.
    const free = (x: number, y: number) => !combat.occupied(x, y) && !zone.map.solid[y * zone.map.def.width + x];
    const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dy]) => free(a!.x + dx!, a!.y + dy!) && free(a!.x + 2 * dx!, a!.y + 2 * dy!))!;
    b!.x = a!.x + dir[0]!;
    b!.y = a!.y + dir[1]!;
    expect(combat.allyAt(a!, b!.x, b!.y)).toBe(true);
    expect(combat.allyAt(a!, Math.round(monster.x), Math.round(monster.y))).toBe(false);
    // Can't end a move on an ally.
    expect(combat.pathFor(a!, { x: b!.x, y: b!.y })).toBeNull();
    // Walking across Bo's tile costs one extra tile of movement.
    const across = [{ x: b!.x, y: b!.y }, { x: b!.x + dir[0]!, y: b!.y + dir[1]! }];
    expect(combat.pathCost(a!, across)).toBeCloseTo(3, 5);
  });
});
