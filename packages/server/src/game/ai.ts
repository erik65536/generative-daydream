/**
 * Utility-based tactical AI for monsters, hostile NPCs, companions and simulated parties. Synchronous: each
 * `aiStep` performs one action and returns its animation time, or -1 when the turn is over.
 * Scores are in units of the actor's own damage-per-AP, so they work for any ruleset's number scale.
 */
import {
  NAV_CELL, Nav, SPACING, expectedDamage, pointAlong, healAmount, isBasic, potency, resolveStatusId, rx, skillAp, skillRange, statusDot,
  type DamageEffect, type ItemInstance, type SkillDef, type Vec2,
} from '@gd/shared';
import { Actor, CharActor } from './actors';
import { canReviveWith, checkItemUse, isHarmful, isHostileTo, relation } from './effects';
import type { Combat } from './combat';


export interface AiMemory {
  turnKey: string;
  banned: Set<string>;
  moves: number;
}

/** Hosts that let AI-driven characters drink potions from their party's bag. */
export interface AiInventoryHost {
  aiPotions?(a: Actor): { item: ItemInstance; consume: () => void }[];
}

interface Plan {
  score: number;
  moveTo?: Vec2;
  skill?: SkillDef;
  target?: Actor;
  point?: Vec2;
  item?: { item: ItemInstance; consume: () => void };
}

const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Estimated value of a skill used on a target from a position, in damage-per-AP units. */
function scoreSkill(c: Combat, a: Actor, skill: SkillDef, target: Actor | undefined, point: Vec2 | undefined, from: Vec2): number {
  const host = c.host;
  const r = host.r;
  const ix = rx(r);
  const stats = a.stats();
  const unit = Math.max(1e-6, stats.dpa);
  const rank = a.skillRank(skill.id);
  const pot = potency(skill, rank);
  const all = c.participants();
  const center = skill.targeting === 'self' ? from : point ?? target ?? from;
  const harmful = isHarmful(r, skill.effects);
  const revive = canReviveWith(r, skill.effects);
  let targets: Actor[];
  if (skill.radius) targets = all.filter((x) => (x.alive() || (revive && x.downed())) && d(x, center) <= skill.radius! && (harmful ? isHostileTo(a, x) : relation(a, x) === 'ally'));
  else targets = target ? [target] : skill.targeting === 'self' ? [a] : [];
  if (!targets.length) return 0;
  let score = 0;
  for (const t of targets) {
    const ts = t.stats();
    for (const e of skill.effects) {
      switch (e.kind) {
        case 'damage': {
          if (!t.alive()) break;
          const dmg = expectedDamage(r, stats, ts, skill, rank, e as DamageEffect);
          const ehp = t.hp + t.barrier;
          score += Math.min(dmg, ehp + unit) / unit;
          if (dmg >= ehp) score += 3;
          break;
        }
        case 'heal': {
          if (t.downed() && revive) {
            score += 14;
            break;
          }
          const missing = ts.maxHp - t.hp;
          if (missing / ts.maxHp > 0.25) score += (Math.min(missing, healAmount(stats, e.coef, pot)) / unit) * 1.1;
          break;
        }
        case 'barrier':
          if (t.barrier <= 0 && all.some((x) => x.alive() && isHostileTo(x, t) && d(x, t) < 9)) score += (healAmount(stats, e.coef, pot) / unit) * 0.6;
          break;
        case 'status': {
          const who = e.self ? a : t;
          const id = resolveStatusId(r, e.statusId, stats);
          const def = id ? ix.status.get(id) : undefined;
          if (!def || who.statuses.some((s) => s.id === id) || !who.alive()) break;
          if (def.control && who.controlImmune > 0) break;
          if (def.dot) score += ((statusDot(r, id!, stats.dpa * pot) * e.turns) / unit) * e.chance * 0.8;
          else if (def.hot) score += (who.stats().maxHp - who.hp > who.stats().maxHp * 0.2 ? (def.hot.coef * stats.dpa * pot * e.turns) / unit : 0) * e.chance;
          else if (def.control) score += 2.2 * e.turns * e.chance;
          else score += 1.3 * e.turns * e.chance;
          break;
        }
        case 'cleanse':
          score += t.statuses.filter((s) => ix.status.get(s.id)?.harmful).length * 1.5;
          break;
        case 'revive':
          if (t.downed()) score += 15;
          break;
        case 'restore':
          if (t instanceof CharActor) {
            const p = ts.pools[e.poolId];
            if (p && (t.pools[e.poolId] ?? 0) < p.max * 0.4) score += 1.5;
          }
          break;
        default:
          break;
      }
    }
  }
  return score;
}

