/**
 * The fixed, setting-agnostic core of the game. Every world uses exactly these mechanics;
 * worlds only rename them (see Terminology) and enable/disable optional systems.
 */

export const ATTRIBUTES = ['might', 'finesse', 'intellect', 'vitality', 'spirit', 'wits'] as const;
export type AttributeId = (typeof ATTRIBUTES)[number];

export const ATTRIBUTE_INFO: Record<AttributeId, { defaultLabel: string; effect: string }> = {
  might: { defaultLabel: 'Might', effect: 'Melee and heavy weapon damage, physical armor from heavy gear.' },
  finesse: { defaultLabel: 'Finesse', effect: 'Ranged and light weapon damage, evasion, movement.' },
  intellect: { defaultLabel: 'Intellect', effect: 'Elemental and mental skill power.' },
  vitality: { defaultLabel: 'Vitality', effect: 'Maximum health and physical armor.' },
  spirit: { defaultLabel: 'Spirit', effect: 'Healing power, magic armor and focus.' },
  wits: { defaultLabel: 'Wits', effect: 'Critical chance, initiative and trap detection.' },
};

export const DAMAGE_TYPES = ['physical', 'piercing', 'fire', 'frost', 'shock', 'poison', 'psychic', 'radiant'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** Which armor pool absorbs a damage type before health (Divinity-style armor). */
export const DAMAGE_ARMOR: Record<DamageType, 'phys' | 'mag' | 'none'> = {
  physical: 'phys',
  piercing: 'none',
  fire: 'mag',
  frost: 'mag',
  shock: 'mag',
  poison: 'mag',
  psychic: 'mag',
  radiant: 'mag',
};

export const DAMAGE_INFO: Record<DamageType, { defaultLabel: string; color: string }> = {
  physical: { defaultLabel: 'Physical', color: '#d8d0c0' },
  piercing: { defaultLabel: 'Piercing', color: '#c03040' },
  fire: { defaultLabel: 'Fire', color: '#ff7a2a' },
  frost: { defaultLabel: 'Frost', color: '#7fd4ff' },
  shock: { defaultLabel: 'Shock', color: '#c9a6ff' },
  poison: { defaultLabel: 'Poison', color: '#7ccf3a' },
  psychic: { defaultLabel: 'Psychic', color: '#e070d0' },
  radiant: { defaultLabel: 'Radiant', color: '#ffe680' },
};

export const POOLS = ['stamina', 'focus'] as const;
export type PoolId = (typeof POOLS)[number];

export const SCHOOLS = ['warfare', 'marksmanship', 'shadow', 'elemental', 'occult', 'restoration', 'utility'] as const;
export type SchoolId = (typeof SCHOOLS)[number];

export const SCHOOL_INFO: Record<SchoolId, { defaultLabel: string; attribute: AttributeId; pool: PoolId; color: string }> = {
  warfare: { defaultLabel: 'Warfare', attribute: 'might', pool: 'stamina', color: '#d06a4a' },
  marksmanship: { defaultLabel: 'Marksmanship', attribute: 'finesse', pool: 'stamina', color: '#7fb85a' },
  shadow: { defaultLabel: 'Shadowcraft', attribute: 'finesse', pool: 'stamina', color: '#8a7ab8' },
  elemental: { defaultLabel: 'Elementalism', attribute: 'intellect', pool: 'focus', color: '#e09a3a' },
  occult: { defaultLabel: 'Occultism', attribute: 'intellect', pool: 'focus', color: '#b05ac0' },
  restoration: { defaultLabel: 'Restoration', attribute: 'spirit', pool: 'focus', color: '#5ac0a8' },
  utility: { defaultLabel: 'Expertise', attribute: 'wits', pool: 'stamina', color: '#c0b070' },
};

export const STATUSES = [
  'burning', 'poisoned', 'bleeding', 'chilled', 'frozen', 'stunned', 'knocked_down',
  'weakened', 'vulnerable', 'slowed', 'hasted', 'empowered', 'fortified', 'regenerating', 'taunted', 'wet',
] as const;
export type StatusId = (typeof STATUSES)[number];

export interface StatusDef {
  defaultLabel: string;
  harmful: boolean;
  /** Armor that must be depleted before this status can land (Divinity rule). */
  blockedBy?: 'phys' | 'mag';
  /** Damage per turn as a fraction of the applier's skill power. */
  dot?: { type: DamageType; mult: number };
  skipTurn?: boolean;
  color: string;
  description: string;
}

export const STATUS_INFO: Record<StatusId, StatusDef> = {
  burning: { defaultLabel: 'Burning', harmful: true, blockedBy: 'mag', dot: { type: 'fire', mult: 0.35 }, color: '#ff7a2a', description: 'Takes fire damage each turn.' },
  poisoned: { defaultLabel: 'Poisoned', harmful: true, blockedBy: 'mag', dot: { type: 'poison', mult: 0.3 }, color: '#7ccf3a', description: 'Takes poison damage each turn.' },
  bleeding: { defaultLabel: 'Bleeding', harmful: true, blockedBy: 'phys', dot: { type: 'piercing', mult: 0.2 }, color: '#c03040', description: 'Loses health each turn, ignoring armor.' },
  chilled: { defaultLabel: 'Chilled', harmful: true, color: '#9fe0ff', description: 'Movement reduced by half.' },
  frozen: { defaultLabel: 'Frozen', harmful: true, blockedBy: 'mag', skipTurn: true, color: '#7fd4ff', description: 'Cannot act.' },
  stunned: { defaultLabel: 'Stunned', harmful: true, blockedBy: 'mag', skipTurn: true, color: '#c9a6ff', description: 'Cannot act.' },
  knocked_down: { defaultLabel: 'Knocked Down', harmful: true, blockedBy: 'phys', skipTurn: true, color: '#d0b080', description: 'Cannot act.' },
  weakened: { defaultLabel: 'Weakened', harmful: true, blockedBy: 'phys', color: '#a08060', description: 'Deals 25% less damage.' },
  vulnerable: { defaultLabel: 'Vulnerable', harmful: true, blockedBy: 'mag', color: '#e070d0', description: 'Takes 25% more damage.' },
  slowed: { defaultLabel: 'Slowed', harmful: true, color: '#8090a0', description: 'Gains 1 less action point per turn.' },
  hasted: { defaultLabel: 'Hasted', harmful: false, color: '#ffe060', description: 'Gains 2 extra action points per turn.' },
  empowered: { defaultLabel: 'Empowered', harmful: false, color: '#ff9060', description: 'Deals 25% more damage.' },
  fortified: { defaultLabel: 'Fortified', harmful: false, color: '#c0c0d0', description: 'Takes 25% less damage.' },
  regenerating: { defaultLabel: 'Regenerating', harmful: false, color: '#60e090', description: 'Restores health each turn.' },
  taunted: { defaultLabel: 'Taunted', harmful: true, color: '#ff5050', description: 'Must attack the taunter.' },
  wet: { defaultLabel: 'Wet', harmful: false, color: '#5090ff', description: 'Immune to burning; shock may stun.' },
};

export const SURFACES = ['fire', 'poison', 'water', 'ice', 'oil', 'blessed'] as const;
export type SurfaceType = (typeof SURFACES)[number];
export const SURFACE_INFO: Record<SurfaceType, { defaultLabel: string; color: string; status?: StatusId; damage?: DamageType; moveCost?: number }> = {
  fire: { defaultLabel: 'Flames', color: '#ff6a1a', status: 'burning', damage: 'fire' },
  poison: { defaultLabel: 'Toxic Pool', color: '#6ac02a', status: 'poisoned', damage: 'poison' },
  water: { defaultLabel: 'Water', color: '#3a80e0', status: 'wet' },
  ice: { defaultLabel: 'Ice', color: '#bfefff', moveCost: 1 },
  oil: { defaultLabel: 'Oil', color: '#5a4a2a', status: 'slowed' },
  blessed: { defaultLabel: 'Hallowed Ground', color: '#ffe680', status: 'regenerating' },
};

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];
export const RARITY_INFO: Record<Rarity, { color: string; affixes: [number, number]; priceMult: number; weight: number }> = {
  common: { color: '#d8d8d8', affixes: [0, 0], priceMult: 1, weight: 60 },
  uncommon: { color: '#5fd35f', affixes: [1, 1], priceMult: 1.8, weight: 28 },
  rare: { color: '#4fa3ff', affixes: [2, 2], priceMult: 3.2, weight: 10 },
  epic: { color: '#c46bff', affixes: [3, 3], priceMult: 6, weight: 2.4 },
  legendary: { color: '#ffa630', affixes: [4, 4], priceMult: 12, weight: 0.3 },
};

