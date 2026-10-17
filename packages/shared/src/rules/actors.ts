/** Engine-level actor vocabularies: monster roles (their numbers live in the ruleset), NPC roles, merchants. */
import { MONSTER_ROLES, type MonsterRole } from '../ruleset/types';

export const MONSTER_ARCHETYPES = MONSTER_ROLES;
export type MonsterArchetype = MonsterRole;

/** How each role looks in procedural art and how its role reads in the UI. */
export const ROLE_VISUAL: Record<MonsterRole, { name: string; shape: 'humanoid' | 'beast' | 'blob' | 'flyer' | 'hulk'; scale: number; xp: number }> = {
  brute: { name: 'Brute', shape: 'hulk', scale: 1.25, xp: 1.2 },
  skirmisher: { name: 'Skirmisher', shape: 'beast', scale: 0.95, xp: 1 },
  archer: { name: 'Archer', shape: 'humanoid', scale: 1, xp: 1 },
  caster: { name: 'Caster', shape: 'humanoid', scale: 1, xp: 1.1 },
  healer: { name: 'Mender', shape: 'humanoid', scale: 1, xp: 1.1 },
  swarm: { name: 'Swarmling', shape: 'blob', scale: 0.7, xp: 0.45 },
  guardian: { name: 'Guardian', shape: 'hulk', scale: 1.3, xp: 1.3 },
  assassin: { name: 'Stalker', shape: 'humanoid', scale: 0.95, xp: 1.2 },
};

export const NPC_ROLES = ['merchant', 'innkeeper', 'questgiver', 'guard', 'commoner', 'trainer', 'crafter', 'companion', 'noble', 'mystic'] as const;
export type NpcRole = (typeof NPC_ROLES)[number];

export const MERCHANT_KINDS = ['general', 'weapons', 'armor', 'alchemy', 'magic', 'materials'] as const;
export type MerchantKind = (typeof MERCHANT_KINDS)[number];
