import { it } from 'vitest';
import { genWorld, hero } from './helpers';
import { instances } from '../src/game/manager';
import { Combat } from '../src/game/combat';
import { MonsterActor } from '../src/game/actors';

it.skipIf(!process.env.DEBUG_FIGHT)('debug a single fight', async () => {
  Combat.instant = true;
  const w = await genWorld('A misty kingdom of dragons and ruined castles', 'small', 'solo');
  const inst = instances.create(w, 'ud', 'Sim', 'dbg', [hero(w, 'Hero', 'tank')]);
  const events: string[] = [];
  inst.join({
    userId: 'ud',
    send: (m) => {
      if (m.t === 'fx') for (const e of m.events) if (e.kind === 'damage') events.push(`dmg ${e.targetId?.slice(-6)} ${e.damage?.amount} ${e.damage?.type}${e.damage?.crit ? '!' : ''}`);
      if (m.t === 'combat' && m.combat) events.push(`turn ${m.combat.order.find((o) => o.id === m.combat!.activeId)?.name} r${m.combat.round} ap=${m.combat.order.find((o) => o.id === m.combat!.activeId)?.ap}`);
    },
  });
  const p = inst.state.players.ud!;
  p.party[0]!.npcId = 'sim';
  const zone = w.zones.find((z) => z.kind === 'wilderness')!;
  inst.transfer(p, zone.id);
  const live = inst._live(zone.id);
  const target = [...live.actors.values()].find((a): a is MonsterActor => a instanceof MonsterActor && a.alive())!;
  const hero = inst._charActors('ud')[0]!;
  hero.x = Math.round(target.x) + 4;
  hero.y = Math.round(target.y);
  const combat = inst.startCombat(live as never, target, hero, false)!;
  for (const a of combat.participants()) events.push(`${a.name} hp=${a.hp} phys=${a.physArmor} mag=${a.magArmor} lvl=${a.level} dmg=${a.stats().weaponMin}-${a.stats().weaponMax}`);
  for (let i = 0; i < 3000 && !combat.ended; i++) await new Promise((r) => setTimeout(r, 1));
  console.log(events.join('\n'));
}, 60000);