/** Labels a world uses for the fixed mechanics. Everything has a sensible default. */
export interface Terminology {
  health: string;
  stamina: string;
  focus: string;
  physArmor: string;
  magArmor: string;
  gold: string;
  xp: string;
  level: string;
  town: string;
  dungeon: string;
  wilderness: string;
  quest: string;
  party: string;
  actionPoints: string;
  attributes: Record<AttributeId, string>;
  damageTypes: Record<DamageType, string>;
  statuses: Record<StatusId, string>;
  schools: Record<SchoolId, string>;
  surfaces: Record<SurfaceType, string>;
  rarities: Record<Rarity, string>;
}

const rec = <K extends string, V extends { defaultLabel: string }>(o: Record<K, V>): Record<K, string> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (v as V).defaultLabel])) as Record<K, string>;

export const DEFAULT_TERMINOLOGY: Terminology = {
  health: 'Health',
  stamina: 'Stamina',
  focus: 'Focus',
  physArmor: 'Armor',
  magArmor: 'Ward',
  gold: 'Gold',
  xp: 'Experience',
  level: 'Level',
  town: 'Town',
  dungeon: 'Dungeon',
  wilderness: 'Wilds',
  quest: 'Quest',
  party: 'Party',
  actionPoints: 'Action Points',
  attributes: rec(ATTRIBUTE_INFO),
  damageTypes: rec(DAMAGE_INFO),
  statuses: rec(STATUS_INFO),
  schools: rec(SCHOOL_INFO),
  surfaces: rec(SURFACE_INFO),
  rarities: { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' },
};

/** Merge a partial terminology (e.g. from an LLM) over the defaults, ignoring junk values. */
export function mergeTerminology(partial: unknown): Terminology {
  const out: Terminology = JSON.parse(JSON.stringify(DEFAULT_TERMINOLOGY));
  if (!partial || typeof partial !== 'object') return out;
  const p = partial as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 && v.length <= 32 ? v.trim() : undefined);
  for (const k of Object.keys(out) as (keyof Terminology)[]) {
    const cur = out[k];
    if (typeof cur === 'string') {
      const v = clean(p[k]);
      if (v) (out as unknown as Record<string, unknown>)[k] = v;
    } else if (p[k] && typeof p[k] === 'object') {
      const sub = p[k] as Record<string, unknown>;
      for (const sk of Object.keys(cur)) {
        const v = clean(sub[sk]);
        if (v) (cur as Record<string, string>)[sk] = v;
      }
    }
  }
  return out;
}

/** Optional systems a world may switch on or off. */
export interface WorldSystems {
  crafting: boolean;
  traps: boolean;
  /** When false, the focus pool is merged into stamina (single energy bar). */
  dualEnergy: boolean;
  lockpicking: boolean;
  dynamicQuests: boolean;
}

export const DEFAULT_SYSTEMS: WorldSystems = { crafting: true, traps: true, dualEnergy: true, lockpicking: true, dynamicQuests: true };
