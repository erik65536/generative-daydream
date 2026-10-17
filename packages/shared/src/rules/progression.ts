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

export const MAX_PARTY_SIZE = 4;
export const REAL_MS_PER_GAME_MINUTE = 1000; // 1 game hour = 1 real minute, 1 day = 24 real minutes
export const GAME_MINUTES_PER_DAY = 24 * 60;
/** Slain non-boss monsters return this long after death (6 game hours = 6 real minutes), when their zone is next entered. */
export const RESPAWN_GAME_MINUTES = 6 * 60;
