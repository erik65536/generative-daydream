/** Utility-based tactical AI for monsters, hostile NPCs and companions. */
import {
  STATUS_INFO, expectedDamage, getSkill, hasLineOfSight, healAmount, reachable, skillRange, SCHOOL_INFO,
  type SkillEffect, type SkillTemplate, type Vec2,
} from '@gd/shared';
import { Actor, CharActor } from './actors';
import { checkSkill, isHostileTo, relation } from './effects';
import type { Combat, CombatHost } from './combat';

interface Plan {
  score: number;
  moveTo?: Vec2;
  skill?: SkillTemplate;
  target?: Actor;
  point?: Vec2;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function effectiveHp(a: Actor) {
  return a.hp + (a.physArmor + a.magArmor) * 0.5;
}

/** Estimate the value of using a skill on a target from a position. */
function scoreSkill(c: Combat, host: CombatHost, a: Actor, skill: SkillTemplate, target: Actor | undefined, point: Vec2 | undefined, from: Vec2): number {
  const stats = a.stats();
  const all = host.actorsInZone(c.zoneId).filter((x) => c.participants().includes(x));
  const center = skill.targeting === 'self' ? from : point ?? target ?? from;
  const harmful = skill.effects.some((e) => e.kind === 'damage' || (e.kind === 'status' && STATUS_INFO[e.status].harmful));
  let targets: Actor[];
  if (skill.radius) targets = all.filter((x) => x.alive() && d(x, center) <= skill.radius! && (harmful ? isHostileTo(a, x) : relation(a, x) === 'ally'));
  else targets = target ? [target] : skill.targeting === 'self' ? [a] : [];
  if (!targets.length && !skill.effects.some((e) => e.kind === 'revive')) return 0;
  let score = 0;
  const me = { stats, statuses: a.statuses, physArmor: a.physArmor, magArmor: a.magArmor, hp: a.hp };
  for (const t of targets) {
    const them = { stats: t.stats(), statuses: t.statuses, physArmor: t.physArmor, magArmor: t.magArmor, hp: t.hp };
    for (const e of skill.effects) {
      switch (e.kind) {
        case 'damage': {
          const dmg = expectedDamage(me, them, e as Extract<SkillEffect, { kind: 'damage' }>, skill, skill.scaling ?? SCHOOL_INFO[skill.school].attribute);
          score += Math.min(dmg, effectiveHp(t) + 5);
          if (dmg >= effectiveHp(t)) score += 12 + t.level * 2; // finishing blows matter
          break;
        }
        case 'heal': {
          const missing = t.stats().maxHp - t.hp;
          if (missing / t.stats().maxHp > 0.25) score += Math.min(missing, healAmount(stats, e.mult)) * 1.1;
          break;
        }
        case 'armor': {
          const max = e.pool === 'phys' ? t.stats().maxPhys : t.stats().maxMag;
          const cur = e.pool === 'phys' ? t.physArmor : t.magArmor;
          if (max - cur > max * 0.4) score += (max - cur) * 0.5;
          break;
        }
        case 'status': {
          const who = e.target === 'self' ? a : t;
          if (who.statuses.some((s) => s.id === e.status)) break;
          const def = STATUS_INFO[e.status];
          const blocked = def.blockedBy ? (def.blockedBy === 'phys' ? who.physArmor > 0 : who.magArmor > 0) : false;
          if (def.harmful && blocked) break;
          score += (def.skipTurn ? 18 : 7) * e.chance + who.level * 0.6;
          break;
        }
        case 'cleanse':
          score += t.statuses.filter((s) => STATUS_INFO[s.id].harmful).length * 8;
          break;
        case 'revive':
          if (t instanceof CharActor && t.ch.downed) score += 60;
          break;
        default:
          break;
      }
    }
  }
  return score;
}

function bestPlan(c: Combat, host: CombatHost, a: Actor, banned: Set<string>): Plan | null {
  const map = host.zoneMap(c.zoneId);
  const W = map.def.width;
  const stats = a.stats();
  const enemies = c.participants().filter((x) => x.alive() && isHostileTo(a, x));
  if (!enemies.length) return null;
  const allies = c.participants().filter((x) => relation(a, x) === 'ally');
  const taunt = a.statuses.find((s) => s.id === 'taunted');
  const forced = taunt ? enemies.find((e) => e.id === taunt.sourceId) : undefined;
  const budgetTiles = a.movementLeft + a.ap * stats.tilesPerAp;
  const reach = reachable(a, budgetTiles, {
    width: W,
    height: map.def.height,
    passable: (x, y) => !map.solid[y * W + x] && !c.occupied(x, y, a),
    extraCost: (x, y) => (host.surfaces(c.zoneId).some((s) => s.x === x && s.y === y && (s.type === 'fire' || s.type === 'poison')) ? 4 : 0),
  });
  const los = (from: Vec2, to: Vec2) => hasLineOfSight(from, to, (x, y) => map.opaque[y * W + x] === 1);
  let best: Plan | null = null;
  const consider = (p: Plan) => {
    if (!best || p.score > best.score) best = p;
  };
  const skills = a.skillIds().map((id) => getSkill(id)!).filter((s) => s && !s.passive && !s.utility && (a.cooldowns[s.id] ?? 0) <= 0 && s.ap <= a.ap);
  for (const skill of skills) {
    const range = skillRange(skill, stats);
    const candidates: { target?: Actor; point?: Vec2 }[] = [];
    if (skill.targeting === 'enemy') for (const e of forced ? [forced] : enemies) candidates.push({ target: e });
    else if (skill.targeting === 'ally') for (const al of allies) candidates.push({ target: al });
    else if (skill.targeting === 'self') candidates.push({});
    else for (const e of (skill.effects.some((x) => x.kind === 'heal') ? allies : enemies)) candidates.push({ point: { x: Math.round(e.x), y: Math.round(e.y) } });
    for (const cand of candidates) {
      if (banned.has(`${skill.id}:${cand.target?.id ?? ''}`)) continue;
      if (skill.effects.some((e) => e.kind === 'teleport' || e.kind === 'dash') && skill.targeting !== 'enemy') continue;
      const tgt = cand.target ?? cand.point;
      // Try from current spot first.
      const tryFrom = (from: Vec2, moveCostAp: number): Plan | null => {
        if (skill.ap + moveCostAp > a.ap) return null;
        if (tgt && skill.targeting !== 'self' && d(from, tgt) > range + 0.01) return null;
        if (tgt && range > 2 && skill.targeting !== 'self' && !los(from, tgt)) return null;
        const s = scoreSkill(c, host, a, skill, cand.target, cand.point, from);
        if (s <= 0) return null;
        // Penalize standing next to enemies for ranged units, reward efficiency.
        const ranged = stats.weaponRange > 2;
        const adj = enemies.filter((e) => d(e, from) < 1.8).length;
        const pos = ranged ? -adj * 6 : 0;
        return { score: (s + pos) / Math.max(1, skill.ap) - moveCostAp * 0.8, skill, target: cand.target, point: cand.point };
      };
      const here = tryFrom(a, 0);
      if (here) consider(here);
      if (skill.targeting === 'self' && !skill.radius) continue;
      // Search reachable tiles that put the target in range.
      let bestMove: Plan | null = null;
      for (const [idx, cost] of reach) {
        const x = idx % W, y = (idx / W) | 0;
        if (x === Math.round(a.x) && y === Math.round(a.y)) continue;
        const from = { x, y };
        if (skill.targeting === 'self' && skill.radius) {
          // AoE around self: move into the middle of enemies.
        } else if (tgt && d(from, tgt) > range + 0.01) continue;
        const apNeeded = cost <= a.movementLeft ? 0 : Math.ceil((cost - a.movementLeft) / stats.tilesPerAp);
        const p = tryFrom(from, apNeeded);
        if (p && (!bestMove || p.score > bestMove.score || (p.score === bestMove.score && cost < (bestMove as Plan & { c?: number }).c!))) {
          bestMove = { ...p, moveTo: from };
          (bestMove as Plan & { c?: number }).c = cost;
        }
      }
      if (bestMove) consider(bestMove);
    }
  }
  return best;
}

/** Move toward the nearest enemy when nothing useful can be done this turn. */
function approachPlan(c: Combat, a: Actor): Vec2 | null {
  const enemies = c.participants().filter((x) => x.alive() && isHostileTo(a, x));
  if (!enemies.length || a.ap <= 0) return null;
  const nearest = enemies.sort((p, q) => d(p, a) - d(q, a))[0]!;
  const ranged = a.stats().weaponRange > 2;
  const path = c.pathFor(a, nearest);
  if (!path) {
    // Target tile is occupied; path to a neighbor.
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const p = c.pathFor(a, { x: Math.round(nearest.x) + dx, y: Math.round(nearest.y) + dy });
        if (p && p.length) return p[p.length - 1]!;
      }
    return null;
  }
  if (!path.length) return null;
  const stopAt = ranged ? Math.max(1, path.length - 6) : path.length - 1;
  return path[Math.max(0, Math.min(path.length - 1, stopAt - 1))]!;
}

export async function runAiTurn(c: Combat, a: Actor, host: CombatHost, instant: boolean) {
  await sleep(instant ? 0 : 450);
  const banned = new Set<string>();
  let moves = 0;
  for (let step = 0; step < 8 && !c.ended && a.alive() && c.active === a; step++) {
    const plan = bestPlan(c, host, a, banned);
    if (!plan) {
      const to = moves < 2 ? approachPlan(c, a) : null;
      if (!to) break;
      moves++;
      if (await c.move(a, to)) break;
      continue;
    }
    if (plan.moveTo) {
      moves++;
      const err = await c.move(a, plan.moveTo);
      if (err) {
        if (plan.skill) banned.add(`${plan.skill.id}:${plan.target?.id ?? ''}`);
        if (moves > 3) break;
      }
      continue;
    }
    if (plan.skill) {
      const err = c.useSkill(a, plan.skill.id, plan.target, plan.point);
      if (err) {
        // Try the next best option instead of wasting the turn.
        banned.add(`${plan.skill.id}:${plan.target?.id ?? ''}`);
        continue;
      }
      await sleep(instant ? 0 : 800);
    }
  }
  void checkSkill;
}
