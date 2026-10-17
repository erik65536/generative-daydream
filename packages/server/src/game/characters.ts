/** Character creation and progression. */
import {
  ATTRIBUTES, ATTRIBUTE_BASE, ATTRIBUTE_POINTS_PER_LEVEL, ORIGIN, SKILL_POINTS_PER_LEVEL, STARTING_SKILL_POINTS, Rng, computeCharacterStats, levelForXp, uid,
  type AttributeId, type CharacterState, type WorldDefinition, type ItemInstance,
} from '@gd/shared';
import { makeItem } from './loot';

export interface CharacterSpec {
  name: string;
  originId: string;
  /** Extra attribute points the player allocated at creation (max 3 total). */
  attributes?: Partial<Record<AttributeId, number>>;
  /** Starting skills (up to STARTING_SKILL_POINTS) chosen among enabled skills. */
  skills?: string[];
  sprite?: string;
  colors?: string[];
}

export function createCharacter(w: WorldDefinition, spec: CharacterSpec, rng: Rng): { ch: CharacterState; inventory: ItemInstance[] } {
  const origin = ORIGIN[spec.originId] ?? ORIGIN.o_warrior!;
  const attributes = Object.fromEntries(ATTRIBUTES.map((a) => [a, ATTRIBUTE_BASE])) as Record<AttributeId, number>;
  for (const [k, v] of Object.entries(origin.attributes)) attributes[k as AttributeId] += v ?? 0;
  let spent = 0;
  for (const [k, v] of Object.entries(spec.attributes ?? {})) {
    const n = Math.max(0, Math.min(3 - spent, Math.floor(v ?? 0)));
    if (ATTRIBUTES.includes(k as AttributeId)) {
      attributes[k as AttributeId] += n;
      spent += n;
    }
  }
  const enabled = Object.keys(w.skills);
  const wanted = (spec.skills ?? []).filter((s) => enabled.includes(s));
  const suggested = origin.suggestedSkills.filter((s) => enabled.includes(s));
  const skills = [...new Set([...wanted, ...suggested])].slice(0, STARTING_SKILL_POINTS);
  if (enabled.includes('first_aid') && !skills.includes('first_aid')) skills.push('first_aid');
  const equipment: CharacterState['equipment'] = {};
  equipment.mainhand = makeItem(w, rng, origin.weapon, 1, 'common');
  if (origin.offhand) equipment.offhand = makeItem(w, rng, origin.offhand, 1, 'common');
  for (const a of origin.armor) {
    const it = makeItem(w, rng, a, 1, 'common');
    const slot = it ? (a.startsWith('a_head') ? 'head' : a.startsWith('a_chest') ? 'chest' : a.startsWith('a_hands') ? 'hands' : 'feet') : null;
    if (slot) equipment[slot] = it;
  }
  const ch: CharacterState = {
    id: uid('ch'),
    name: spec.name.trim().slice(0, 24) || 'Wanderer',
    originId: origin.id,
    sprite: spec.sprite ?? `spr_origin_${origin.id}`,
    colors: spec.colors ?? [],
    level: 1,
    xp: 0,
    attributes,
    unspentAttributes: 0,
    unspentSkillPoints: 0,
    skills,
    hotbar: [],
    hp: 1,
    stamina: 1,
    focus: 1,
    physArmor: 0,
    magArmor: 0,
    statuses: [],
    equipment,
    cooldowns: {},
    downed: false,
    archetype: origin.archetype,
  };
  ch.hotbar = defaultHotbar(ch);
  restoreFully(ch, w);
  const inventory = [makeItem(w, rng, 'c_heal', 1, 'common', 3), makeItem(w, rng, 'c_food', 1, 'common', 2)];
  if (w.systems.traps) inventory.push(makeItem(w, rng, 'tool_trapkit', 1, 'common', 1));
  if (w.systems.lockpicking) inventory.push(makeItem(w, rng, 'tool_lockpick', 1, 'common', 2));
  return { ch, inventory };
}

export function defaultHotbar(ch: CharacterState): (string | null)[] {
  const actives = ch.skills.filter((s) => s !== 'keen_eye' && s !== 'treasure_hunter' && s !== 'haggler' && s !== 'silver_tongue');
  return ['attack', ...actives].slice(0, 10);
}

export function statsOf(ch: CharacterState, w: WorldDefinition, loneWolf: boolean) {
  return computeCharacterStats(ch, { loneWolf, dualEnergy: w.systems.dualEnergy });
}

export function restoreFully(ch: CharacterState, w: WorldDefinition, loneWolf = false) {
  const s = statsOf(ch, w, loneWolf);
  ch.hp = s.maxHp;
  ch.stamina = s.maxStamina;
  ch.focus = s.maxFocus;
  ch.physArmor = s.maxPhys;
  ch.magArmor = s.maxMag;
  ch.downed = false;
  ch.statuses = [];
}

/** Clamp pools after equipment or stat changes. */
export function clampPools(ch: CharacterState, w: WorldDefinition, loneWolf = false) {
  const s = statsOf(ch, w, loneWolf);
  ch.hp = Math.min(ch.hp, s.maxHp);
  ch.stamina = Math.min(ch.stamina, s.maxStamina);
  ch.focus = Math.min(ch.focus, s.maxFocus);
  ch.physArmor = Math.min(ch.physArmor, s.maxPhys);
  ch.magArmor = Math.min(ch.magArmor, s.maxMag);
}

/** Grant experience; returns the number of levels gained. */
export function grantXp(ch: CharacterState, amount: number, w: WorldDefinition): number {
  if (ch.level >= w.maxLevel) return 0;
  ch.xp += Math.max(0, Math.round(amount));
  const newLevel = levelForXp(ch.xp, w.maxLevel);
  const gained = newLevel - ch.level;
  if (gained > 0) {
    ch.level = newLevel;
    ch.unspentAttributes += gained * ATTRIBUTE_POINTS_PER_LEVEL;
    ch.unspentSkillPoints += gained * SKILL_POINTS_PER_LEVEL;
    // Companions spend their own points.
    if (ch.npcId) autoSpend(ch, w);
    restoreFully(ch, w);
  }
  return gained;
}

export function autoSpend(ch: CharacterState, w: WorldDefinition) {
  const origin = ORIGIN[ch.originId];
  const main = (Object.entries(origin?.attributes ?? { vitality: 1 }).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0] ?? 'vitality') as AttributeId;
  while (ch.unspentAttributes > 0) {
    ch.attributes[ch.unspentAttributes % 2 ? 'vitality' : main]++;
    ch.unspentAttributes--;
  }
  const enabled = Object.keys(w.skills);
  const options = [...(origin?.suggestedSkills ?? []), ...enabled].filter((s) => enabled.includes(s) && !ch.skills.includes(s));
  while (ch.unspentSkillPoints > 0 && options.length) {
    const s = options.shift()!;
    ch.skills.push(s);
    if (ch.hotbar.length < 10) ch.hotbar.push(s);
    ch.unspentSkillPoints--;
  }
}
