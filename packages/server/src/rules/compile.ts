/**
 * Ruleset compiler: turns an AI intent (names, structure, weights) into a complete Ruleset with numbers.
 * Deterministic. Every number comes from the power budget (see docs/rulesets.md), so content is roughly
 * balanced by construction; the balance loop then fine-tunes a few knobs.
 */
import {
  MONSTER_ROLES, RULESET_VERSION,
  type AffixDef, type AttributeDef, type BranchDef, type ClassDef, type ClassRole, type DamageTypeDef, type DifficultyId, type Effect, type ItemBaseDef,
  type KinDef, type Knots, type Modifier, type MonsterRole, type MonsterRoleDef, type PoolDef, type RarityDef, type RecipeDef, type Ruleset, type SkillDef,
  type SlotDef, type SlotKind, type StatId, type StatusDef, type SubtypeDef, type SurfaceDef, type TrapDef, type TreeNode, type WeaponDef,
} from '@gd/shared';
import type { Genre } from '../worldgen/genres';
import { defaultClasses, defaultCore, defaultGear, defaultTree } from './defaults';
import type { ClassTreeIntent, ClassesIntent, CoreIntent, GearIntent, RulesOverrides, RulesetIntent, SkillIntent, StatEffect } from './intent';

// ------------------------------------------------------------------------------------ budget constants

/** Power % of one attribute point, one passive rank, a capstone, an affix at rarity budget 1, a kin perk. */
const B_ATTR = 1.5;
const B_NODE = 5;
const B_CAPSTONE = 14;
const B_AFFIX = 5;
const B_PERK = 3;