function bestPlan(c: Combat, a: Actor, banned: Set<string>): Plan | null {
  const host = c.host;
  const nav = host.zoneMap(c.zoneId).nav;
  const stats = a.stats();
  const enemies = c.participants().filter((x) => x.alive() && isHostileTo(a, x));
  if (!enemies.length) return null;
  const allies = c.participants().filter((x) => relation(a, x) === 'ally' && (x.alive() || x.downed()));
  const budget = stats.rooted ? 0 : a.movementLeft + a.ap * stats.move;
  let reach = budget > 0 ? c.reach(a, budget) : [];
  // Stand points a metre apart are plenty to weigh where much is in reach.
  if (reach.length > 400) reach = reach.filter(({ p }) => Math.floor(p.x / NAV_CELL) % 2 === 0 && Math.floor(p.y / NAV_CELL) % 2 === 0);
  const los = (from: Vec2, to: Vec2) => nav.sees(from, to);
  let best: Plan | null = null;
  const consider = (p: Plan) => {
    if (!best || p.score > best.score) best = p;
  };
  const ix = rx(host.r);
  const skills = a.skillIds().map((id) => ix.skill.get(id)!).filter((s) => s && !s.utility && (a.cooldowns[s.id] ?? 0) <= 0 && skillAp(s, stats) <= a.ap && (!s.cost || !(a instanceof CharActor) || (a.pools[s.cost.poolId] ?? 0) >= s.cost.amount));
  for (const skill of skills) {
    if (stats.silenced && !(isBasic(skill) || skill.tags.includes('weapon'))) continue;
    if (stats.disarmed && (isBasic(skill) || skill.tags.includes('weapon'))) continue;
    const range = skillRange(skill, stats);
    const ap = skillAp(skill, stats);
    const harmful = isHarmful(host.r, skill.effects);
    const candidates: { target?: Actor; point?: Vec2 }[] = [];
    if (skill.targeting === 'enemy') for (const e of enemies) candidates.push({ target: e });
    else if (skill.targeting === 'ally') for (const al of allies) candidates.push({ target: al });
    else if (skill.targeting === 'self') candidates.push({});
    else for (const e of harmful ? enemies : allies) candidates.push({ point: { x: e.x, y: e.y } });
    for (const cand of candidates) {
      if (banned.has(`${skill.id}:${cand.target?.id ?? `${cand.point?.x},${cand.point?.y}`}`)) continue;
      if (skill.effects.some((e) => e.kind === 'teleport') ) continue;
      const tgt = cand.target ?? cand.point;
      const tryFrom = (from: Vec2, moveAp: number): Plan | null => {
        if (ap + moveAp > a.ap) return null;
        if (tgt && skill.targeting !== 'self' && d(from, tgt) > range + 0.01) return null;
        if (tgt && range > 2 && skill.targeting !== 'self' && !los(from, tgt)) return null;
        const s = scoreSkill(c, a, skill, cand.target, cand.point, from);
        if (s <= 0) return null;
        const ranged = stats.weapon.range > 2;
        const adj = enemies.filter((e) => d(e, from) < 1.8).length;
        const pos = ranged ? -adj * 1.5 : 0;
        return { score: (s + pos) / Math.max(1, ap) - moveAp * 0.3 + c.hash(a.id, skill.id, cand.target?.id ?? '') * 0.01, skill, target: cand.target, point: cand.point };
      };
      const here = tryFrom(a, 0);
      if (here) consider(here);
      if (skill.targeting === 'self' && !skill.radius) continue;
      let bestMove: (Plan & { cost: number }) | null = null;
      for (const { p: from, cost } of reach) {
        if (Math.hypot(from.x - a.x, from.y - a.y) < 0.3) continue;
        if (!(skill.targeting === 'self' && skill.radius) && tgt && d(from, tgt) > range + 0.01) continue;
        const apNeeded = cost <= a.movementLeft ? 0 : Math.ceil((cost - a.movementLeft) / Math.max(0.5, stats.move));
        const p = tryFrom(from, apNeeded);
        if (p && (!bestMove || p.score > bestMove.score || (p.score === bestMove.score && cost < bestMove.cost))) bestMove = { ...p, moveTo: from, cost };
      }
      if (bestMove) consider(bestMove);
    }
  }
  // Potions for AI-driven characters: drink when badly hurt.
  const inv = (host as unknown as { aiPotions?: (x: Actor) => { item: ItemInstance; consume: () => void }[] }).aiPotions?.(a) ?? [];
  if (inv.length && a.hp < stats.maxHp * 0.38) {
    for (const p of inv) {
      const base = ix.item.get(p.item.baseId);
      const heal = base?.use?.effects.find((e) => e.kind === 'heal');
      if (!heal || checkItemUse(host, a, p.item, true)) continue;
      consider({ score: 6 + (stats.maxHp - a.hp) / Math.max(1, stats.dpa) * 0.4, item: p });
      break;
    }
  }
  return best;
}

