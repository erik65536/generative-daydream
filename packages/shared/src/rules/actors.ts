/** Engine-level actor vocabularies: monster roles (their numbers live in the ruleset), NPC roles, merchants. */
import { MONSTER_ROLES, type MonsterRole } from '../ruleset/types';

export const MONSTER_ARCHETYPES = MONSTER_ROLES;
export type MonsterArchetype = MonsterRole;

/** How each role reads in the UI, its size on the map and its share of experience. */
export const ROLE_VISUAL: Record<MonsterRole, { name: string; scale: number; xp: number }> = {
  brute: { name: 'Brute', scale: 1.25, xp: 1.2 },
  skirmisher: { name: 'Skirmisher', scale: 0.95, xp: 1 },
  archer: { name: 'Archer', scale: 1, xp: 1 },
  caster: { name: 'Caster', scale: 1, xp: 1.1 },
  healer: { name: 'Mender', scale: 1, xp: 1.1 },
  swarm: { name: 'Swarmling', scale: 0.7, xp: 0.45 },
  guardian: { name: 'Guardian', scale: 1.3, xp: 1.3 },
  assassin: { name: 'Stalker', scale: 0.95, xp: 1.2 },
};

export const NPC_ROLES = ['merchant', 'innkeeper', 'questgiver', 'guard', 'commoner', 'trainer', 'crafter', 'companion', 'noble', 'mystic'] as const;
export type NpcRole = (typeof NPC_ROLES)[number];

export const MERCHANT_KINDS = ['general', 'weapons', 'armor', 'alchemy', 'magic', 'materials'] as const;
export type MerchantKind = (typeof MERCHANT_KINDS)[number];
