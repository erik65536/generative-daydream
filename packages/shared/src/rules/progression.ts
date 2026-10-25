/** Fixed progression tables: world size, game length, experience and level scaling. */

export const WORLD_SIZES = ['small', 'medium', 'large'] as const;
export type WorldSize = (typeof WORLD_SIZES)[number];

export const GAME_LENGTHS = ['short', 'medium', 'long', 'epic'] as const;
export type GameLength = (typeof GAME_LENGTHS)[number];

/** Solo; four heroes the player makes and controls; or the player's hero with three companions made with the world. */
export const COMBAT_MODES = ['solo', 'party_manual', 'party_npc'] as const;
export type CombatMode = (typeof COMBAT_MODES)[number];

/** 0 = NPCs keep things to themselves, 3 = everything ripples through the world. */
export type CommunicationLevel = 0 | 1 | 2 | 3;

/** A world's places: each city is a region of its own (a level band) with its wilds and dungeons around it. */
export interface SizeProfile {
  towns: number;
  wilds: number;
  dungeons: number;
  /** Map tiles (1024 px, about 25 m square) all places together may use: the planner sizes each place within it. */
  tiles: number;
  npcsPerTown: [number, number];
  sideQuestsPerTown: [number, number];
  monsterFamilies: number;
}

export const SIZE_PROFILES: Record<WorldSize, SizeProfile> = {
  small: { towns: 1, wilds: 2, dungeons: 2, tiles: 30, npcsPerTown: [7, 9], sideQuestsPerTown: [3, 4], monsterFamilies: 3 },
  medium: { towns: 2, wilds: 3, dungeons: 3, tiles: 55, npcsPerTown: [7, 10], sideQuestsPerTown: [3, 4], monsterFamilies: 4 },
  large: { towns: 3, wilds: 5, dungeons: 4, tiles: 85, npcsPerTown: [8, 11], sideQuestsPerTown: [3, 5], monsterFamilies: 6 },
};

/**
 * A rough guide to what a build takes, for the creation form: GPU hours until the world can be played (painting and
 * reading its places, painting its people, creatures and items), GPU hours of animation after that (in the
 * background: actors keep a still image until theirs is done), and OpenAI dollars.
 */
export function buildEstimate(size: WorldSize, length: GameLength, mode: CombatMode): { buildHours: number; animationHours: number; usd: number } {
  const s = SIZE_PROFILES[size];
  const places = s.towns + s.wilds + s.dungeons;
  const heroes = 10;
  const actors = s.towns * ((s.npcsPerTown[0] + s.npcsPerTown[1]) / 2) + s.monsterFamilies * 3.5 + LENGTH_PROFILES[length].arcs + heroes + (mode === 'party_npc' ? 3 : 0);
  const buildMinutes = s.tiles * 4 + places * 5 + actors * 1.2 + 30;
  return { buildHours: buildMinutes / 60, animationHours: (actors * 4) / 60, usd: 0.5 + places * 0.12 + actors * 0.01 };
}

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