/** Move toward the nearest enemy when nothing useful can be done this turn. */
function approachPlan(c: Combat, a: Actor): Vec2 | null {
  const enemies = c.participants().filter((x) => x.alive() && isHostileTo(a, x));
  if (!enemies.length || a.ap <= 0 || a.stats().rooted) return null;
  const nearest = enemies.sort((p, q) => d(p, a) - d(q, a))[0]!;
  const ranged = a.stats().weapon.range > 2;
  // Up to them (or, for ranged fighters, to about six metres short); the move stops where the budget runs out.
  const path = c.host.zoneMap(c.zoneId).nav.path(a, nearest, { ...c.walkOptions(a), stopWithin: SPACING + 0.2, allowBlockedGoal: true, maxNodes: 12000 });
  if (!path?.length) return null;
  return pointAlong(a, path, Nav.length(a, path) - (ranged ? 6 : 0));
}

/** Perform one AI action for the active actor. Returns the animation time in ms, 0 to retry at once, -1 when done. */
export function aiStep(c: Combat, a: Actor): number {
  const key = `${c.round}:${c.idx}`;
  let mem = c.ai.get(a.id);
  if (!mem || mem.turnKey !== key) c.ai.set(a.id, (mem = { turnKey: key, banned: new Set(), moves: 0 }));
  const plan = bestPlan(c, a, mem.banned);
  if (!plan) {
    if (mem.moves >= 2) return -1;
    const to = approachPlan(c, a);
    if (!to) return -1;
    mem.moves++;
    const res = c.move(a, to);
    return res.error ? -1 : res.ms;
  }
  if (plan.moveTo) {
    mem.moves++;
    const res = c.move(a, plan.moveTo);
    if (res.error) {
      if (plan.skill) mem.banned.add(`${plan.skill.id}:${plan.target?.id ?? `${plan.point?.x},${plan.point?.y}`}`);
      return mem.moves > 3 ? -1 : 0;
    }
    return res.ms;
  }
  if (plan.item) {
    const err = c.useItem(a, plan.item.item, a, undefined, plan.item.consume);
    return err ? -1 : 700;
  }
  if (plan.skill) {
    const err = c.useSkill(a, plan.skill.id, plan.target, plan.point);
    if (err) {
      mem.banned.add(`${plan.skill.id}:${plan.target?.id ?? `${plan.point?.x},${plan.point?.y}`}`);
      return 0;
    }
    return 800;
  }
  return -1;
}
