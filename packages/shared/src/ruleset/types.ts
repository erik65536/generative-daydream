import type { Presentation } from '../world/instance';
/**
 * A world's ruleset: pure data, generated with the world and interpreted by the engine.
 * See docs/rulesets.md. Ids are world-specific strings; nothing here is a fixed enum except the
 * engine vocabularies (turn models, death modes, effect primitives, control kinds, monster roles).
 */


// ------------------------------------------------------------------------------------ engine vocabularies

export type TurnModelId = 'ap';
export type DeathModeId = 'corpse_run';
export type ReviveMode = 'heal' | 'special' | 'after_combat';
export type ControlKind = 'root' | 'silence' | 'disarm' | 'slow';
export const MONSTER_ROLES = ['brute', 'skirmisher', 'archer', 'caster', 'healer', 'swarm', 'guardian', 'assassin'] as const;
export type MonsterRole = (typeof MONSTER_ROLES)[number];
export type SlotKind = 'weapon' | 'offhand' | 'armor' | 'accessory';
export type Targeting = 'self' | 'ally' | 'enemy' | 'ground';
export type ClassRole = 'tank' | 'melee' | 'ranged' | 'caster' | 'support' | 'hybrid';
export type FxKind = 'slash' | 'arrow' | 'bolt' | 'nova' | 'heal' | 'buff' | 'debuff' | 'shadow' | 'beam' | 'cloud' | 'none';
export type DifficultyId = 'story' | 'easy' | 'normal' | 'hard' | 'brutal';
export const DIFFICULTIES: DifficultyId[] = ['story', 'easy', 'normal', 'hard', 'brutal'];

/**
 * Stat ids. Engine-known forms:
 *   hp, hpRegen, pool:<poolId>, poolRegen:<poolId>, move, initiative, crit, critDmg, dodge, power,
 *   dmg:<typeId|subtypeId>, healing, mit:<typeId>, res:<subtypeId>, lifesteal, thorns, onhit:<subtypeId|typeId>,
 *   trapSense, lockpick, barter, lootFind
 * Which unit a stat uses is decided by `statUnit()` in stats.ts.
 */
export type StatId = string;

export interface Modifier {
  stat: StatId;
  /** Scaled stats (hp, mit, thorns, onhit, trapSense, lockpick, hpRegen) store a coefficient of the level curve; others store the value. */
  value: number;
}

// ------------------------------------------------------------------------------------ building blocks

export interface Curve {
  /** value(L) = base * (1 + lin*(L-1) + quad*(L-1)^2) */
  base: number;
  lin: number;
  quad: number;
}

/** Piecewise-linear multiplier over levels (knots sorted by level). */
export type Knots = { level: number; value: number }[];

export interface PoolDef {
  id: string;
  name: string;
  color: string;
  description: string;
  /** Size at level 1 and growth per level. */
  base: number;
  perLevel: number;
  /** Fraction of max restored at the start of each combat turn. */
  regenPerTurn: number;
}

export interface AttributeDef {
  id: string;
  name: string;
  abbr: string;
  description: string;
  /** Effect of each point above the base value. */
  perPoint: Modifier[];
}

export interface DamageTypeDef {
  id: string;
  name: string;
  color: string;
  description: string;
  /** Name of the mitigation stat (e.g. "Armor", "Ward"). */
  mitigationName: string;
}

export interface SubtypeDef {
  id: string;
  name: string;
  color: string;
  typeId: string;
  /** Status this subtype tends to apply (used by monsters, traps, surfaces). */
  statusId?: string;
  surfaceId?: string;
}

export interface StatusDef {
  id: string;
  name: string;
  color: string;
  description: string;
  harmful: boolean;
  /** Damage per turn: coefficient of the applier's damage-per-AP. */
  dot?: { coef: number; subtypeId?: string; typeId: string };
  /** Healing per turn: coefficient of the applier's damage-per-AP. */
  hot?: { coef: number };
  modifiers?: Modifier[];
  control?: ControlKind;
  /** For slow: AP lost per turn. */
  apLoss?: number;
}

export interface SurfaceDef {
  id: string;
  name: string;
  color: string;
  statusId?: string;
  /** Damage per turn to those standing in it. */
  dot?: { coef: number; subtypeId?: string; typeId: string };
  /** Extra movement cost (tiles) to cross a tile. */
  moveCost?: number;
  /** Placing this surface on `other` turns it into `result` (or removes both when result is null). */
  reactions?: { other: string; result: string | null }[];
}

export interface SlotDef {
  id: string;
  name: string;
  kind: SlotKind;
}

export interface RarityDef {
  id: string;
  name: string;
  color: string;
  affixes: [number, number];
  /** Multiplier on an item's power budget. */
  budget: number;
  weight: number;
  priceMult: number;
}

// ------------------------------------------------------------------------------------ effects & skills

