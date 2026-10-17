/** Fixed monster archetypes, NPC roles, character origins and traps. */
import type { AttributeId, DamageType, StatusId, SurfaceType } from './core';

export const MONSTER_ARCHETYPES = ['brute', 'skirmisher', 'archer', 'caster', 'healer', 'swarm', 'guardian', 'assassin'] as const;
export type MonsterArchetype = (typeof MONSTER_ARCHETYPES)[number];

export interface ArchetypeDef {
  defaultName: string;
  health: number;
  damage: number;
  phys: number;
  mag: number;
  /** Weapon range in tiles. */
  range: number;
  moveSpeed: number;
  initiative: number;
  skills: string[];
  /** Silhouette used by procedural art. */
  shape: 'humanoid' | 'beast' | 'blob' | 'flyer' | 'hulk';
  scale: number;
  primary: AttributeId;
  xp: number;
}

export const ARCHETYPES: Record<MonsterArchetype, ArchetypeDef> = {
  brute: { defaultName: 'Brute', health: 1.35, damage: 1.1, phys: 1.2, mag: 0.5, range: 1.6, moveSpeed: 1, initiative: 0, skills: ['heavy_strike', 'm_slam'], shape: 'hulk', scale: 1.25, primary: 'might', xp: 1.2 },
  skirmisher: { defaultName: 'Skirmisher', health: 0.9, damage: 1.0, phys: 0.7, mag: 0.6, range: 1.6, moveSpeed: 1.4, initiative: 4, skills: ['m_bite', 'rupture'], shape: 'beast', scale: 0.95, primary: 'finesse', xp: 1 },
  archer: { defaultName: 'Archer', health: 0.75, damage: 0.95, phys: 0.6, mag: 0.6, range: 10, moveSpeed: 1, initiative: 2, skills: ['aimed_shot', 'crippling_shot'], shape: 'humanoid', scale: 1, primary: 'finesse', xp: 1 },
  caster: { defaultName: 'Caster', health: 0.7, damage: 1.05, phys: 0.4, mag: 1.1, range: 9, moveSpeed: 1, initiative: 1, skills: ['firebolt', 'frost_lance', 'lightning'], shape: 'humanoid', scale: 1, primary: 'intellect', xp: 1.1 },
  healer: { defaultName: 'Mender', health: 0.8, damage: 0.7, phys: 0.5, mag: 1.0, range: 8, moveSpeed: 1, initiative: 1, skills: ['heal', 'ward', 'smite'], shape: 'humanoid', scale: 1, primary: 'spirit', xp: 1.1 },
  swarm: { defaultName: 'Swarmling', health: 0.45, damage: 0.6, phys: 0.3, mag: 0.3, range: 1.6, moveSpeed: 1.3, initiative: 3, skills: ['m_bite'], shape: 'blob', scale: 0.7, primary: 'finesse', xp: 0.45 },
  guardian: { defaultName: 'Guardian', health: 1.6, damage: 0.85, phys: 1.6, mag: 1.0, range: 1.6, moveSpeed: 0.8, initiative: -2, skills: ['shield_bash', 'taunt', 'fortify'], shape: 'hulk', scale: 1.3, primary: 'vitality', xp: 1.3 },
  assassin: { defaultName: 'Stalker', health: 0.8, damage: 1.3, phys: 0.6, mag: 0.6, range: 1.6, moveSpeed: 1.3, initiative: 5, skills: ['backstab', 'shadowstep', 'crippling_poison'], shape: 'humanoid', scale: 0.95, primary: 'finesse', xp: 1.2 },
};

/** Monster base stats at a level; archetype multipliers apply on top. */
export function monsterBaseStats(level: number) {
  return {
    health: Math.round(14 + level * 8 + level * level * 0.5),
    damage: 2.8 + level * 1.8 + Math.pow(level, 1.3) * 0.25,
    phys: Math.round(2 + level * 2.5),
    mag: Math.round(2 + level * 2.5),
  };
}

export const NPC_ROLES = ['merchant', 'innkeeper', 'questgiver', 'guard', 'commoner', 'trainer', 'crafter', 'companion', 'noble', 'mystic'] as const;
export type NpcRole = (typeof NPC_ROLES)[number];

export const MERCHANT_KINDS = ['general', 'weapons', 'armor', 'alchemy', 'magic', 'materials'] as const;
export type MerchantKind = (typeof MERCHANT_KINDS)[number];

