/**
 * Ruleset intent: what the AI decides. Names, structure, roles and relative weights (1–5) — never numbers.
 * Split into four structured calls so local models can produce each part reliably:
 *   core (terminology, pools, attributes, damage, statuses, slots, systems), gear, classes overview, class trees.
 */
import { z } from 'zod';

const name = z.string().min(1).max(40);
const text = (n = 220) => z.string().max(n);
const color = z.string().max(24).describe('Hex colour like #a83c2e');
const weight = z.number().int().min(1).max(5);

/** Effects an attribute point, passive, perk or affix can have. Pool/type/subtype specific ones end in ":<name>". */
export const STAT_EFFECTS = [
  'health', 'health_regen', 'pool', 'pool_regen', 'melee_damage', 'ranged_damage', 'skill_damage', 'all_damage', 'type_damage', 'subtype_damage',
  'healing', 'crit_chance', 'crit_damage', 'dodge', 'movement', 'initiative', 'mitigation', 'resist_all', 'resist', 'trap_sense', 'lockpicking', 'barter', 'loot_find', 'life_steal', 'thorns',
] as const;
export type StatEffect = (typeof STAT_EFFECTS)[number];

const statPick = z.object({
  effect: z.enum(STAT_EFFECTS),
  /** For pool/pool_regen (pool name), mitigation/type_damage (damage type name), resist/subtype_damage (subtype name). */
  of: z.string().max(40).optional(),
  weight,
});

// ------------------------------------------------------------------------------------ core

export const CoreIntentSchema = z.object({
  name: name.describe('Name of this rules set, e.g. "The Tidebound Code"'),
  intro: text(400).describe('Two sentences introducing how the world works mechanically, in-world voice.'),
  numbers: z.enum(['small', 'medium', 'large']).describe('How big numbers feel: small (health ~30), medium (~80), large (~400).'),
  health: z.object({ name, color }),
  terminology: z.object({
    xp: name, level: name, actionPoints: name, currency: name, party: name, town: name, dungeon: name, wilderness: name, quest: name,
    calling: name.optional().describe('What a character class is called here (e.g. Calling, Discipline, Job Title, Specialty)'),
    kin: name.optional().describe('What a character origin or ancestry choice is called here (e.g. Kin, Bloodline, Department, Background)'),
  }),
  pools: z.array(z.object({ name, color, description: text(), use: z.enum(['physical', 'magical', 'any']) })).max(3).describe('0-3 resource pools skills spend (e.g. Stamina, Mana). Empty means skills only cost AP and cooldowns.'),
  attributes: z.array(z.object({ name, abbr: z.string().max(4), description: text(), effects: z.array(statPick).min(1).max(3) })).min(3).max(6),
  damageTypes: z.array(z.object({ name, color, description: text(140), mitigationName: name })).min(1).max(3).describe('Broad damage categories each with its own mitigation stat, e.g. Physical (Armor) and Magical (Ward).'),
  subtypes: z.array(z.object({ name, type: name.describe('Name of its damage type'), color, status: z.string().max(40).optional().describe('Name of the status it tends to inflict') })).max(8),
  statuses: z.array(z.object({
    name, color, description: text(140),
    kind: z.enum(['damage_over_time', 'heal_over_time', 'buff', 'debuff', 'control']),
    subtype: z.string().max(40).optional().describe('For damage_over_time: subtype name'),
    control: z.enum(['root', 'silence', 'disarm', 'slow']).optional().describe('For control: root = cannot move, silence = no skills, disarm = no weapon attacks, slow = fewer action points'),
    stats: z.array(z.object({ effect: z.enum(STAT_EFFECTS), of: z.string().max(40).optional(), direction: z.enum(['up', 'down']) })).max(2).optional(),
  })).max(12),
  slots: z.array(z.object({ name, kind: z.enum(['weapon', 'offhand', 'armor', 'accessory']) })).min(3).max(10).describe('Equipment slots; exactly one weapon slot.'),
  rarities: z.array(name).length(5).describe('Five item quality names from lowest to highest'),
  traps: z.array(z.object({ name, subtype: z.string().max(40).optional(), status: z.string().max(40).optional() })).max(6),
  systems: z.object({ traps: z.boolean(), locks: z.boolean(), surfaces: z.boolean(), crafting: z.boolean(), upgrades: z.boolean(), enchanting: z.boolean(), buffPotions: z.boolean(), damagePotions: z.boolean(), control: z.boolean() }),
  rules: z.object({ crit: z.boolean(), dodge: z.boolean(), variance: z.enum(['low', 'medium', 'high']), revive: z.enum(['heal', 'special', 'after_combat']) }),
  inventory: z.object({ slots: z.number().int().min(12).max(200), upgrades: z.number().int().min(0).max(10) }),
  ui: z.object({
    material: z.enum(['parchment', 'wood', 'stone', 'metal', 'glass', 'organic', 'paper', 'neon']),
    ornament: z.enum(['none', 'filigree', 'runes', 'rivets', 'circuit', 'vines']),
    tint: color.describe('Colour grading tint for the game view'),
    mood: z.enum(['warm', 'cold', 'bleak', 'vivid', 'muted', 'neon']),
    typeface: z.enum(['engraved', 'classic', 'modern', 'condensed', 'storybook', 'gothic', 'technical']).optional().describe('Lettering style of the interface'),
  }),
});
export type CoreIntent = z.infer<typeof CoreIntentSchema>;