// ------------------------------------------------------------------------------------ helpers

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const slug = (s: string) => norm(s).replace(/ /g, '_').slice(0, 28) || 'x';
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number, p = 3) => Math.round(v * 10 ** p) / 10 ** p;
const HEX = /^#[0-9a-f]{6}$/i;
const color = (c: string | undefined, fallback: string) => {
  const m = c?.trim().match(/#[0-9a-f]{6}/i)?.[0];
  return m && HEX.test(m) ? m : fallback;
};

class Ids {
  private used = new Set<string>();
  make(prefix: string, name: string): string {
    const base = `${prefix}${slug(name)}`;
    let id = base;
    for (let i = 2; this.used.has(id); i++) id = `${base}_${i}`;
    this.used.add(id);
    return id;
  }
}

/** Find a named thing (exact, then contains, then word overlap). */
function find<T>(list: T[], name: string | undefined, key: (t: T) => string): T | undefined {
  if (!name) return undefined;
  const n = norm(name);
  if (!n) return undefined;
  return list.find((x) => norm(key(x)) === n) ?? list.find((x) => norm(key(x)).includes(n) || n.includes(norm(key(x)))) ?? list.find((x) => norm(key(x)).split(' ').some((w) => w.length > 3 && n.split(' ').includes(w)));
}

// ------------------------------------------------------------------------------------ compile context

interface Ctx {
  r: Ruleset;
  ids: Ids;
  pools: PoolDef[];
  types: DamageTypeDef[];
  subs: SubtypeDef[];
  statuses: StatusDef[];
  /** Share of incoming damage per type/subtype (for pricing defenses). */
  typeShare: Record<string, number>;
  physicalPool?: PoolDef;
  magicalPool?: PoolDef;
  notes: string[];
}

/** Resolve an intent stat effect to a stat id, honouring disabled systems. */
function statFor(ctx: Ctx, effect: StatEffect, of?: string): StatId | null {
  const { r } = ctx;
  const type = () => (find(ctx.types, of, (t) => t.name) ?? ctx.types[0]!).id;
  const sub = () => find(ctx.subs, of, (s) => s.name);
  switch (effect) {
    case 'health': return 'hpPct';
    case 'health_regen': return 'hpRegen';
    case 'pool': {
      const p = find(ctx.pools, of, (x) => x.name) ?? ctx.pools[0];
      return p ? `pool:${p.id}` : 'hpPct';
    }
    case 'pool_regen': {
      const p = find(ctx.pools, of, (x) => x.name) ?? ctx.pools[0];
      return p ? `poolRegen:${p.id}` : 'hpRegen';
    }
    case 'melee_damage': return 'dmg:melee';
    case 'ranged_damage': return 'dmg:ranged';
    case 'skill_damage': return 'dmg:spell';
    case 'all_damage': return 'power';
    case 'type_damage': return `dmg:${type()}`;
    case 'subtype_damage': {
      const s = sub();
      return s && r.systems.subtypes ? `dmg:${s.id}` : `dmg:${s?.typeId ?? type()}`;
    }
    case 'healing': return 'healing';
    case 'crit_chance': return r.resolution.crit ? 'crit' : 'power';
    case 'crit_damage': return r.resolution.crit ? 'critDmg' : 'power';
    case 'dodge': return r.resolution.dodge ? 'dodge' : `mit:${ctx.types[0]!.id}`;
    case 'movement': return 'move';
    case 'initiative': return 'initiative';
    case 'mitigation': return `mit:${type()}`;
    case 'resist_all': return ctx.subs.length ? 'res:all' : `mit:${ctx.types[ctx.types.length - 1]!.id}`;
    case 'resist': {
      const s = sub();
      return s ? `res:${s.id}` : ctx.subs.length ? 'res:all' : `mit:${type()}`;
    }
    case 'trap_sense': return r.systems.traps ? 'trapSense' : null;
    case 'lockpicking': return r.systems.locks ? 'lockpick' : null;
    case 'barter': return 'barter';
    case 'loot_find': return 'lootFind';
    case 'life_steal': return 'lifesteal';
    case 'thorns': return 'thorns';
  }
}

/** Power % per unit of a stat's stored modifier value. */
function priceOf(ctx: Ctx, stat: StatId): number {
  const [head, arg] = stat.includes(':') ? [stat.slice(0, stat.indexOf(':')), stat.slice(stat.indexOf(':') + 1)] : [stat, ''];
  switch (head) {
    case 'hpPct': return 0.6;
    case 'hpRegen': return 240;
    case 'pool': return 1.6 / Math.max(10, ctx.pools.find((p) => p.id === arg)?.base ?? 40);
    case 'poolRegen': return 0.4;
    case 'dmg': return arg === 'melee' || arg === 'ranged' || arg === 'spell' ? 0.8 : ctx.subs.some((s) => s.id === arg) ? 0.45 : 0.7;
    case 'power': return 1;
    case 'healing': return 0.5;
    case 'crit': return 0.5;
    case 'critDmg': return 0.1;
    case 'dodge': return 0.7;
    case 'move': return 10;
    case 'initiative': return 0.3;
    case 'mit': return 60 * (ctx.typeShare[arg] ?? 0.5);
    case 'res': return arg === 'all' ? 0.36 : 0.6 * (ctx.typeShare[arg] ?? 0.1);
    case 'lifesteal': return 0.6;
    case 'thorns': return 40;
    case 'onhit': return 40;
    case 'trapSense':
    case 'lockpick': return 10;
    case 'barter': return 0.15;
    case 'lootFind': return 0.1;
    case 'attr': return B_ATTR;
    case 'taken': return 1;
    default: return 1;
  }
}

/** Modifiers worth `budget` power %, split over weighted stat picks. */
function priced(ctx: Ctx, picks: { effect: StatEffect; of?: string; weight: number }[], budget: number): Modifier[] {
  const resolved = picks.map((p) => ({ stat: statFor(ctx, p.effect, p.of), w: p.weight })).filter((p): p is { stat: string; w: number } => !!p.stat);
  if (!resolved.length) return [{ stat: 'hpPct', value: round(budget / priceOf(ctx, 'hpPct')) }];
  const total = resolved.reduce((s, p) => s + p.w, 0);
  const merged = new Map<string, number>();
  for (const p of resolved) merged.set(p.stat, (merged.get(p.stat) ?? 0) + (budget * p.w) / total / priceOf(ctx, p.stat));
  return [...merged].map(([stat, value]) => ({ stat, value: round(value, 4) }));
}

// ------------------------------------------------------------------------------------ core sections

function numbers(scale: CoreIntent['numbers']) {
  return scale === 'small' ? { dmg: 3, pool: 20, poolPer: 1 } : scale === 'large' ? { dmg: 30, pool: 120, poolPer: 8 } : { dmg: 8, pool: 50, poolPer: 3 };
}

const RARITY_COLORS = ['#d8d8d8', '#5fd35f', '#4fa3ff', '#c46bff', '#ffa630'];

function compileCore(r: Ruleset, ctx: Ctx, core: CoreIntent) {
  const n = numbers(core.numbers);
  r.curves.dmg = { base: n.dmg, lin: 0.2, quad: 0.012 };
  r.curves.hp = { base: n.dmg * 10, lin: 0.2, quad: 0.012 };
  r.curves.mit = { base: n.dmg * 3, lin: 0.2, quad: 0.012 };
  r.health = { name: core.health.name.slice(0, 24) || 'Health', color: color(core.health.color, '#c8322a') };
  const t = core.terminology;
  r.terminology = { xp: t.xp || 'Experience', level: t.level || 'Level', actionPoints: t.actionPoints || 'AP', party: t.party || 'Party', town: t.town || 'Town', dungeon: t.dungeon || 'Dungeon', wilderness: t.wilderness || 'Wilds', quest: t.quest || 'Quest', currency: t.currency || 'Gold', calling: t.calling || 'Role', kin: t.kin || 'Background' };
  r.economy.currency = r.terminology.currency;
  // Pools
  ctx.pools = core.pools.slice(0, 3).map((p) => ({ id: ctx.ids.make('p_', p.name), name: p.name, color: color(p.color, '#d8a440'), description: p.description, base: n.pool, perLevel: n.poolPer, regenPerTurn: 0.12 }));
  r.pools = ctx.pools;
  ctx.physicalPool = core.pools.map((p, i) => ({ p, i })).find((x) => x.p.use === 'physical') ? ctx.pools[core.pools.findIndex((p) => p.use === 'physical')] : ctx.pools[0];
  ctx.magicalPool = core.pools.findIndex((p) => p.use === 'magical') >= 0 ? ctx.pools[core.pools.findIndex((p) => p.use === 'magical')] : ctx.pools[ctx.pools.length - 1];
  // Damage types and subtypes
  ctx.types = core.damageTypes.slice(0, 3).map((d) => ({ id: ctx.ids.make('t_', d.name), name: d.name, color: color(d.color, '#d8d0c0'), description: d.description, mitigationName: d.mitigationName || `${d.name} defense` }));
  if (!ctx.types.length) ctx.types = [{ id: 't_physical', name: 'Physical', color: '#d8d0c0', description: '', mitigationName: 'Armor' }];
  r.damageTypes = ctx.types;
  ctx.subs = r.systems.subtypes
    ? core.subtypes.slice(0, 8).map((s) => ({ id: ctx.ids.make('s_', s.name), name: s.name, color: color(s.color, '#ffffff'), typeId: (find(ctx.types, s.type, (x) => x.name) ?? ctx.types[ctx.types.length - 1]!).id }))
    : [];
  r.subtypes = ctx.subs;
  // Rough share of incoming damage: the first type dominates; subtypes split their type's share.
  ctx.typeShare = {};
  ctx.types.forEach((ty, i) => (ctx.typeShare[ty.id] = ctx.types.length === 1 ? 1 : i === 0 ? 0.6 : 0.4 / (ctx.types.length - 1)));
  for (const s of ctx.subs) ctx.typeShare[s.id] = (ctx.typeShare[s.typeId] ?? 0.4) / Math.max(1, ctx.subs.filter((x) => x.typeId === s.typeId).length + 1);
  // Attributes
  r.attributes = core.attributes.slice(0, 6).map((a) => ({ id: ctx.ids.make('a_', a.name), name: a.name, abbr: (a.abbr || a.name.slice(0, 3)).toUpperCase().slice(0, 4), description: a.description, perPoint: [] as Modifier[], _effects: a.effects } as AttributeDef & { _effects: CoreIntent['attributes'][number]['effects'] }));
  // Statuses (after subtypes)
  ctx.statuses = [];
  for (const s of core.statuses.slice(0, 12)) {
    if (s.kind === 'control' && !r.control.enabled) continue;
    const id = ctx.ids.make('st_', s.name);
    const def: StatusDef = { id, name: s.name, color: color(s.color, '#c0c0c0'), description: s.description, harmful: s.kind !== 'buff' && s.kind !== 'heal_over_time' };
    if (s.kind === 'damage_over_time') {
      const sub = find(ctx.subs, s.subtype, (x) => x.name);
      def.dot = { coef: 0.32, subtypeId: sub?.id, typeId: sub?.typeId ?? ctx.types[0]!.id };
    }
    if (s.kind === 'heal_over_time') def.hot = { coef: 0.4 };
    if (s.kind === 'control') {
      def.control = s.control ?? 'root';
      if (def.control === 'slow') def.apLoss = 1;
    }
    const mods: Modifier[] = [];
    for (const st of s.stats ?? []) {
      const up = st.direction === 'up';
      const stat = statFor(ctx, st.effect, st.of);
      if (!stat) continue;
      if (stat.startsWith('mit:') || stat === 'res:all') mods.push({ stat: 'taken', value: up ? -20 : 25 });
      else if (stat === 'move') mods.push({ stat: 'move', value: up ? 1.5 : -1.5 });
      else if (stat === 'hpPct' || stat === 'hpRegen') mods.push({ stat: 'taken', value: up ? -15 : 15 });
      else mods.push({ stat, value: up ? 20 / Math.max(0.3, priceOf(ctx, stat)) * 0.8 : -20 / Math.max(0.3, priceOf(ctx, stat)) * 0.8 });
    }
    if (s.kind === 'buff' && !mods.length) mods.push({ stat: 'power', value: 20 });
    if (s.kind === 'debuff' && !mods.length) mods.push({ stat: 'power', value: -20 });
    if (mods.length) def.modifiers = dedupeMods(mods);
    ctx.statuses.push(def);
  }
  r.statuses = ctx.statuses;
  for (const s of ctx.subs) {
    const st = find(ctx.statuses, core.subtypes.find((x) => slug(x.name) === s.id.slice(2) || norm(x.name) === norm(s.name))?.status, (x) => x.name);
    if (st?.harmful) s.statusId = st.id;
  }
  // Attribute effects need statuses? No — but they need pools/types/subs, done above.
  for (const a of r.attributes as (AttributeDef & { _effects?: CoreIntent['attributes'][number]['effects'] })[]) {
    a.perPoint = priced(ctx, a._effects ?? [{ effect: 'health', weight: 1 }], B_ATTR);
    delete a._effects;
  }
  while (r.attributes.length < 3) r.attributes.push({ id: ctx.ids.make('a_', `Grit ${r.attributes.length}`), name: ['Grit', 'Focus', 'Luck'][r.attributes.length]!, abbr: 'ATR', description: '', perPoint: priced(ctx, [{ effect: 'health', weight: 1 }], B_ATTR) });
  // Surfaces
  r.surfaces = [];
  if (r.systems.surfaces) {
    for (const s of ctx.subs.filter((x) => x.statusId).slice(0, 4)) {
      const sf: SurfaceDef = { id: ctx.ids.make('sf_', s.name), name: `${s.name} Ground`, color: s.color, statusId: s.statusId, dot: { coef: 0.25, subtypeId: s.id, typeId: s.typeId } };
      s.surfaceId = sf.id;
      r.surfaces.push(sf);
    }
    // Opposing elements cancel (by common keywords).
    const fire = r.surfaces.find((x) => /fire|flame|plasma|burn|heat|sizzle|hell/i.test(x.name));
    const cold = r.surfaces.find((x) => /frost|ice|cold|cryo|chill|freez/i.test(x.name));
    if (fire && cold) {
      fire.reactions = [{ other: cold.id, result: null }];
      cold.reactions = [{ other: fire.id, result: null }];
    }
  }
  // Slots
  const slots: SlotDef[] = [];
  let hasWeapon = false;
  for (const s of core.slots.slice(0, 10)) {
    let kind = s.kind as SlotKind;
    if (kind === 'weapon') {
      if (hasWeapon) kind = 'offhand';
      hasWeapon = true;
    }
    slots.push({ id: ctx.ids.make('sl_', s.name), name: s.name, kind });
  }
  if (!hasWeapon) slots.unshift({ id: ctx.ids.make('sl_', 'Weapon'), name: 'Weapon', kind: 'weapon' });
  while (slots.length < 3) slots.push({ id: ctx.ids.make('sl_', `Gear ${slots.length}`), name: ['Body', 'Charm'][slots.length - 1] ?? 'Gear', kind: slots.length === 1 ? 'armor' : 'accessory' });
  r.slots = slots;
  // Rarities
  const rn = core.rarities.length === 5 ? core.rarities : ['Common', 'Fine', 'Rare', 'Epic', 'Legendary'];
  const budgets = [1, 1.12, 1.25, 1.42, 1.62];
  const weights = [60, 28, 9, 2.5, 0.4];
  const prices = [1, 1.8, 3.2, 6, 12];
  r.rarities = rn.map((name, i): RarityDef => ({ id: `r${i}`, name, color: RARITY_COLORS[i]!, affixes: [i, i], budget: budgets[i]!, weight: weights[i]!, priceMult: prices[i]! }));
  // Traps
  r.traps = r.systems.traps
    ? (core.traps.length ? core.traps : [{ name: 'Spike Trap' }]).slice(0, 6).map((tp): TrapDef => {
        const sub = find(ctx.subs, tp.subtype, (x) => x.name);
        const st = find(ctx.statuses, tp.status, (x) => x.name) ?? (sub?.statusId ? ctx.statuses.find((x) => x.id === sub.statusId) : undefined);
        return { id: ctx.ids.make('tr_', tp.name), name: tp.name, typeId: sub?.typeId ?? ctx.types[0]!.id, subtypeId: sub?.id, coef: 2.6, statusId: st?.harmful ? st.id : undefined, surfaceId: sub?.surfaceId, radius: sub?.surfaceId ? 1.5 : 0 };
      })
    : [];
  // Inventory
  r.inventory = { slots: clamp(core.inventory.slots, 20, 200), upgrades: clamp(core.inventory.upgrades, 0, 10), slotsPerUpgrade: 8, upgradeCost: 150 };
  // UI
  const g = { warm: [1.05, 1.03, 0.35, 0.03], cold: [0.9, 1.05, 0.35, 0.02], bleak: [0.7, 1.1, 0.55, 0.08], vivid: [1.2, 1.04, 0.25, 0.0], muted: [0.8, 1.0, 0.4, 0.04], neon: [1.3, 1.1, 0.4, 0.03] }[core.ui.mood] ?? [1, 1, 0.35, 0.02];
  r.ui = { material: core.ui.material, ornament: core.ui.ornament, typeface: core.ui.typeface, grading: { tint: color(core.ui.tint, '#ffffff'), saturation: g[0]!, contrast: g[1]!, vignette: g[2]!, grain: g[3]! } };
  r.name = core.name.slice(0, 60) || 'Rules';
  r.intro = core.intro.slice(0, 400);
}

function dedupeMods(mods: Modifier[]): Modifier[] {
  const m = new Map<string, number>();
  for (const x of mods) m.set(x.stat, (m.get(x.stat) ?? 0) + x.value);
  return [...m].map(([stat, value]) => ({ stat, value: round(value, 4) }));
}

// ------------------------------------------------------------------------------------ skills

const RANGE = { melee: 1.6, weapon: 0, short: 5, long: 9 } as const;
const AREA = { none: 0, small: 1.6, large: 2.4 } as const;
const AREA_TARGETS = { none: 1, small: 1.7, large: 2.4 } as const;
const COOLDOWN = { none: 0, short: 2, long: 4 } as const;
const COOLDOWN_MULT = { none: 1, short: 1.35, long: 1.75 } as const;
const COST_MULT = { none: 1, low: 1.1, medium: 1.25, high: 1.45 } as const;
const COST_FRAC = { none: 0, low: 0.12, medium: 0.22, high: 0.35 } as const;
const CONTROL_PRICE = { root: 0.6, silence: 0.8, disarm: 0.8, slow: 0.6 } as const;

function compileSkill(ctx: Ctx, s: SkillIntent, owner: string, pool: PoolDef | undefined, idPrefix: string): SkillDef {
  const { r } = ctx;
  const ap = clamp(s.ap, 1, 3);
  let targeting = s.targeting;
  const kinds = s.effects.map((e) => e.kind);
  const helpful = kinds.some((k) => k === 'heal' || k === 'revive' || k === 'cleanse' || k === 'barrier' || k === 'restore');
  const hurtful = kinds.some((k) => k === 'damage');
  if (targeting === 'ally' && hurtful && !helpful) targeting = 'enemy';
  if (targeting === 'enemy' && helpful && !hurtful) targeting = 'ally';
  const cost = pool ? s.cost : 'none';
  const cd = COOLDOWN[s.cooldown] ?? 0;
  let budget = ap * (COOLDOWN_MULT[s.cooldown] ?? 1) * (COST_MULT[cost] ?? 1) * (1 + 0.08 * clamp(s.tier, 0, 3));
  if (s.range === 'melee' && !s.usesWeapon) budget *= 1.1;
  if (!pool && s.cooldown === 'none' && ap >= 2) budget *= 0.95;
  const area = s.area ?? 'none';
  const perTarget = budget / AREA_TARGETS[area];
  const total = s.effects.reduce((sum, e) => sum + e.weight, 0) || 1;
  const effects: Effect[] = [];
  for (const e of s.effects) {
    const share = (e.weight / total) * perTarget;
    switch (e.kind) {
      case 'damage': {
        const sub = find(ctx.subs, e.of, (x) => x.name);
        const type = sub ? undefined : find(ctx.types, e.of, (x) => x.name);
        effects.push({ kind: 'damage', coef: round(share), weapon: s.usesWeapon || undefined, subtypeId: sub?.id, typeId: type?.id ?? (s.usesWeapon || sub ? undefined : (ctx.types[ctx.types.length - 1] ?? ctx.types[0]!).id) });
        break;
      }
      case 'heal':
        effects.push({ kind: 'heal', coef: round(share * 1.1) });
        break;
      case 'barrier':
        effects.push({ kind: 'barrier', coef: round(share * 1.3), turns: 2 });
        break;
      case 'status': {
        const st = find(ctx.statuses, e.of, (x) => x.name) ?? (hurtful ? ctx.statuses.find((x) => x.harmful && x.dot) : ctx.statuses.find((x) => !x.harmful));
        if (!st) {
          // No such status in this world: fold the budget into damage or healing.
          if (hurtful) effects.push({ kind: 'damage', coef: round(share), weapon: s.usesWeapon || undefined });
          else effects.push({ kind: 'heal', coef: round(share) });
          break;
        }
        const self = e.self || targeting === 'self' || (!st.harmful && targeting !== 'ally' && !area);
        if (st.dot) effects.push({ kind: 'status', statusId: st.id, chance: 1, turns: clamp(Math.round((share * 1.2) / st.dot.coef), 1, 4), self: self || undefined });
        else if (st.control) {
          const price = CONTROL_PRICE[st.control];
          const turns = share >= price * 2 ? 2 : 1;
          effects.push({ kind: 'status', statusId: st.id, chance: round(clamp(share / (price * turns), 0.3, 1), 2), turns, self: undefined });
        } else if (st.hot) effects.push({ kind: 'status', statusId: st.id, chance: 1, turns: clamp(Math.round((share * 1.1) / st.hot.coef), 1, 4), self: self || undefined });
        else {
          // Modifier statuses: ~0.8 DPA of value per turn per target.
          effects.push({ kind: 'status', statusId: st.id, chance: 1, turns: clamp(Math.round(share / 0.8), 1, 3), self: self || undefined });
        }
        break;
      }
      case 'surface': {
        const sub = find(ctx.subs, e.of, (x) => x.name);
        const sf = sub?.surfaceId ? r.surfaces.find((x) => x.id === sub.surfaceId) : r.surfaces[0];
        if (sf && r.systems.surfaces) effects.push({ kind: 'surface', surfaceId: sf.id, radius: AREA[area] || 1.2, turns: clamp(Math.round(share / 0.8), 1, 3) });
        else effects.push({ kind: 'damage', coef: round(share), weapon: s.usesWeapon || undefined, subtypeId: sub?.id });
        break;
      }
      case 'restore': {
        const p = find(ctx.pools, e.of, (x) => x.name) ?? pool ?? ctx.pools[0];
        if (p) effects.push({ kind: 'restore', poolId: p.id, amount: Math.round(share * p.base * 0.3) });
        else effects.push({ kind: 'heal', coef: round(share) });
        break;
      }
      case 'cleanse':
        effects.push({ kind: 'cleanse' });
        break;
      case 'revive':
        effects.push({ kind: 'revive', fraction: round(clamp(0.2 + share * 0.1, 0.25, 0.6), 2) });
        break;
      case 'lifesteal':
        effects.push({ kind: 'lifesteal', fraction: round(clamp(share * 0.25, 0.1, 0.6), 2) });
        break;
      case 'chain':
        effects.push({ kind: 'chain', jumps: clamp(Math.round(share / 0.8), 1, 4), falloff: 0.75 });
        break;
      case 'teleport':
        if (targeting !== 'ground') targeting = 'ground';
        effects.push({ kind: 'teleport' });
        break;
      case 'dash':
        effects.push({ kind: 'dash' });
        break;
      case 'push':
        effects.push({ kind: 'push', distance: 2 });
        break;
    }
  }
  if (!effects.length) effects.push({ kind: 'damage', coef: round(perTarget), weapon: s.usesWeapon || undefined });
  const radius = AREA[area] || undefined;
  const range = s.range === 'weapon' ? 0 : targeting === 'self' ? 0 : RANGE[s.range];
  const utilityOnly = effects.every((e) => e.kind === 'heal' || e.kind === 'cleanse' || e.kind === 'barrier' || e.kind === 'restore' || (e.kind === 'status' && !ctx.statuses.find((x) => x.id === e.statusId)?.harmful));
  return {
    id: ctx.ids.make(idPrefix, s.name),
    name: s.name.slice(0, 40),
    description: s.description.slice(0, 200),
    owner,
    targeting,
    range: range || (targeting === 'self' ? 0 : 1.6),
    weaponRange: s.range === 'weapon' || undefined,
    radius,
    ap,
    cooldown: cd,
    cost: pool && cost !== 'none' ? { poolId: pool.id, amount: Math.max(1, Math.round(pool.base * COST_FRAC[cost])) } : undefined,
    effects,
    rankBonus: 0.15,
    maxRank: s.tier >= 3 ? 2 : 3,
    tags: [s.usesWeapon ? 'weapon' : 'spell', ...(effects.some((e) => e.kind === 'heal') ? ['heal'] : [])],
    fx: s.fx ?? 'slash',
    outOfCombat: utilityOnly && targeting !== 'enemy' ? true : undefined,
    tune: 1,
  };
}

// ------------------------------------------------------------------------------------ items

const WEAPON_STYLE: Record<GearIntent['weapons'][number]['style'], Omit<WeaponDef, 'typeId' | 'scaling' | 'subtypeId'>> = {
  light_melee: { coef: 1.0, apCost: 2, range: 1.6 },
  heavy_melee: { coef: 1.3, apCost: 2, range: 1.6, twoHanded: true },
  quick_melee: { coef: 0.9, apCost: 1, range: 1.6 },
  ranged: { coef: 0.95, apCost: 2, range: 10, twoHanded: true, projectile: true },
  caster: { coef: 0.85, apCost: 2, range: 8, projectile: true },
  thrown: { coef: 0.9, apCost: 2, range: 6, projectile: true },
};

const ARMOR_TOTAL = { heavy: [0.55, 0.15], medium: [0.35, 0.3], light: [0.15, 0.45] } as const;
const SLOT_SHARE = (name: string) => (/body|chest|torso|coat|robe|suit|vest|rig/i.test(name) ? 0.4 : /head|helm|hat|hood|cap|visor/i.test(name) ? 0.22 : 0.17);

function compileItems(r: Ruleset, ctx: Ctx, gear: GearIntent) {
  const items: ItemBaseDef[] = [];
  const weaponSlot = r.slots.find((s) => s.kind === 'weapon')!;
  const offSlot = r.slots.find((s) => s.kind === 'offhand');
  const armorSlots = r.slots.filter((s) => s.kind === 'armor');
  const accSlots = r.slots.filter((s) => s.kind === 'accessory');
  const attrFor = (style: string) => {
    const want: StatId = style === 'ranged' || style === 'thrown' || style === 'quick_melee' ? 'dmg:ranged' : style === 'caster' ? 'dmg:spell' : 'dmg:melee';
    return r.attributes.find((a) => a.perPoint.some((m) => m.stat === want))?.id ?? r.attributes[0]!.id;
  };
  for (const w of gear.weapons.slice(0, 8)) {
    const st = WEAPON_STYLE[w.style] ?? WEAPON_STYLE.light_melee;
    const sub = find(ctx.subs, w.subtype, (x) => x.name);
    const type = find(ctx.types, w.damageType, (x) => x.name) ?? (w.style === 'caster' ? ctx.types[ctx.types.length - 1] : ctx.types[0])!;
    items.push({ id: ctx.ids.make('w_', w.name), name: w.name, description: w.description, category: 'equipment', slotId: weaponSlot.id, weapon: { ...st, typeId: sub?.typeId ?? type.id, subtypeId: sub?.id, scaling: attrFor(w.style) }, stackable: false, price: 40, dropWeight: 10, icon: w.style === 'ranged' ? 'bow' : w.style === 'caster' ? 'staff' : w.style === 'heavy_melee' ? 'axe' : w.style === 'quick_melee' ? 'dagger' : 'sword', tags: [w.style] });
  }
  if (!items.length) items.push({ id: 'w_blade', name: 'Blade', description: '', category: 'equipment', slotId: weaponSlot.id, weapon: { ...WEAPON_STYLE.light_melee, typeId: ctx.types[0]!.id, scaling: r.attributes[0]!.id }, stackable: false, price: 40, dropWeight: 10, icon: 'sword', tags: ['light_melee'] });
  // Armor: every (armor slot × weight) combination exists; names from the intent where given.
  const twoTypes = ctx.types.length > 1;
  for (const slot of armorSlots) {
    const share = SLOT_SHARE(slot.name);
    for (const weight of ['heavy', 'medium', 'light'] as const) {
      const named = gear.armor.find((a) => a.weight === weight && (norm(a.slot) === norm(slot.name) || find([slot], a.slot, (x) => x.name)));
      const [p, m] = ARMOR_TOTAL[weight];
      const defense: Record<string, number> = {};
      if (twoTypes) {
        defense[ctx.types[0]!.id] = round(p * share * 1.1);
        for (const t of ctx.types.slice(1)) defense[t.id] = round((m * share * 1.1) / (ctx.types.length - 1));
      } else defense[ctx.types[0]!.id] = round((p + m) * 0.6 * share * 1.1);
      items.push({ id: ctx.ids.make('a_', named?.name ?? `${weight} ${slot.name}`), name: named?.name ?? `${weight[0]!.toUpperCase()}${weight.slice(1)} ${slot.name}`, description: named?.description ?? '', category: 'equipment', slotId: slot.id, defense, stackable: false, price: 30, dropWeight: 4, icon: /head|helm|hat|hood|cap/i.test(slot.name) ? (weight === 'light' ? 'hood' : 'helm') : /hand|glove|gaunt|mitt/i.test(slot.name) ? 'gloves' : /feet|boot|shoe|greave|sandal|slipper/i.test(slot.name) ? 'boots' : weight === 'light' ? 'robe' : 'chest', tags: [weight] });
    }
  }
  if (offSlot) {
    const offs = gear.offhands.length ? gear.offhands : [{ name: 'Shield', style: 'shield' as const, description: '' }];
    for (const o of offs.slice(0, 4)) {
      const def: ItemBaseDef = { id: ctx.ids.make('o_', o.name), name: o.name, description: o.description, category: 'equipment', slotId: offSlot.id, stackable: false, price: 35, dropWeight: 5, icon: o.style === 'shield' ? 'shield' : 'book', tags: [o.style] };
      if (o.style === 'shield') def.defense = twoTypes ? { [ctx.types[0]!.id]: 0.3, [ctx.types[1]!.id]: 0.1 } : { [ctx.types[0]!.id]: 0.3 };
      if (o.style === 'focus') def.implicit = [{ stat: 'dmg:spell', value: 8 }, ...(ctx.magicalPool ? [{ stat: `pool:${ctx.magicalPool.id}`, value: Math.round(ctx.magicalPool.base * 0.15) }] : [])];
      if (o.style === 'quiver') def.implicit = [{ stat: 'dmg:ranged', value: 8 }];
      if (o.style === 'charm') def.implicit = r.resolution.crit ? [{ stat: 'crit', value: 4 }] : [{ stat: 'power', value: 5 }];
      items.push(def);
    }
  }
  for (const slot of accSlots) {
    const named = gear.accessories.find((a) => norm(a.slot) === norm(slot.name)) ?? gear.accessories[accSlots.indexOf(slot)];
    items.push({ id: ctx.ids.make('j_', named?.name ?? slot.name), name: named?.name ?? slot.name, description: named?.description ?? '', category: 'equipment', slotId: slot.id, stackable: false, price: 50, dropWeight: 3, icon: /amulet|neck|pendant|locket|chip/i.test(slot.name) ? 'amulet' : 'ring', tags: ['accessory'] });
  }
  // Potions
  for (const p of gear.potions.slice(0, 8)) {
    let use: ItemBaseDef['use'] | undefined;
    switch (p.effect) {
      case 'heal': use = { effects: [{ kind: 'heal', coef: 3.5 }], ap: 1, targeting: 'self', outOfCombat: true }; break;
      case 'restore': {
        const pool = find(ctx.pools, p.of, (x) => x.name) ?? ctx.pools[0];
        if (pool) use = { effects: [{ kind: 'restore', poolId: pool.id, amount: Math.round(pool.base * 0.5) }], ap: 1, targeting: 'self', outOfCombat: true };
        break;
      }
      case 'buff': {
        if (!r.systems.buffPotions) break;
        const st = find(ctx.statuses.filter((x) => !x.harmful), p.of, (x) => x.name) ?? ctx.statuses.find((x) => !x.harmful && x.modifiers);
        if (st) use = { effects: [{ kind: 'status', statusId: st.id, chance: 1, turns: 3, self: true }], ap: 1, targeting: 'self', outOfCombat: false };
        break;
      }
      case 'damage': {
        if (!r.systems.damagePotions) break;
        const sub = find(ctx.subs, p.of, (x) => x.name);
        const type = sub ? undefined : find(ctx.types, p.of, (x) => x.name);
        const effects: Effect[] = [{ kind: 'damage', coef: 2.4, subtypeId: sub?.id, typeId: type?.id ?? (sub ? undefined : ctx.types[0]!.id) }];
        if (sub?.surfaceId) effects.push({ kind: 'surface', surfaceId: sub.surfaceId, radius: 1.2, turns: 2 });
        use = { effects, ap: 1, targeting: 'ground', radius: 1.6, outOfCombat: false };
        break;
      }
      case 'cleanse': use = { effects: [{ kind: 'cleanse' }], ap: 1, targeting: 'self', outOfCombat: true }; break;
      case 'revive':
        if (r.revive === 'after_combat') break;
        use = { effects: [{ kind: 'revive', fraction: 0.3 }], ap: 2, targeting: 'ally', outOfCombat: true };
        break;
    }
    if (use) items.push({ id: ctx.ids.make('c_', p.name), name: p.name, description: p.description, category: 'potion', use, stackable: true, price: p.effect === 'heal' ? 15 : 20, dropWeight: p.effect === 'heal' ? 14 : 6, icon: p.effect === 'damage' ? 'bomb' : p.effect === 'heal' ? 'potion_red' : p.effect === 'restore' ? 'potion_blue' : 'potion_orange', tags: [p.effect] });
  }
  if (!items.some((i) => i.tags.includes('heal') && i.category === 'potion')) items.push({ id: ctx.ids.make('c_', 'Healing Draught'), name: 'Healing Draught', description: '', category: 'potion', use: { effects: [{ kind: 'heal', coef: 3.5 }], ap: 1, targeting: 'self', outOfCombat: true }, stackable: true, price: 15, dropWeight: 14, icon: 'potion_red', tags: ['heal'] });
  // Tools
  if (r.systems.traps) items.push({ id: 'tool_disarm', name: gear.tools.disarm || 'Trap Kit', description: '', category: 'tool', use: { effects: [], ap: 1, targeting: 'ground', outOfCombat: true, tool: 'disarm' }, stackable: true, price: 20, dropWeight: 4, icon: 'tools', tags: ['tool'] });
  if (r.systems.locks) items.push({ id: 'tool_unlock', name: gear.tools.unlock || 'Lockpick', description: '', category: 'tool', use: { effects: [], ap: 1, targeting: 'ground', outOfCombat: true, tool: 'unlock' }, stackable: true, price: 12, dropWeight: 4, icon: 'lockpick', tags: ['tool'] });
  items.push({ id: 'tool_recall', name: gear.tools.recall || 'Recall Scroll', description: '', category: 'tool', use: { effects: [], ap: 0, targeting: 'self', outOfCombat: true, tool: 'recall' }, stackable: true, price: 25, dropWeight: 3, icon: 'scroll', tags: ['tool'] });
  // Materials & valuables
  const mats = gear.materials.length ? gear.materials : [{ name: 'Scrap', description: '', tier: 1 }, { name: 'Reagent', description: '', tier: 2 }, { name: 'Essence', description: '', tier: 3 }];
  if (r.crafting.enabled || r.crafting.upgrades.enabled || r.crafting.enchanting.enabled) for (const m of mats.slice(0, 6)) items.push({ id: ctx.ids.make('m_', m.name), name: m.name, description: m.description, category: 'material', stackable: true, price: 4 + m.tier * 5, dropWeight: 9 - m.tier * 2, icon: ['ore', 'herb', 'essence'][m.tier - 1] ?? 'ore', tier: m.tier, tags: ['material'] });
  for (const v of (gear.valuables.length ? gear.valuables : [{ name: 'Gem' }]).slice(0, 4)) items.push({ id: ctx.ids.make('v_', v.name), name: v.name, description: '', category: 'valuable', stackable: true, price: 30, dropWeight: 4, icon: 'gem', tags: ['valuable'] });
  items.push({ id: 'quest_item', name: 'Quest Item', description: '', category: 'quest', stackable: false, price: 0, dropWeight: 0, icon: 'quest', tags: [] });
  items.push({ id: 'key', name: 'Key', description: '', category: 'key', stackable: false, price: 0, dropWeight: 0, icon: 'key', tags: [] });
  r.items = items;
}

function compileAffixes(r: Ruleset, ctx: Ctx, gear: GearIntent) {
  const named = new Map<string, { prefix: string; suffix: string }>();
  for (const a of gear.affixNames) {
    const stat = statFor(ctx, a.effect, a.of);
    if (stat && !named.has(stat)) named.set(stat, { prefix: a.prefix, suffix: a.suffix });
  }
  const W: SlotKind[] = ['weapon'], A: SlotKind[] = ['armor', 'offhand'], J: SlotKind[] = ['accessory'];
  const list: [StatId, SlotKind[], number, string, string][] = [
    ['hpPct', [...A, ...J], 10, 'Hale', 'of Vigor'],
    ['dmg:melee', [...W, ...J], 6, 'Brutal', 'of Force'],
    ['dmg:ranged', [...W, ...J], 6, 'Deadeye', 'of the Hawk'],
    ['dmg:spell', [...W, ...J, 'offhand'], 6, 'Arcane', 'of Power'],
    ['healing', ['offhand', ...J, 'weapon'], 4, 'Blessed', 'of Mercy'],
    ['hpRegen', ['armor', ...J], 3, 'Renewing', 'of Renewal'],
    ['move', ['armor'], 3, 'Fleet', 'of Haste'],
    ['initiative', [...J, 'armor'], 3, 'Alert', 'of Readiness'],
    ['lifesteal', [...W, ...J], 2, 'Vampiric', 'of the Leech'],
    ['thorns', ['armor', 'offhand'], 3, 'Thorned', 'of Thorns'],
    ['barter', J, 2, 'Silver', 'of Commerce'],
    ['lootFind', [...J, 'armor'], 2, 'Lucky', 'of Fortune'],
  ];
  if (r.resolution.crit) list.push(['crit', [...W, ...J, 'armor'], 6, 'Keen', 'of Precision'], ['critDmg', [...W, ...J], 4, 'Savage', 'of Carnage']);
  if (r.resolution.dodge) list.push(['dodge', ['armor', ...J], 4, 'Evasive', 'of Shadows']);
  if (r.systems.traps) list.push(['trapSense', [...J, 'armor'], 2, 'Wary', 'of Caution']);
  if (r.systems.locks) list.push(['lockpick', [...J, 'armor'], 2, 'Nimble', 'of Locks']);
  ctx.types.forEach((t, i) => list.push([`mit:${t.id}`, A, 8, ['Reinforced', 'Hardened', 'Warded', 'Braced', 'Tempered'][i % 5]!, `of ${t.mitigationName}`]));
  for (const s of ctx.subs.slice(0, 6)) list.push([`res:${s.id}`, [...A, ...J], 3, `${s.name}proof`, `of ${s.name} Warding`], [`dmg:${s.id}`, [...W, ...J], 3, `${s.name}`, `of ${s.name}`]);
  for (const s of ctx.subs.filter((x) => x.statusId).slice(0, 3)) list.push([`onhit:${s.id}`, W, 3, `${s.name}-laced`, `of ${s.name}`]);
  for (const p of ctx.pools) list.push([`pool:${p.id}`, [...A, ...J, 'weapon'], 5, 'Tireless', `of ${p.name}`], [`poolRegen:${p.id}`, [...J, 'offhand'], 3, 'Flowing', `of ${p.name} Flow`]);
  for (const a of r.attributes) list.push([`attr:${a.id}`, [...J, 'armor', 'weapon', 'offhand'], 4, a.name, `of ${a.name}`]);
  r.affixes = list.map(([stat, slotKinds, weight, prefix, suffix]): AffixDef => {
    const n = named.get(stat);
    const value = stat.startsWith('attr:') ? Math.max(1, Math.round(B_AFFIX / B_ATTR)) : round(B_AFFIX / priceOf(ctx, stat), 4);
    const pct = !['hp', 'hpRegen', 'thorns', 'trapSense', 'lockpick'].includes(stat) && !stat.startsWith('onhit:') && !stat.startsWith('mit:') && !stat.startsWith('pool:') && !stat.startsWith('attr:') && stat !== 'move' && stat !== 'initiative';
    return { id: `af_${slug(stat)}`, prefix: n?.prefix ?? prefix, suffix: n?.suffix ?? suffix, stat, slotKinds, weight, value, perLevel: pct ? round(value * 0.03, 4) : 0, cap: stat === 'crit' ? 15 : stat === 'dodge' ? 12 : stat === 'lifesteal' ? 8 : undefined };
  });
}

function compileRecipes(r: Ruleset) {
  const mats = r.items.filter((i) => i.category === 'material').sort((a, b) => (a.tier ?? 1) - (b.tier ?? 1));
  r.recipes = [];
  if (!r.crafting.enabled || !mats.length) return;
  const m = (tier: number) => mats.find((x) => x.tier === tier) ?? mats[Math.min(mats.length - 1, tier - 1)]!;
  const potions = r.items.filter((i) => i.category === 'potion');
  potions.forEach((p, i) => r.recipes.push({ id: `rc_${p.id}`, name: `Make ${p.name}`, inputs: [{ itemId: m(1 + (i % 2)).id, qty: 2 }], output: { itemId: p.id, qty: 1 }, gold: 0 }));
  if (r.items.some((i) => i.id === 'tool_disarm')) r.recipes.push({ id: 'rc_disarm', name: `Make ${r.items.find((i) => i.id === 'tool_disarm')!.name}`, inputs: [{ itemId: m(1).id, qty: 2 }], output: { itemId: 'tool_disarm', qty: 1 }, gold: 0 });
  if (r.items.some((i) => i.id === 'tool_unlock')) r.recipes.push({ id: 'rc_unlock', name: `Make ${r.items.find((i) => i.id === 'tool_unlock')!.name}`, inputs: [{ itemId: m(1).id, qty: 1 }], output: { itemId: 'tool_unlock', qty: 2 }, gold: 0 });
  r.recipes.push({ id: 'rc_weapon', name: 'Forge a weapon', inputs: [{ itemId: m(1).id, qty: 4 }, { itemId: m(2).id, qty: 1 }], output: { slotKind: 'weapon', rarityId: 'r1' }, gold: 20 });
  r.recipes.push({ id: 'rc_armor', name: 'Make armor', inputs: [{ itemId: m(1).id, qty: 3 }, { itemId: m(2).id, qty: 1 }], output: { slotKind: 'armor', rarityId: 'r1' }, gold: 15 });
  r.recipes.push({ id: 'rc_trinket', name: 'Craft a trinket', inputs: [{ itemId: m(3).id, qty: 2 }, { itemId: m(2).id, qty: 2 }], output: { slotKind: 'accessory', rarityId: 'r2' }, gold: 40 });
  r.recipes.push({ id: 'rc_fine', name: 'Forge a masterwork weapon', inputs: [{ itemId: m(2).id, qty: 4 }, { itemId: m(3).id, qty: 2 }], output: { slotKind: 'weapon', rarityId: 'r2' }, gold: 60 });
}

// ------------------------------------------------------------------------------------ classes, kins, monsters

const ROLE_AI: Record<ClassRole, MonsterRole> = { tank: 'guardian', melee: 'assassin', ranged: 'archer', caster: 'caster', support: 'healer', hybrid: 'skirmisher' };

function compileClasses(r: Ruleset, ctx: Ctx, classes: ClassesIntent, trees: ClassTreeIntent[], genre: Genre) {
  r.classes = [];
  const fallbackClasses = defaultClasses(genre).classes;
  const list = classes.classes.length >= 2 ? classes.classes : fallbackClasses;
  list.slice(0, 6).forEach((c, ci) => {
    const id = ctx.ids.make('cl_', c.name);
    const primary = c.primaryAttributes.map((n) => find(r.attributes, n, (a) => a.name)?.id).filter((x): x is string => !!x);
    if (!primary.length) primary.push(r.attributes[ci % r.attributes.length]!.id);
    const attributes: Record<string, number> = {};
    primary.forEach((a, i) => (attributes[a] = (attributes[a] ?? 0) + (i === 0 ? 3 : 2)));
    const magical = c.role === 'caster' || c.role === 'support';
    const pool = find(ctx.pools, c.pool, (p) => p.name) ?? (magical ? ctx.magicalPool : ctx.physicalPool) ?? ctx.pools[0];
    // Gear
    const weapons = r.items.filter((i) => i.weapon);
    const wantStyle = c.role === 'ranged' ? 'ranged' : c.role === 'caster' ? 'caster' : c.role === 'melee' ? 'quick_melee' : 'light_melee';
    const weapon = find(weapons, c.weapon, (w) => w.name) ?? weapons.find((w) => w.tags.includes(wantStyle)) ?? weapons[0]!;
    const startingGear: Record<string, string> = { [weapon.slotId!]: weapon.id };
    for (const slot of r.slots.filter((s) => s.kind === 'armor')) {
      const piece = r.items.find((i) => i.slotId === slot.id && i.tags.includes(c.armor));
      if (piece && (/body|chest|torso|coat|robe|suit|vest|rig|sweater|undersuit/i.test(slot.name) || /head|helm|hat|hood|cap|visor/i.test(slot.name))) startingGear[slot.id] = piece.id;
    }
    const off = r.slots.find((s) => s.kind === 'offhand');
    if (off && !weapon.weapon?.twoHanded && c.offhand) {
      const o = find(r.items.filter((i) => i.slotId === off.id), c.offhand, (x) => x.name);
      if (o) startingGear[off.id] = o.id;
    }
    // Tree
    const tree = trees[ci] && trees[ci]!.skills.length >= 4 ? trees[ci]! : defaultTree(genre, c.role, c.name);
    const branches: BranchDef[] = c.branches.slice(0, 3).map((b) => ({ id: ctx.ids.make('b_', `${c.name} ${b.name}`), name: b.name, description: b.theme }));
    while (branches.length < 3) branches.push({ id: ctx.ids.make('b_', `${c.name} ${branches.length}`), name: ['Offense', 'Defense', 'Utility'][branches.length]!, description: '' });
    const skillIntents = [...tree.skills];
    // Make sure every class has at least six skills and a damaging tier-0 skill.
    if (skillIntents.length < 6) for (const s of defaultTree(genre, c.role, c.name).skills) if (skillIntents.length < 6 && !skillIntents.some((x) => norm(x.name) === norm(s.name))) skillIntents.push(s);
    const skills = skillIntents.slice(0, 12).map((s) => ({ intent: s, def: compileSkill(ctx, s, id, pool, `${id.slice(3, 9)}_`) }));
    r.skills.push(...skills.map((s) => s.def));
    const byTier = (b: number) => skills.filter((s) => clamp(s.intent.branch, 0, 2) === b).sort((x, y) => x.intent.tier - y.intent.tier);
    const starting: string[] = [];
    for (const b of [0, 1, 2]) {
      const first = byTier(b)[0];
      if (first && starting.length < 2 && first.intent.tier === 0) starting.push(first.def.id);
    }
    for (const s of skills) if (starting.length < 2 && !starting.includes(s.def.id)) starting.push(s.def.id);
    if (!skills.some((s) => starting.includes(s.def.id) && s.def.effects.some((e) => e.kind === 'damage'))) {
      const dmg = skills.find((s) => s.def.effects.some((e) => e.kind === 'damage'));
      if (dmg) starting[1] = dmg.def.id;
    }
    const nodes: TreeNode[] = [];
    for (const s of skills) {
      const b = branches[clamp(s.intent.branch, 0, 2)]!.id;
      const tier = clamp(s.intent.tier, 0, 3);
      if (!starting.includes(s.def.id)) nodes.push({ id: `n_${s.def.id}`, name: s.def.name, description: s.def.description, kind: 'skill', branch: b, tier, maxRank: 1, skillId: s.def.id });
      if (s.def.maxRank > 1) nodes.push({ id: `n_${s.def.id}_rank`, name: `${s.def.name} Mastery`, description: `Improves ${s.def.name}.`, kind: 'rank', branch: b, tier: Math.min(3, tier + 1), maxRank: s.def.maxRank - 1, skillId: s.def.id });
    }
    for (const p of tree.passives.slice(0, 9)) {
      const b = branches[clamp(p.branch, 0, 2)]!.id;
      const cap = p.capstone;
      nodes.push({ id: ctx.ids.make('n_', `${c.name} ${p.name}`), name: p.name, description: p.description, kind: cap ? 'capstone' : 'passive', branch: b, tier: cap ? 3 : clamp(p.tier, 0, 2), maxRank: cap ? 1 : 3, modifiers: priced(ctx, p.effects, cap ? B_CAPSTONE : B_NODE) });
    }
    // Every branch needs something at tier 0.
    for (const b of branches) if (!nodes.some((n) => n.branch === b.id && n.tier === 0)) {
      const lowest = nodes.filter((n) => n.branch === b.id).sort((x, y) => x.tier - y.tier)[0];
      if (lowest) lowest.tier = 0;
      else nodes.push({ id: ctx.ids.make('n_', `${c.name} ${b.name} training`), name: `${b.name} Training`, description: '', kind: 'passive', branch: b.id, tier: 0, maxRank: 3, modifiers: priced(ctx, [{ effect: 'health', weight: 1 }, { effect: 'all_damage', weight: 1 }], B_NODE) });
    }
    const def: ClassDef = { id, name: c.name, description: c.description, role: c.role, primaryAttributes: primary, attributes, startingSkills: starting, startingGear, branches, nodes, tune: { hp: 1, dmg: 1 }, aiRole: ROLE_AI[c.role] ?? 'skirmisher' };
    if (c.role === 'tank') def.tune = { hp: 1.15, dmg: 0.9 };
    if (c.role === 'support') def.tune = { hp: 1.0, dmg: 0.85 };
    if (c.role === 'caster') def.tune = { hp: 0.85, dmg: 1.08 };
    r.classes.push(def);
  });
  // Shared attribute branch
  r.attributeNodes = r.attributes.map((a) => ({ id: `n_attr_${a.id}`, name: a.name, description: a.description, kind: 'attribute' as const, branch: 'attributes', tier: 0, maxRank: 99, attributeId: a.id }));
}

function compileKins(r: Ruleset, ctx: Ctx, gear: GearIntent) {
  const kins = gear.kins.length ? gear.kins : [{ name: 'Human', description: '', attributes: [], perk: undefined }];
  r.kins = kins.slice(0, 6).map((k): KinDef => {
    const attributes: Record<string, number> = {};
    let total = 0;
    for (const a of k.attributes) {
      const id = find(r.attributes, a.attribute, (x) => x.name)?.id;
      if (!id || total >= 3) continue;
      const pts = clamp(a.points, 1, 3 - total);
      attributes[id] = (attributes[id] ?? 0) + pts;
      total += pts;
    }
    return { id: ctx.ids.make('k_', k.name), name: k.name, description: k.description, attributes, modifiers: k.perk ? priced(ctx, [k.perk], B_PERK) : [] };
  });
}

function monsterSkills(r: Ruleset, ctx: Ctx) {
  const T = (s: SkillDef) => (r.skills.push(s), s.id);
  const sk = (id: string, name: string, targeting: SkillDef['targeting'], range: number, ap: number, cooldown: number, effects: Effect[], fx: SkillDef['fx'], extra: Partial<SkillDef> = {}): SkillDef => ({ id, name, description: '', owner: 'monster', targeting, range, ap, cooldown, effects, rankBonus: 0, maxRank: 1, tags: [effects.some((e) => e.kind === 'damage' && e.weapon) ? 'weapon' : 'spell'], fx, tune: 1, ...extra });
  const harmful = (control?: string) => ctx.statuses.find((s) => (control ? s.control === control : s.harmful && !s.control && !s.dot && s.modifiers));
  const weak = harmful();
  const root = r.control.enabled ? harmful('root') : undefined;
  const bleed = ctx.statuses.find((s) => s.dot && s.dot.typeId === ctx.types[0]!.id) ?? ctx.statuses.find((s) => s.dot);
  const fam = '$family';
  const ids: Record<MonsterRole, string[]> = {
    brute: [T(sk('m_crush', 'Crushing Blow', 'enemy', 1.6, 2, 2, [{ kind: 'damage', coef: 2.6, weapon: true }], 'slash', { weaponRange: true })), T(sk('m_slam', 'Ground Slam', 'self', 0, 3, 3, [{ kind: 'damage', coef: 2.2, weapon: true }, { kind: 'push', distance: 1 }], 'nova', { radius: 1.8 }))],
    skirmisher: [T(sk('m_lunge', 'Lunge', 'enemy', 5, 2, 2, [{ kind: 'dash' }, { kind: 'damage', coef: 2.0, weapon: true }], 'slash')), ...(bleed ? [T(sk('m_rend', 'Rend', 'enemy', 1.6, 1, 1, [{ kind: 'damage', coef: 0.8, weapon: true }, { kind: 'status', statusId: bleed.id, chance: 0.7, turns: 2 }], 'slash'))] : [])],
    archer: [T(sk('m_aimed', 'Aimed Shot', 'enemy', 0, 2, 2, [{ kind: 'damage', coef: 2.7, weapon: true }], 'arrow', { weaponRange: true })), ...(root ? [T(sk('m_pin', 'Pinning Shot', 'enemy', 0, 2, 3, [{ kind: 'damage', coef: 1.4, weapon: true }, { kind: 'status', statusId: root.id, chance: 0.6, turns: 1 }], 'arrow', { weaponRange: true }))] : [])],
    caster: [T(sk('m_bolt', 'Bolt', 'enemy', 8, 2, 0, [{ kind: 'damage', coef: 2.1, subtypeId: fam, typeId: ctx.types[ctx.types.length - 1]!.id }, { kind: 'status', statusId: fam, chance: 0.4, turns: 2 }], 'bolt')), T(sk('m_blast', 'Blast', 'ground', 8, 3, 3, [{ kind: 'damage', coef: 2.0, subtypeId: fam, typeId: ctx.types[ctx.types.length - 1]!.id }], 'nova', { radius: 1.6 }))],
    healer: [T(sk('m_heal', 'Mend', 'ally', 8, 1, 1, [{ kind: 'heal', coef: 2.4 }], 'heal')), T(sk('m_smite', 'Smite', 'enemy', 8, 2, 0, [{ kind: 'damage', coef: 1.8, subtypeId: fam, typeId: ctx.types[ctx.types.length - 1]!.id }], 'beam'))],
    swarm: [T(sk('m_bite', 'Bite', 'enemy', 1.6, 1, 0, [{ kind: 'damage', coef: 1.0, weapon: true }], 'slash'))],
    guardian: [T(sk('m_guard', 'Guard', 'self', 0, 1, 3, [{ kind: 'barrier', coef: 2.6, turns: 2 }], 'buff')), T(sk('m_bash', 'Bash', 'enemy', 1.6, 2, 2, [{ kind: 'damage', coef: 1.8, weapon: true }, ...(weak ? [{ kind: 'status' as const, statusId: weak.id, chance: 0.7, turns: 2 }] : [])], 'slash'))],
    assassin: [T(sk('m_ambush', 'Ambush', 'enemy', 1.6, 2, 2, [{ kind: 'damage', coef: 3.0, weapon: true }], 'shadow')), T(sk('m_blink', 'Blink', 'ground', 6, 1, 3, [{ kind: 'teleport' }], 'shadow'))],
  };
  return ids;
}

function compileMonsters(r: Ruleset, ctx: Ctx) {
  const skills = monsterSkills(r, ctx);
  const t0 = ctx.types[0]!.id, t1 = ctx.types[1]?.id;
  const def = (hp: number, dmg: number, phys: number, mag: number, range: number, move: number, initiative: number, threat: number, role: MonsterRole): MonsterRoleDef => ({
    hp, dmg, range, move, initiative, threat, skills: skills[role],
    defense: t1 ? { [t0]: phys, ...Object.fromEntries(ctx.types.slice(1).map((t) => [t.id, mag])) } : { [t0]: (phys + mag) / 2 },
  });
  r.monsters = {
    brute: def(1.4, 1.15, 0.4, 0.1, 1.6, 1, 0, 1.2, 'brute'),
    skirmisher: def(0.9, 1.0, 0.2, 0.15, 1.6, 1.4, 4, 1, 'skirmisher'),
    archer: def(0.75, 0.95, 0.15, 0.15, 9, 1, 2, 1, 'archer'),
    caster: def(0.7, 1.05, 0.08, 0.35, 8, 1, 1, 1.1, 'caster'),
    healer: def(0.8, 0.6, 0.12, 0.3, 7, 1, 1, 1.1, 'healer'),
    swarm: def(0.45, 0.55, 0.1, 0.1, 1.6, 1.3, 3, 0.45, 'swarm'),
    guardian: def(1.7, 0.8, 0.6, 0.3, 1.6, 0.8, -2, 1.3, 'guardian'),
    assassin: def(0.8, 1.3, 0.15, 0.15, 1.6, 1.3, 5, 1.2, 'assassin'),
  };
  for (const role of MONSTER_ROLES) if (!r.monsters[role]) throw new Error(`missing monster role ${role}`);
}

// ------------------------------------------------------------------------------------ progression & difficulty

/** Provisional curve; the world assembler re-solves it from the world's actual content. */
export function provisionalXp(maxLevel: number): number[] {
  const xp = [0, 0];
  for (let l = 2; l <= maxLevel; l++) xp.push(Math.round(120 * Math.pow(l - 1, 1.8) + 80 * (l - 1)));
  return xp;
}

function defaultDifficulty(maxLevel: number): Ruleset['difficulty'] {
  // Low levels get gentler multipliers: fights there are only a few hits long.
  const k = (lo: number, hi: number): Knots => [{ level: 1, value: lo }, { level: Math.min(4, maxLevel), value: hi }, { level: maxLevel, value: hi }];
  const d: Ruleset['difficulty'] = {
    story: { name: 'Story', enemyHp: k(0.7, 0.55), enemyDmg: k(0.65, 0.5), extraEnemyChance: 0, eliteChance: 0, lootMult: 1 },
    easy: { name: 'Easy', enemyHp: k(0.88, 0.78), enemyDmg: k(0.85, 0.75), extraEnemyChance: 0, eliteChance: 0.02, lootMult: 1 },
    normal: { name: 'Normal', enemyHp: k(1, 1), enemyDmg: k(1, 1), extraEnemyChance: 0, eliteChance: 0.06, lootMult: 1 },
    hard: { name: 'Hard', enemyHp: k(1.08, 1.25), enemyDmg: k(1.08, 1.25), extraEnemyChance: 0.25, eliteChance: 0.12, lootMult: 1.15 },
    brutal: { name: 'Brutal', enemyHp: k(1.15, 1.5), enemyDmg: k(1.15, 1.45), extraEnemyChance: 0.5, eliteChance: 0.2, lootMult: 1.3 },
  };
  return d;
}

// ------------------------------------------------------------------------------------ entry point

export interface CompileOptions {
  genre: Genre;
  maxLevel: number;
  overrides?: RulesOverrides;
  id?: string;
}

function blank(opts: CompileOptions, core: CoreIntent): Ruleset {
  const o = opts.overrides ?? {};
  const sys = core.systems;
  return {
    version: RULESET_VERSION,
    id: opts.id ?? 'rules',
    name: '',
    intro: '',
    turn: { model: o.turnModel ?? 'ap', apPerTurn: 4, apMax: 6, apStart: 4, tilesPerAp: 3 },
    death: { mode: o.deathMode ?? 'corpse_run', keepGold: true },
    revive: o.revive ?? core.rules.revive ?? 'special',
    resolution: { variance: { low: 0.08, medium: 0.15, high: 0.25 }[core.rules.variance] ?? 0.15, crit: o.crit ?? core.rules.crit, baseCrit: 5, critMult: 1.5, critCap: 0.6, dodge: o.dodge ?? core.rules.dodge, baseDodge: 0, dodgeCap: 0.45 },
    control: { enabled: o.control ?? sys.control, immunityTurns: 2 },
    recovery: { secondsToFull: 25 },
    party: { soloBonus: { hp: 1.5, dmg: 1.3, ap: 1 } },
    health: { name: 'Health', color: '#c8322a' },
    pools: [], attributes: [], attributeBase: 5, damageTypes: [], subtypes: [], statuses: [], surfaces: [], slots: [], rarities: [],
    skills: [], basicAttackId: 'attack', kins: [], classes: [], attributeNodes: [], items: [], affixes: [], recipes: [], traps: [],
    monsters: {} as Ruleset['monsters'],
    elite: { hp: 1.8, dmg: 1.25 },
    boss: { hp: 5.5, dmg: 1.45 },
    curves: { hp: { base: 80, lin: 0.2, quad: 0.012 }, dmg: { base: 8, lin: 0.2, quad: 0.012 }, mit: { base: 24, lin: 0.2, quad: 0.012 }, monsterHp: [{ level: 1, value: 1 }, { level: opts.maxLevel, value: 1 }], monsterDmg: [{ level: 1, value: 0.6 }, { level: opts.maxLevel, value: 0.6 }] },
    progression: { maxLevel: opts.maxLevel, xp: provisionalXp(opts.maxLevel), treePointsStart: 1, treePointsPerLevel: opts.maxLevel <= 14 ? 2 : 1, attributePerRank: 3, tierRequirements: opts.maxLevel <= 14 ? [0, 2, 5, 8] : [0, 2, 4, 6], killXp: { base: 20, lin: 0.45, quad: 0 } },
    economy: { currency: 'Gold', sellRatio: 0.3, priceMult: 1, goldPerKill: { base: 3, lin: 0.5, quad: 0 } },
    inventory: { slots: 40, upgrades: 4, slotsPerUpgrade: 8, upgradeCost: 150 },
    crafting: { enabled: o.crafting ?? sys.crafting, upgrades: { enabled: o.upgrades ?? sys.upgrades, maxLevel: 5, perLevel: 0.08, gold: 30 }, enchanting: { enabled: o.enchanting ?? sys.enchanting, gold: 50 } },
    systems: { traps: o.traps ?? sys.traps, locks: o.locks ?? sys.locks, surfaces: o.surfaces ?? sys.surfaces, subtypes: core.subtypes.length > 0, statuses: true, buffPotions: sys.buffPotions, damagePotions: sys.damagePotions, dynamicQuests: true },
    difficulty: defaultDifficulty(opts.maxLevel),
    terminology: { xp: 'Experience', level: 'Level', actionPoints: 'AP', party: 'Party', town: 'Town', dungeon: 'Dungeon', wilderness: 'Wilds', quest: 'Quest', currency: 'Gold' },
    ui: { material: 'parchment', ornament: 'filigree', grading: { tint: '#ffffff', saturation: 1, contrast: 1, vignette: 0.35, grain: 0.02 } },
  };
}

/** Merge partial/invalid intent parts with the genre defaults. */
export function completeIntent(intent: Partial<RulesetIntent>, genre: Genre): RulesetIntent {
  const core = intent.core ?? defaultCore(genre);
  const gear = intent.gear ?? defaultGear(genre);
  const classes = intent.classes && intent.classes.classes.length >= 2 ? intent.classes : defaultClasses(genre);
  const trees = classes.classes.map((c, i) => (intent.trees?.[i] && intent.trees[i]!.skills.length >= 4 ? intent.trees[i]! : defaultTree(genre, c.role, c.name)));
  return { core, gear, classes, trees };
}

export function compileRuleset(intentIn: Partial<RulesetIntent>, opts: CompileOptions): Ruleset {
  const intent = completeIntent(intentIn, opts.genre);
  if (opts.overrides?.classes) intent.classes = { classes: intent.classes.classes.slice(0, Math.max(2, opts.overrides.classes)) };
  const r = blank(opts, intent.core);
  const ctx: Ctx = { r, ids: new Ids(), pools: [], types: [], subs: [], statuses: [], typeShare: {}, notes: [] };
  compileCore(r, ctx, intent.core);
  r.skills = [{ id: 'attack', name: 'Attack', description: 'Strike with your weapon.', owner: 'general', targeting: 'enemy', range: 1.6, weaponRange: true, ap: 2, cooldown: 0, effects: [{ kind: 'damage', coef: 1, weapon: true }], rankBonus: 0, maxRank: 1, tags: ['basic', 'weapon'], fx: 'slash', tune: 1 }];
  compileItems(r, ctx, intent.gear);
  compileAffixes(r, ctx, intent.gear);
  compileRecipes(r);
  compileClasses(r, ctx, intent.classes, intent.trees, opts.genre);
  compileKins(r, ctx, intent.gear);
  compileMonsters(r, ctx);
  return r;
}

export type { DifficultyId };
