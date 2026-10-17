/** Fixed progression tables: world size, game length, experience and level scaling. */

export const WORLD_SIZES = ['small', 'medium', 'large', 'huge'] as const;
export type WorldSize = (typeof WORLD_SIZES)[number];

export const GAME_LENGTHS = ['short', 'medium', 'long', 'epic'] as const;
export type GameLength = (typeof GAME_LENGTHS)[number];

export const COMBAT_MODES = ['solo', 'party_manual', 'party_npc'] as const;
export type CombatMode = (typeof COMBAT_MODES)[number];

/** 0 = NPCs keep things to themselves, 3 = everything ripples through the world. */
export type CommunicationLevel = 0 | 1 | 2 | 3;

export interface SizeProfile {
  /** Number of regions; each region has a level band. */
  regions: number;
  towns: number;
  wilds: number;
  dungeons: number;
  npcsPerTown: [number, number];
  sideQuestsPerTown: [number, number];
  monsterFamilies: number;
}

export const SIZE_PROFILES: Record<WorldSize, SizeProfile> = {
  small: { regions: 2, towns: 2, wilds: 2, dungeons: 3, npcsPerTown: [6, 8], sideQuestsPerTown: [2, 3], monsterFamilies: 4 },
  medium: { regions: 3, towns: 3, wilds: 4, dungeons: 5, npcsPerTown: [7, 10], sideQuestsPerTown: [3, 4], monsterFamilies: 6 },
  large: { regions: 4, towns: 4, wilds: 6, dungeons: 8, npcsPerTown: [8, 12], sideQuestsPerTown: [3, 5], monsterFamilies: 8 },
  huge: { regions: 6, towns: 6, wilds: 9, dungeons: 12, npcsPerTown: [9, 14], sideQuestsPerTown: [4, 6], monsterFamilies: 10 },
};

export interface LengthProfile {
  maxLevel: number;
  arcs: number;
  mainQuestsPerArc: [number, number];
}

export const LENGTH_PROFILES: Record<GameLength, LengthProfile> = {
  short: { maxLevel: 8, arcs: 2, mainQuestsPerArc: [2, 3] },
  medium: { maxLevel: 14, arcs: 3, mainQuestsPerArc: [2, 4] },
  long: { maxLevel: 20, arcs: 4, mainQuestsPerArc: [3, 4] },
  epic: { maxLevel: 30, arcs: 5, mainQuestsPerArc: [3, 5] },
};

/** Total experience required to reach `level` (level 1 = 0). */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  const n = level - 1;
  return Math.round(100 * n + 60 * n * n + 6 * n * n * n);
}

export function levelForXp(xp: number, maxLevel: number): number {
  let l = 1;
  while (l < maxLevel && xp >= xpForLevel(l + 1)) l++;
  return l;
}

/** Experience granted for defeating a creature of `level` with a strength multiplier (boss = ~5). */
export function killXp(level: number, strength = 1): number {
  return Math.round((20 + level * 12) * strength);
}

/** Expected number of standard kills to level, used to size quest rewards. */
export function questXp(level: number, weight = 1): number {
  return Math.round((xpForLevel(level + 1) - xpForLevel(level)) * 0.35 * weight);
}

export function questGold(level: number, weight = 1): number {
  return Math.round((25 + level * 18) * weight);
}

/** Base "power" number at a level that weapon damage and skill power derive from. */
export function powerAtLevel(level: number): number {
  return 6 + level * 3.2 + Math.pow(level, 1.35) * 0.6;
}

export const ATTRIBUTE_BASE = 10;
export const ATTRIBUTE_POINTS_PER_LEVEL = 2;
export const SKILL_POINTS_PER_LEVEL = 1;
export const STARTING_SKILL_POINTS = 2;
export const MAX_PARTY_SIZE = 4;
export const BASE_AP_PER_TURN = 4;
export const MAX_AP = 6;
export const TILES_PER_AP = 3;
export const REAL_MS_PER_GAME_MINUTE = 1000; // 1 game hour = 1 real minute, 1 day = 24 real minutes
export const GAME_MINUTES_PER_DAY = 24 * 60;