// ------------------------------------------------------------------------------------ gear

export const GearIntentSchema = z.object({
  weapons: z.array(z.object({ name, description: text(140), style: z.enum(['light_melee', 'heavy_melee', 'quick_melee', 'ranged', 'caster', 'thrown']), damageType: name, subtype: z.string().max(40).optional() })).min(3).max(8),
  armor: z.array(z.object({ name, slot: name.describe('Armor slot name'), weight: z.enum(['heavy', 'medium', 'light']), description: text(120) })).min(2).max(18),
  offhands: z.array(z.object({ name, style: z.enum(['shield', 'focus', 'quiver', 'charm']), description: text(120) })).max(4),
  accessories: z.array(z.object({ name, slot: name, description: text(120) })).max(6),
  potions: z.array(z.object({ name, description: text(120), effect: z.enum(['heal', 'restore', 'buff', 'damage', 'cleanse', 'revive']), of: z.string().max(40).optional().describe('pool name for restore, status name for buff, subtype or damage type name for damage') })).min(2).max(8),
  materials: z.array(z.object({ name, description: text(100), tier: z.number().int().min(1).max(3) })).max(6),
  valuables: z.array(z.object({ name })).max(4),
  tools: z.object({ disarm: z.string().max(40).optional(), unlock: z.string().max(40).optional(), recall: z.string().max(40).optional() }),
  affixNames: z.array(z.object({ effect: z.enum(STAT_EFFECTS), of: z.string().max(40).optional(), prefix: name, suffix: name })).max(30),
  kins: z.array(z.object({ name, description: text(200), attributes: z.array(z.object({ attribute: name, points: z.number().int().min(1).max(2) })).max(2), perk: statPick.optional() })).min(1).max(6),
});
export type GearIntent = z.infer<typeof GearIntentSchema>;

// ------------------------------------------------------------------------------------ classes

export const ClassesIntentSchema = z.object({
  classes: z.array(z.object({
    name,
    description: text(240),
    role: z.enum(['tank', 'melee', 'ranged', 'caster', 'support', 'hybrid']),
    primaryAttributes: z.array(name).min(1).max(2),
    pool: z.string().max(40).optional().describe('Pool name its skills mostly spend'),
    weapon: name.describe('Name of one of the weapons'),
    armor: z.enum(['heavy', 'medium', 'light']),
    offhand: z.string().max(40).optional(),
    appearance: text(220).describe('What a character of this class looks like (used to draw them)'),
    branches: z.array(z.object({ name, theme: text(140) })).length(3),
  })).min(2).max(6),
});
export type ClassesIntent = z.infer<typeof ClassesIntentSchema>;

export const SKILL_EFFECT_KINDS = ['damage', 'heal', 'barrier', 'status', 'surface', 'restore', 'cleanse', 'revive', 'lifesteal', 'chain', 'teleport', 'dash', 'push'] as const;

export const SkillIntentSchema = z.object({
  name,
  description: text(160),
  branch: z.number().int().min(0).max(2),
  tier: z.number().int().min(0).max(3),
  targeting: z.enum(['enemy', 'ally', 'self', 'ground']),
  range: z.enum(['melee', 'weapon', 'short', 'long']),
  area: z.enum(['none', 'small', 'large']),
  ap: z.number().int().min(1).max(3),
  cooldown: z.enum(['none', 'short', 'long']),
  cost: z.enum(['none', 'low', 'medium', 'high']),
  usesWeapon: z.boolean(),
  effects: z.array(z.object({
    kind: z.enum(SKILL_EFFECT_KINDS),
    weight,
    of: z.string().max(40).optional().describe('damage: subtype or damage type name; status: status name; surface: subtype name; restore: pool name'),
    self: z.boolean().optional(),
  })).min(1).max(3),
  fx: z.enum(['slash', 'arrow', 'bolt', 'nova', 'heal', 'buff', 'debuff', 'shadow', 'beam', 'cloud']),
});
export type SkillIntent = z.infer<typeof SkillIntentSchema>;

export const ClassTreeIntentSchema = z.object({
  skills: z.array(SkillIntentSchema).min(6).max(12).describe('Class skills across the three branches; tier 0 skills of branches 0 and 1 are known from the start.'),
  passives: z.array(z.object({ name, description: text(140), branch: z.number().int().min(0).max(2), tier: z.number().int().min(0).max(3), capstone: z.boolean(), effects: z.array(statPick).min(1).max(2) })).min(3).max(9),
});
export type ClassTreeIntent = z.infer<typeof ClassTreeIntentSchema>;

export interface RulesetIntent {
  core: CoreIntent;
  gear: GearIntent;
  classes: ClassesIntent;
  trees: ClassTreeIntent[];
}

/** User overrides from the world creation form (advanced section). */
export interface RulesOverrides {
  turnModel?: 'ap';
  deathMode?: 'corpse_run';
  revive?: 'heal' | 'special' | 'after_combat';
  crit?: boolean;
  dodge?: boolean;
  control?: boolean;
  surfaces?: boolean;
  traps?: boolean;
  locks?: boolean;
  crafting?: boolean;
  upgrades?: boolean;
  enchanting?: boolean;
  classes?: number;
}
