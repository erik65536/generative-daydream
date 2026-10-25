/**
 * Binds a world's content to its ruleset: family damage subtypes, class looks, unique item powers, trap kinds,
 * quest rewards and the level curve (solved from the world's own content). Used at assembly and when a world's
 * rules are regenerated or rebalanced.
 */
import {
  ROLE_VISUAL, Rng, curve, rx,
  type Modifier, type QuestDef, type Ruleset, type SlotKind, type UniqueItemDef, type WorldDefinition,
} from '@gd/shared';
import { affixValue } from '../game/loot';
import type { ClassesIntent } from './intent';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function matchByName<T>(name: string | undefined, list: T[], key: (t: T) => string): T | undefined {
  if (!name) return undefined;
  const n = norm(name);
  return list.find((x) => norm(key(x)) === n) ?? list.find((x) => norm(key(x)).includes(n) || n.includes(norm(key(x))));
}

/** Keyword families so old element names ("fire", "poison") find a world's subtype ("Plasma", "Toxin"). */
const ELEMENT_WORDS: [RegExp, RegExp][] = [
  [/fire|flame|burn|heat|plasma|sizzle|hell|ember/i, /fire|flame|burn|heat|plasma|sizzle|hell|ember|incend/i],
  [/frost|ice|cold|cryo|chill|freez|snow/i, /frost|ice|cold|cryo|chill|freez|snow/i],
  [/shock|lightning|storm|arc|electric|zap|ion|static/i, /shock|lightning|storm|arc|electric|zap|ion|static|spark/i],
  [/poison|toxin|venom|rot|acid|chemical|sticky|stink/i, /poison|toxin|venom|rot|acid|chemical|sticky|stink|gooey|contamin/i],
  [/psychic|mind|dread|shadow|occult|spook|void/i, /psychic|mind|dread|shadow|occult|spook|void|terror/i],
  [/radiant|holy|light|photon|sun|sparkle/i, /radiant|holy|light|photon|sun|sparkle|sunny/i],
  [/physical|pierc|slash|blunt|kinetic|bleed|cut|bonk|poke/i, /physical|pierc|slash|blunt|kinetic|bleed|cut|bonk|poke|ballistic/i],
];

export function resolveElement(r: Ruleset, element: string | undefined, fallbackIndex: number): string {
  const ix = rx(r);
  if (element && (ix.subtype.has(element) || ix.type.has(element))) return element;
  const direct = matchByName(element, r.subtypes, (s) => s.name) ?? matchByName(element, r.damageTypes, (t) => t.name);
  if (direct) return direct.id;
  if (element) for (const [want, has] of ELEMENT_WORDS) if (want.test(element)) {
    const s = r.subtypes.find((x) => has.test(x.name));
    if (s) return s.id;
  }
  const pool = r.subtypes.length ? r.subtypes.map((s) => s.id) : r.damageTypes.map((t) => t.id);
  return pool[fallbackIndex % pool.length]!;
}

/** Legendary-strength modifiers for a unique item, drawn from the affixes its slot allows. */
export function uniqueMods(r: Ruleset, baseId: string, seed: string, level: number): Modifier[] {
  const ix = rx(r);
  const base = ix.item.get(baseId);
  const kind: SlotKind | undefined = base?.slotId ? ix.slot.get(base.slotId)?.kind : undefined;
  if (!kind) return [];
  const rng = new Rng(`unique:${seed}`);
  const pool = r.affixes.filter((a) => a.slotKinds.includes(kind));
  const out: Modifier[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < 3 && pool.length; i++) {
    const choices = pool.filter((a) => !taken.has(a.stat));
    if (!choices.length) break;
    const a = rng.pickWeighted(choices, (x) => x.weight);
    taken.add(a.stat);
    out.push({ stat: a.stat, value: affixValue(r, a.id, level, r.rarities[4]!.id, 0.75 + rng.next() * 0.25) });
  }
  return out;
}

/** Pick a ruleset base for a unique item of a broad kind. */
export function uniqueBase(r: Ruleset, kind: 'weapon' | 'armor' | 'trinket' | 'relic' | 'document' | string, rng: Rng): string {
  const pickKind = (k: SlotKind) => {
    const list = r.items.filter((i) => i.category === 'equipment' && i.slotId && rx(r).slot.get(i.slotId)?.kind === k);
    return list.length ? rng.pick(list).id : undefined;
  };
  if (kind === 'weapon') return pickKind('weapon') ?? 'quest_item';
  if (kind === 'armor') return pickKind('armor') ?? 'quest_item';
  if (kind === 'trinket') return pickKind('accessory') ?? 'quest_item';
  return 'quest_item';
}

/** What kind of item a base was under the rules a unique was made with (ids start with their kind's letter). */
function baseKindOf(baseId: string): string {
  if (baseId.startsWith('w_')) return 'weapon';
  if (baseId.startsWith('a_') || baseId.startsWith('s_')) return 'armor';
  if (baseId.startsWith('t_') || baseId.startsWith('j_')) return 'trinket';
  return 'relic';
}