export type Effect =
  /** Damage: coef × damage-per-AP of the user (weapon damage when `weapon`). */
  | { kind: 'damage'; coef: number; typeId?: string; subtypeId?: string; weapon?: boolean }
  | { kind: 'heal'; coef: number }
  /** Temporary health that absorbs damage. */
  | { kind: 'barrier'; coef: number; turns: number }
  | { kind: 'status'; statusId: string; chance: number; turns: number; self?: boolean }
  | { kind: 'surface'; surfaceId: string; radius: number; turns: number }
  | { kind: 'restore'; poolId: string; amount: number }
  | { kind: 'cleanse' }
  | { kind: 'revive'; fraction: number }
  | { kind: 'lifesteal'; fraction: number }
  | { kind: 'chain'; jumps: number; falloff: number }
  | { kind: 'teleport' }
  | { kind: 'dash' }
  | { kind: 'push'; distance: number };

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  /** Owning class id, or 'monster' / 'general'. */
  owner: string;
  targeting: Targeting;
  /** Range in tiles; ignored when `weaponRange`. */
  range: number;
  weaponRange?: boolean;
  radius?: number;
  ap: number;
  cooldown: number;
  cost?: { poolId: string; amount: number };
  effects: Effect[];
  /** Potency gained per extra rank (rank 1 = base). */
  rankBonus: number;
  maxRank: number;
  tags: string[];
  fx: FxKind;
  outOfCombat?: boolean;
  /** Balance-loop correction applied to every magnitude (damage, heal, barrier, dot via statuses). */
  tune: number;
  /** Utility behaviour understood by the engine outside combat. */
  utility?: 'disarm_trap' | 'pick_lock';
}

// ------------------------------------------------------------------------------------ characters

export interface KinDef {
  id: string;
  name: string;
  description: string;
  /** What a person of this kin looks like (used to draw its heroes). */
  appearance: string;
  /** Each kin is one gender, balanced over the world's kins. */
  presentation: Presentation;
  attributes: Record<string, number>;
  modifiers: Modifier[];
}

export type TreeNodeKind = 'skill' | 'rank' | 'passive' | 'capstone' | 'attribute';

export interface TreeNode {
  id: string;
  name: string;
  description: string;
  kind: TreeNodeKind;
  branch: string;
  tier: number;
  maxRank: number;
  skillId?: string;
  attributeId?: string;
  /** Per rank. */
  modifiers?: Modifier[];
  tune?: number;
}

export interface BranchDef {
  id: string;
  name: string;
  description: string;
}

export interface ClassDef {
  id: string;
  name: string;
  description: string;
  role: ClassRole;
  primaryAttributes: string[];
  attributes: Record<string, number>;
  startingSkills: string[];
  /** Base ids equipped at creation, per slot id. */
  startingGear: Record<string, string>;
  branches: BranchDef[];
  nodes: TreeNode[];
  /** Balance-loop correction on the class's health and damage. */
  tune: { hp: number; dmg: number };
  /** Monster role used when the class is an AI companion. */
  aiRole: MonsterRole;
}

// ------------------------------------------------------------------------------------ items

export type ItemCategory = 'equipment' | 'potion' | 'material' | 'valuable' | 'tool' | 'quest' | 'key';

export interface WeaponDef {
  /** Damage per AP relative to the reference curve. */
  coef: number;
  apCost: number;
  range: number;
  typeId: string;
  subtypeId?: string;
  scaling: string;
  twoHanded?: boolean;
  /** Ranged weapons draw projectiles. */
  projectile?: boolean;
}

export interface ItemBaseDef {
  id: string;
  name: string;
  description: string;
  category: ItemCategory;
  slotId?: string;
  weapon?: WeaponDef;
  /** Mitigation coefficients per damage type (scaled by item level). */
  defense?: Record<string, number>;
  implicit?: Modifier[];
  /** Potions and tools. */
  use?: { effects: Effect[]; ap: number; targeting: Targeting; radius?: number; outOfCombat: boolean; tool?: 'disarm' | 'unlock' | 'recall' };
  stackable: boolean;
  /** Per-slot stack limit (defaults by category). */
  maxStack?: number;
  price: number;
  dropWeight: number;
  icon: string;
  tier?: number;
  tags: string[];
}

export interface AffixDef {
  id: string;
  prefix: string;
  suffix: string;
  stat: StatId;
  slotKinds: SlotKind[];
  weight: number;
  /** Value at item level 1 with rarity budget 1; grows with level for scaled stats via the curves. */
  value: number;
  /** Extra growth per level for percentage stats. */
  perLevel: number;
  cap?: number;
}

export interface RecipeDef {
  id: string;
  name: string;
  inputs: { itemId: string; qty: number }[];
  output: { itemId: string; qty: number } | { slotKind: SlotKind; rarityId: string };
  gold: number;
}

export interface TrapDef {
  id: string;
  name: string;
  typeId: string;
  subtypeId?: string;
  coef: number;
  statusId?: string;
  surfaceId?: string;
  radius: number;
}

// ------------------------------------------------------------------------------------ monsters & encounters