export const MERCHANT_STOCK: Record<MerchantKind, string[]> = {
  general: ['c_heal', 'c_food', 'c_stamina', 'c_focus', 'tool_trapkit', 'tool_lockpick', 'c_recall', 'v_trinket', 'w_dagger', 'a_feet_light'],
  weapons: ['w_blade', 'w_heavy', 'w_dagger', 'w_bow', 's_shield'],
  armor: ['a_head_heavy', 'a_head_light', 'a_chest_heavy', 'a_chest_light', 'a_hands_heavy', 'a_hands_light', 'a_feet_heavy', 'a_feet_light', 's_shield'],
  alchemy: ['c_heal', 'c_stamina', 'c_focus', 'c_antidote', 'c_bomb_fire', 'c_bomb_frost', 'c_elixir', 'm_herb', 'm_essence'],
  magic: ['w_staff', 'w_wand', 's_focus', 't_ring', 't_amulet', 'c_focus', 'c_skillbook', 'm_crystal'],
  materials: ['m_herb', 'm_ore', 'm_hide', 'm_cloth', 'm_essence', 'm_crystal'],
};

/** Starting templates the player picks from (renamed by the world). */
export interface OriginTemplate {
  id: string;
  defaultName: string;
  attributes: Partial<Record<AttributeId, number>>;
  weapon: string;
  offhand?: string;
  armor: string[];
  suggestedSkills: string[];
  /** Companion/monster combat role mapping. */
  archetype: MonsterArchetype;
}

export const ORIGINS: OriginTemplate[] = [
  { id: 'o_warrior', defaultName: 'Warrior', attributes: { might: 3, vitality: 2 }, weapon: 'w_blade', offhand: 's_shield', armor: ['a_chest_heavy', 'a_head_heavy'], suggestedSkills: ['heavy_strike', 'charge', 'whirlwind', 'fortify'], archetype: 'guardian' },
  { id: 'o_ranger', defaultName: 'Ranger', attributes: { finesse: 3, wits: 2 }, weapon: 'w_bow', armor: ['a_chest_light', 'a_feet_light'], suggestedSkills: ['aimed_shot', 'crippling_shot', 'tactical_leap', 'keen_eye'], archetype: 'archer' },
  { id: 'o_rogue', defaultName: 'Rogue', attributes: { finesse: 3, wits: 2 }, weapon: 'w_dagger', armor: ['a_chest_light', 'a_hands_light'], suggestedSkills: ['backstab', 'rupture', 'shadowstep', 'disarm_trap'], archetype: 'assassin' },
  { id: 'o_mage', defaultName: 'Mage', attributes: { intellect: 3, spirit: 1, wits: 1 }, weapon: 'w_staff', armor: ['a_chest_light', 'a_head_light'], suggestedSkills: ['firebolt', 'frost_lance', 'lightning', 'fireball'], archetype: 'caster' },
  { id: 'o_cleric', defaultName: 'Cleric', attributes: { spirit: 3, vitality: 1, might: 1 }, weapon: 'w_blade', offhand: 's_focus', armor: ['a_chest_heavy'], suggestedSkills: ['heal', 'smite', 'regeneration', 'ward'], archetype: 'healer' },
  { id: 'o_occultist', defaultName: 'Occultist', attributes: { intellect: 3, spirit: 2 }, weapon: 'w_wand', offhand: 's_focus', armor: ['a_chest_light'], suggestedSkills: ['mind_spike', 'drain_life', 'toxic_cloud', 'hex'], archetype: 'caster' },
];

export const ORIGIN: Record<string, OriginTemplate> = Object.fromEntries(ORIGINS.map((o) => [o.id, o]));

export const TRAP_KINDS = ['spike', 'fire', 'poison', 'frost', 'shock', 'alarm'] as const;
export type TrapKind = (typeof TRAP_KINDS)[number];

export const TRAP_INFO: Record<TrapKind, { defaultName: string; damage: DamageType; mult: number; status?: StatusId; surface?: SurfaceType; radius: number }> = {
  spike: { defaultName: 'Spike Trap', damage: 'physical', mult: 1.4, status: 'bleeding', radius: 0 },
  fire: { defaultName: 'Fire Trap', damage: 'fire', mult: 1.1, surface: 'fire', radius: 1.5 },
  poison: { defaultName: 'Gas Trap', damage: 'poison', mult: 0.9, surface: 'poison', radius: 2 },
  frost: { defaultName: 'Frost Trap', damage: 'frost', mult: 1.0, status: 'frozen', radius: 1.5 },
  shock: { defaultName: 'Shock Trap', damage: 'shock', mult: 1.1, status: 'stunned', radius: 1 },
  alarm: { defaultName: 'Alarm Trap', damage: 'physical', mult: 0.3, radius: 0 },
};