function bindUnique(r: Ruleset, u: UniqueItemDef, level: number) {
  const ix = rx(r);
  // Rules made anew (the world's rules regenerated) have other item bases: a unique takes one of the same kind.
  if (!ix.item.has(u.baseId)) u.baseId = uniqueBase(r, baseKindOf(u.baseId), new Rng(`ub:${u.id}`));
  u.rarityId = ix.rarity.has(u.rarityId) ? u.rarityId : u.questItem && u.baseId === 'quest_item' ? r.rarities[2]!.id : r.rarities[4]!.id;
  u.mods = u.baseId === 'quest_item' ? [] : uniqueMods(r, u.baseId, u.id, level);
}

/** Experience per kill. */
export function killXpFor(r: Ruleset, level: number, role: keyof typeof ROLE_VISUAL, tier: 'normal' | 'elite' | 'boss'): number {
  return Math.round(curve(r.progression.killXp, level) * (tier === 'boss' ? 5 : tier === 'elite' ? 2 : 1) * ROLE_VISUAL[role].xp);
}

/**
 * Solve the experience curve from the world's content so that a player who clears content at each level
 * reaches the next level about when that content runs out (progression follows the world, not a fixed table).
 * Also sets quest XP and gold rewards.
 */
export function solveProgression(r: Ruleset, w: WorldDefinition) {
  const max = r.progression.maxLevel;
  const byLevel = new Array(max + 2).fill(0) as number[];
  const lv = (l: number) => Math.max(1, Math.min(max, Math.round(l)));
  for (const z of w.zones) for (const s of z.spawns) byLevel[lv(s.level)]! += killXpFor(r, lv(s.level), s.archetype, s.bossId ? 'boss' : s.elite ? 'elite' : 'normal');
  for (const q of w.quests) {
    questRewards(r, q);
    byLevel[lv(q.level)]! += q.rewards.xp;
  }
  const xp = [0, 0];
  for (let L = 1; L < max; L++) {
    const kill = curve(r.progression.killXp, L);
    const span = Math.max(kill * 6, byLevel[L]! * 0.8);
    xp.push(Math.round(xp[L]! + span));
  }
  r.progression.xp = xp;
}

/** A quest's experience and gold, from its level. */
export function questRewards(r: Ruleset, q: QuestDef) {
  const L = Math.max(1, Math.min(r.progression.maxLevel, Math.round(q.level)));
  q.rewards.xp = Math.round(curve(r.progression.killXp, L) * (q.main ? 9 : 5));
  q.rewards.gold = Math.round(curve(r.economy.goldPerKill, L) * (q.main ? 14 : 8));
}

/** Bind the world's content to `r` (mutates the world). */
export function bindWorld(w: WorldDefinition, r: Ruleset, classes?: ClassesIntent) {
  w.ruleset = r;
  w.maxLevel = r.progression.maxLevel;
  w.families.forEach((f, i) => (f.element = resolveElement(r, f.element, i)));
  // Class looks for art and NPC context.
  const looks = new Map((classes?.classes ?? []).map((c) => [norm(c.name), (c as { appearance?: string }).appearance]));
  w.origins = r.classes.map((c) => {
    const prev = w.origins.find((o) => o.id === c.id) ?? w.origins.find((o) => norm(o.name) === norm(c.name));
    return { id: c.id, name: c.name, description: c.description, appearance: looks.get(norm(c.name)) ?? prev?.appearance ?? `${c.name}, ${c.description}`, assets: prev?.id === c.id ? prev.assets : undefined };
  });
  // Uniques: find level from where they appear (boss / chest), default mid.
  const levelOf = new Map<string, number>();
  for (const b of w.bosses) for (const u of b.drops) levelOf.set(u, b.level);
  for (const z of w.zones) for (const f of z.features) for (const u of f.items ?? []) levelOf.set(u, f.lootTier ?? z.levelRange[1]);
  for (const u of Object.values(w.uniqueItems)) bindUnique(r, u, levelOf.get(u.id) ?? Math.ceil(r.progression.maxLevel / 2));
  // Traps: kinds of earlier rules (the world's rules regenerated) map to these rules' traps.
  if (!r.systems.traps || !r.traps.length) for (const z of w.zones) z.features = z.features.filter((f) => f.kind !== 'trap');
  for (const z of w.zones) for (const f of z.features) {
    if (f.kind !== 'trap') continue;
    if (!rx(r).trap.has(f.trapKind ?? '')) {
      const byName = matchByName(f.trapKind, r.traps, (t) => t.name) ?? matchByName(f.name, r.traps, (t) => t.name);
      f.trapKind = (byName ?? r.traps[Math.abs([...(f.id)].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % r.traps.length]!).id;
    }
    f.name = rx(r).trap.get(f.trapKind!)?.name ?? f.name;
  }
  // Locks off: unlock chests.
  if (!r.systems.locks) for (const z of w.zones) for (const f of z.features) if (f.kind === 'chest') delete f.lockLevel;
  solveProgression(r, w);
}