export interface MonsterRoleDef {
  hp: number;
  dmg: number;
  /** Mitigation coefficient per damage type. */
  defense: Record<string, number>;
  range: number;
  move: number;
  initiative: number;
  /** Encounter threat units (a normal monster ≈ 1). */
  threat: number;
  skills: string[];
}

// ------------------------------------------------------------------------------------ the ruleset

export interface Ruleset {
  id: string;
  name: string;
  /** Short flavour introduction for the codex. */
  intro: string;

  turn: { model: TurnModelId; apPerTurn: number; apMax: number; apStart: number; tilesPerAp: number };
  death: { mode: DeathModeId; keepGold: boolean };
  revive: ReviveMode;
  resolution: { variance: number; crit: boolean; baseCrit: number; critMult: number; critCap: number; dodge: boolean; baseDodge: number; dodgeCap: number };
  control: { enabled: boolean; immunityTurns: number };
  recovery: { secondsToFull: number };
  /** A party of one gets this bonus (tuned by the balance loop for solo worlds). */
  party: { soloBonus: { hp: number; dmg: number; ap: number } };

  health: { name: string; color: string };
  pools: PoolDef[];
  attributes: AttributeDef[];
  attributeBase: number;
  damageTypes: DamageTypeDef[];
  subtypes: SubtypeDef[];
  statuses: StatusDef[];
  surfaces: SurfaceDef[];
  slots: SlotDef[];
  rarities: RarityDef[];
  skills: SkillDef[];
  /** The always-available weapon attack. */
  basicAttackId: string;
  kins: KinDef[];
  classes: ClassDef[];
  /** Shared attribute branch nodes added to every class tree. */
  attributeNodes: TreeNode[];
  items: ItemBaseDef[];
  affixes: AffixDef[];
  recipes: RecipeDef[];
  traps: TrapDef[];
  monsters: Record<MonsterRole, MonsterRoleDef>;
  /** Elite / boss multipliers on health and damage. */
  elite: { hp: number; dmg: number };
  boss: { hp: number; dmg: number };

  curves: {
    hp: Curve;
    dmg: Curve;
    mit: Curve;
    /** Monster multipliers over level, fitted by the balance loop. */
    monsterHp: Knots;
    monsterDmg: Knots;
  };

  progression: {
    maxLevel: number;
    /** xp[L] = total experience needed to reach level L (index 0 and 1 are 0). */
    xp: number[];
    treePointsStart: number;
    treePointsPerLevel: number;
    /** Attribute points granted by each rank of an attribute node. */
    attributePerRank: number;
    /** Points spent in a branch needed to unlock each tier. */
    tierRequirements: number[];
    killXp: Curve;
  };

  economy: { currency: string; sellRatio: number; priceMult: number; goldPerKill: Curve };
  inventory: { slots: number; upgrades: number; slotsPerUpgrade: number; upgradeCost: number };
  crafting: { enabled: boolean; upgrades: { enabled: boolean; maxLevel: number; perLevel: number; materialId?: string; gold: number }; enchanting: { enabled: boolean; materialId?: string; gold: number } };

  systems: {
    traps: boolean;
    locks: boolean;
    surfaces: boolean;
    subtypes: boolean;
    statuses: boolean;
    buffPotions: boolean;
    damagePotions: boolean;
    dynamicQuests: boolean;
    /** Travel between visited cities from their waypoints, and items that take the party back (a rule the world's maker picks). */
    fastTravel: boolean;
  };

  /** Per-save difficulty: enemy multipliers over level and encounter adjustments. */
  difficulty: Record<DifficultyId, { name: string; enemyHp: Knots; enemyDmg: Knots; extraEnemyChance: number; eliteChance: number; lootMult: number }>;

  terminology: { xp: string; level: string; actionPoints: string; party: string; town: string; dungeon: string; wilderness: string; quest: string; currency: string; /** What a class is called. */ calling: string; /** What an origin or ancestry choice is called. */ kin: string };

  ui: { material: 'parchment' | 'wood' | 'stone' | 'metal' | 'glass' | 'organic' | 'paper' | 'neon'; ornament: 'none' | 'filigree' | 'runes' | 'rivets' | 'circuit' | 'vines'; typeface?: 'engraved' | 'classic' | 'modern' | 'condensed' | 'storybook' | 'gothic' | 'technical'; grading: { tint: string; saturation: number; contrast: number; vignette: number; grain: number } };

  balance?: BalanceReport;
}

export interface BalanceScenarioResult {
  id: string;
  label: string;
  level: number;
  difficulty: DifficultyId;
  runs: number;
  winRate: number;
  hpLost: number;
  rounds: number;
  target: { winRate: [number, number]; hpLost: [number, number]; rounds: [number, number] };
  ok: boolean;
}

export interface BalanceReport {
  at: number;
  iterations: number;
  durationMs: number;
  fights: number;
  scenarios: BalanceScenarioResult[];
  classes: { classId: string; winRate: number; tune: { hp: number; dmg: number } }[];
  skillUsage: { skillId: string; share: number; tune: number }[];
  outliers: string[];
  notes: string[];
}
