/**
 * Pre-balanced skill templates. Worlds enable a subset and give each a name and flavor text.
 * Numbers scale automatically with the user's level through `powerAtLevel`.
 */
import type { AttributeId, DamageType, PoolId, SchoolId, StatusId, SurfaceType } from './core';

export type SkillTargeting = 'self' | 'ally' | 'enemy' | 'any' | 'ground';

export type SkillEffect =
  | { kind: 'damage'; mult: number; type: DamageType | 'weapon'; source: 'weapon' | 'skill' }
  | { kind: 'heal'; mult: number }
  | { kind: 'armor'; pool: 'phys' | 'mag'; mult: number }
  | { kind: 'status'; status: StatusId; chance: number; turns: number; target?: 'target' | 'self' }
  | { kind: 'surface'; surface: SurfaceType; radius: number; turns: number }
  | { kind: 'teleport' }
  | { kind: 'dash' }
  | { kind: 'cleanse' }
  | { kind: 'revive'; fraction: number }
  | { kind: 'lifesteal'; fraction: number }
  | { kind: 'chain'; jumps: number; falloff: number }
  | { kind: 'ap'; amount: number };

/** Non-combat behaviours the engine understands. */
export type UtilityKind = 'disarm_trap' | 'pick_lock' | 'detect_traps' | 'first_aid' | 'loot_bonus' | 'barter' | 'persuasion' | 'keen_senses';

export interface SkillTemplate {
  id: string;
  school: SchoolId;
  defaultName: string;
  /** Short mechanical summary (always shown, independent of flavor text). */
  summary: string;
  targeting: SkillTargeting;
  /** Range in tiles. 0 = self, 1.5 = melee. 'weapon' uses the equipped weapon range. */
  range: number | 'weapon';
  radius?: number;
  ap: number;
  cost: number;
  pool?: PoolId;
  cooldown: number;
  minLevel: number;
  effects: SkillEffect[];
  passive?: boolean;
  utility?: UtilityKind;
  /** Usable outside combat in real time (utility skills, heals). */
  outOfCombat?: boolean;
  /** Visual hint for the client particle system. */
  fx: 'slash' | 'arrow' | 'bolt' | 'nova' | 'heal' | 'buff' | 'debuff' | 'shadow' | 'beam' | 'cloud' | 'none';
  /** Attribute that scales the skill; defaults to the school attribute. */
  scaling?: AttributeId;
  /** Monster-only skills are never offered to players. */
  monsterOnly?: boolean;
}

const S = (t: SkillTemplate) => t;

export const SKILL_TEMPLATES: SkillTemplate[] = [
  // ---------------------------------------------------------------- Warfare
  S({ id: 'heavy_strike', school: 'warfare', defaultName: 'Heavy Strike', summary: '160% weapon damage to one enemy.', targeting: 'enemy', range: 'weapon', ap: 2, cost: 6, cooldown: 1, minLevel: 1, effects: [{ kind: 'damage', mult: 1.6, type: 'weapon', source: 'weapon' }], fx: 'slash' }),
  S({ id: 'whirlwind', school: 'warfare', defaultName: 'Whirlwind', summary: '100% weapon damage to all enemies around you.', targeting: 'self', range: 0, radius: 1.9, ap: 2, cost: 10, cooldown: 2, minLevel: 2, effects: [{ kind: 'damage', mult: 1.0, type: 'weapon', source: 'weapon' }], fx: 'nova' }),
  S({ id: 'shield_bash', school: 'warfare', defaultName: 'Bash', summary: '90% weapon damage and knocks the target down.', targeting: 'enemy', range: 1.6, ap: 2, cost: 8, cooldown: 3, minLevel: 3, effects: [{ kind: 'damage', mult: 0.9, type: 'physical', source: 'weapon' }, { kind: 'status', status: 'knocked_down', chance: 1, turns: 1 }], fx: 'slash' }),
  S({ id: 'battle_cry', school: 'warfare', defaultName: 'Battle Cry', summary: 'Empowers you and nearby allies for 2 turns.', targeting: 'self', range: 0, radius: 4, ap: 1, cost: 8, cooldown: 4, minLevel: 4, effects: [{ kind: 'status', status: 'empowered', chance: 1, turns: 2 }], fx: 'buff' }),
  S({ id: 'charge', school: 'warfare', defaultName: 'Charge', summary: 'Rush to an enemy up to 6 tiles away and strike for 110% weapon damage.', targeting: 'enemy', range: 6, ap: 2, cost: 10, cooldown: 3, minLevel: 2, effects: [{ kind: 'dash' }, { kind: 'damage', mult: 1.1, type: 'weapon', source: 'weapon' }], fx: 'slash' }),
  S({ id: 'fortify', school: 'warfare', defaultName: 'Fortify', summary: 'Restore physical armor and become fortified for 2 turns.', targeting: 'self', range: 0, ap: 1, cost: 8, cooldown: 3, minLevel: 3, effects: [{ kind: 'armor', pool: 'phys', mult: 1.4 }, { kind: 'status', status: 'fortified', chance: 1, turns: 2 }], fx: 'buff', scaling: 'vitality' }),
  S({ id: 'taunt', school: 'warfare', defaultName: 'Provoke', summary: 'Forces nearby enemies to attack you for 2 turns.', targeting: 'self', range: 0, radius: 3.5, ap: 1, cost: 6, cooldown: 4, minLevel: 5, effects: [{ kind: 'status', status: 'taunted', chance: 1, turns: 2 }], fx: 'debuff' }),
  S({ id: 'sunder', school: 'warfare', defaultName: 'Sunder', summary: '120% weapon damage and makes the target vulnerable.', targeting: 'enemy', range: 'weapon', ap: 2, cost: 10, cooldown: 3, minLevel: 6, effects: [{ kind: 'damage', mult: 1.2, type: 'weapon', source: 'weapon' }, { kind: 'status', status: 'vulnerable', chance: 1, turns: 2 }], fx: 'slash' }),

  // ---------------------------------------------------------------- Marksmanship
  S({ id: 'aimed_shot', school: 'marksmanship', defaultName: 'Aimed Shot', summary: '190% weapon damage with a ranged weapon.', targeting: 'enemy', range: 'weapon', ap: 2, cost: 8, cooldown: 2, minLevel: 1, effects: [{ kind: 'damage', mult: 1.9, type: 'weapon', source: 'weapon' }], fx: 'arrow' }),
  S({ id: 'volley', school: 'marksmanship', defaultName: 'Volley', summary: '85% weapon damage to all enemies in an area.', targeting: 'ground', range: 11, radius: 2, ap: 2, cost: 12, cooldown: 3, minLevel: 3, effects: [{ kind: 'damage', mult: 0.85, type: 'weapon', source: 'weapon' }], fx: 'arrow' }),
  S({ id: 'crippling_shot', school: 'marksmanship', defaultName: 'Crippling Shot', summary: '100% weapon damage and slows the target.', targeting: 'enemy', range: 'weapon', ap: 2, cost: 8, cooldown: 2, minLevel: 2, effects: [{ kind: 'damage', mult: 1.0, type: 'weapon', source: 'weapon' }, { kind: 'status', status: 'slowed', chance: 1, turns: 2 }, { kind: 'status', status: 'chilled', chance: 1, turns: 2 }], fx: 'arrow' }),
  S({ id: 'venom_shot', school: 'marksmanship', defaultName: 'Venom Shot', summary: '80% weapon damage and poisons the target.', targeting: 'enemy', range: 'weapon', ap: 2, cost: 8, cooldown: 2, minLevel: 4, effects: [{ kind: 'damage', mult: 0.8, type: 'weapon', source: 'weapon' }, { kind: 'status', status: 'poisoned', chance: 1, turns: 3 }], fx: 'arrow' }),
  S({ id: 'tactical_leap', school: 'marksmanship', defaultName: 'Tactical Leap', summary: 'Leap to a spot up to 6 tiles away.', targeting: 'ground', range: 6, ap: 1, cost: 6, cooldown: 3, minLevel: 2, effects: [{ kind: 'teleport' }], fx: 'none' }),
  S({ id: 'marked_target', school: 'marksmanship', defaultName: 'Mark Target', summary: 'Makes an enemy vulnerable for 3 turns.', targeting: 'enemy', range: 12, ap: 1, cost: 6, cooldown: 3, minLevel: 6, effects: [{ kind: 'status', status: 'vulnerable', chance: 1, turns: 3 }], fx: 'debuff' }),

  // ---------------------------------------------------------------- Shadow
  S({ id: 'backstab', school: 'shadow', defaultName: 'Backstab', summary: '210% weapon damage in melee.', targeting: 'enemy', range: 1.6, ap: 2, cost: 8, cooldown: 2, minLevel: 1, effects: [{ kind: 'damage', mult: 2.1, type: 'weapon', source: 'weapon' }], fx: 'shadow' }),
  S({ id: 'rupture', school: 'shadow', defaultName: 'Rupture', summary: '90% weapon damage and causes bleeding.', targeting: 'enemy', range: 1.6, ap: 1, cost: 6, cooldown: 2, minLevel: 2, effects: [{ kind: 'damage', mult: 0.9, type: 'weapon', source: 'weapon' }, { kind: 'status', status: 'bleeding', chance: 1, turns: 3 }], fx: 'slash' }),
  S({ id: 'shadowstep', school: 'shadow', defaultName: 'Shadowstep', summary: 'Teleport up to 7 tiles.', targeting: 'ground', range: 7, ap: 1, cost: 6, cooldown: 2, minLevel: 2, effects: [{ kind: 'teleport' }], fx: 'shadow' }),
  S({ id: 'crippling_poison', school: 'shadow', defaultName: 'Crippling Toxin', summary: 'Weakens and poisons an enemy in melee.', targeting: 'enemy', range: 1.6, ap: 1, cost: 6, cooldown: 3, minLevel: 4, effects: [{ kind: 'status', status: 'weakened', chance: 1, turns: 2 }, { kind: 'status', status: 'poisoned', chance: 1, turns: 2 }], fx: 'debuff' }),
  S({ id: 'adrenaline', school: 'shadow', defaultName: 'Adrenaline', summary: 'Gain 2 action points now.', targeting: 'self', range: 0, ap: 0, cost: 10, cooldown: 5, minLevel: 5, effects: [{ kind: 'ap', amount: 2 }], fx: 'buff' }),

  // ---------------------------------------------------------------- Elemental
  S({ id: 'firebolt', school: 'elemental', defaultName: 'Firebolt', summary: '110% fire damage; may set the target burning.', targeting: 'enemy', range: 11, ap: 2, cost: 6, cooldown: 0, minLevel: 1, effects: [{ kind: 'damage', mult: 1.1, type: 'fire', source: 'skill' }, { kind: 'status', status: 'burning', chance: 0.35, turns: 2 }], fx: 'bolt' }),
  S({ id: 'fireball', school: 'elemental', defaultName: 'Fireball', summary: '100% fire damage in an area and leaves flames.', targeting: 'ground', range: 11, radius: 2, ap: 3, cost: 14, cooldown: 4, minLevel: 4, effects: [{ kind: 'damage', mult: 1.0, type: 'fire', source: 'skill' }, { kind: 'surface', surface: 'fire', radius: 1.5, turns: 2 }], fx: 'bolt' }),
  S({ id: 'frost_lance', school: 'elemental', defaultName: 'Frost Lance', summary: '100% frost damage and chills the target.', targeting: 'enemy', range: 11, ap: 2, cost: 8, cooldown: 1, minLevel: 1, effects: [{ kind: 'damage', mult: 1.0, type: 'frost', source: 'skill' }, { kind: 'status', status: 'chilled', chance: 1, turns: 2 }], fx: 'bolt' }),
  S({ id: 'frost_nova', school: 'elemental', defaultName: 'Frost Nova', summary: '80% frost damage around you; may freeze.', targeting: 'self', range: 0, radius: 2.5, ap: 2, cost: 12, cooldown: 4, minLevel: 5, effects: [{ kind: 'damage', mult: 0.8, type: 'frost', source: 'skill' }, { kind: 'status', status: 'frozen', chance: 0.6, turns: 1 }], fx: 'nova' }),
  S({ id: 'lightning', school: 'elemental', defaultName: 'Lightning', summary: '110% shock damage; may stun.', targeting: 'enemy', range: 10, ap: 2, cost: 8, cooldown: 1, minLevel: 2, effects: [{ kind: 'damage', mult: 1.1, type: 'shock', source: 'skill' }, { kind: 'status', status: 'stunned', chance: 0.3, turns: 1 }], fx: 'beam' }),
  S({ id: 'chain_lightning', school: 'elemental', defaultName: 'Chain Lightning', summary: '90% shock damage that jumps to 3 more enemies.', targeting: 'enemy', range: 10, ap: 3, cost: 14, cooldown: 4, minLevel: 6, effects: [{ kind: 'damage', mult: 0.9, type: 'shock', source: 'skill' }, { kind: 'chain', jumps: 3, falloff: 0.8 }], fx: 'beam' }),
  S({ id: 'rain', school: 'elemental', defaultName: 'Rain', summary: 'Soaks an area in water, extinguishing fire.', targeting: 'ground', range: 11, radius: 2.5, ap: 1, cost: 6, cooldown: 3, minLevel: 3, effects: [{ kind: 'surface', surface: 'water', radius: 2.5, turns: 3 }, { kind: 'status', status: 'wet', chance: 1, turns: 2 }], fx: 'cloud' }),

  // ---------------------------------------------------------------- Occult
  S({ id: 'mind_spike', school: 'occult', defaultName: 'Mind Spike', summary: '100% psychic damage and weakens the target.', targeting: 'enemy', range: 10, ap: 2, cost: 8, cooldown: 1, minLevel: 1, effects: [{ kind: 'damage', mult: 1.0, type: 'psychic', source: 'skill' }, { kind: 'status', status: 'weakened', chance: 0.6, turns: 2 }], fx: 'beam' }),
  S({ id: 'drain_life', school: 'occult', defaultName: 'Drain Life', summary: '90% psychic damage; heals you for half the damage.', targeting: 'enemy', range: 8, ap: 2, cost: 10, cooldown: 2, minLevel: 2, effects: [{ kind: 'damage', mult: 0.9, type: 'psychic', source: 'skill' }, { kind: 'lifesteal', fraction: 0.5 }], fx: 'beam' }),
  S({ id: 'toxic_cloud', school: 'occult', defaultName: 'Toxic Cloud', summary: '70% poison damage in an area and leaves a toxic pool.', targeting: 'ground', range: 10, radius: 2, ap: 2, cost: 12, cooldown: 4, minLevel: 3, effects: [{ kind: 'damage', mult: 0.7, type: 'poison', source: 'skill' }, { kind: 'status', status: 'poisoned', chance: 0.8, turns: 2 }, { kind: 'surface', surface: 'poison', radius: 1.8, turns: 3 }], fx: 'cloud' }),
  S({ id: 'hex', school: 'occult', defaultName: 'Hex', summary: 'Makes an enemy vulnerable and slowed.', targeting: 'enemy', range: 10, ap: 1, cost: 8, cooldown: 3, minLevel: 4, effects: [{ kind: 'status', status: 'vulnerable', chance: 1, turns: 2 }, { kind: 'status', status: 'slowed', chance: 1, turns: 2 }], fx: 'debuff' }),
  S({ id: 'terror', school: 'occult', defaultName: 'Dread', summary: '60% psychic damage to enemies in an area; may stun.', targeting: 'ground', range: 9, radius: 2.2, ap: 3, cost: 14, cooldown: 5, minLevel: 7, effects: [{ kind: 'damage', mult: 0.6, type: 'psychic', source: 'skill' }, { kind: 'status', status: 'stunned', chance: 0.5, turns: 1 }], fx: 'nova' }),

  // ---------------------------------------------------------------- Restoration
  S({ id: 'heal', school: 'restoration', defaultName: 'Mend', summary: 'Restores health to an ally.', targeting: 'ally', range: 9, ap: 1, cost: 8, cooldown: 1, minLevel: 1, effects: [{ kind: 'heal', mult: 1.6 }], fx: 'heal', outOfCombat: true }),
  S({ id: 'mending_wave', school: 'restoration', defaultName: 'Mending Wave', summary: 'Heals all allies in an area.', targeting: 'ground', range: 9, radius: 3, ap: 2, cost: 14, cooldown: 4, minLevel: 4, effects: [{ kind: 'heal', mult: 1.1 }], fx: 'heal', outOfCombat: true }),
  S({ id: 'regeneration', school: 'restoration', defaultName: 'Renewal', summary: 'An ally regenerates health for 3 turns.', targeting: 'ally', range: 9, ap: 1, cost: 8, cooldown: 3, minLevel: 2, effects: [{ kind: 'status', status: 'regenerating', chance: 1, turns: 3 }], fx: 'heal' }),
  S({ id: 'ward', school: 'restoration', defaultName: 'Ward', summary: 'Restores magic armor to an ally.', targeting: 'ally', range: 9, ap: 1, cost: 8, cooldown: 2, minLevel: 2, effects: [{ kind: 'armor', pool: 'mag', mult: 1.5 }], fx: 'buff' }),
  S({ id: 'cleanse', school: 'restoration', defaultName: 'Purify', summary: 'Removes harmful effects from an ally.', targeting: 'ally', range: 9, ap: 1, cost: 6, cooldown: 2, minLevel: 3, effects: [{ kind: 'cleanse' }], fx: 'heal', outOfCombat: true }),
  S({ id: 'smite', school: 'restoration', defaultName: 'Smite', summary: '110% radiant damage to one enemy.', targeting: 'enemy', range: 9, ap: 2, cost: 8, cooldown: 1, minLevel: 1, effects: [{ kind: 'damage', mult: 1.1, type: 'radiant', source: 'skill' }], fx: 'beam' }),
  S({ id: 'revive', school: 'restoration', defaultName: 'Revive', summary: 'Brings a fallen ally back with 35% health.', targeting: 'ally', range: 6, ap: 3, cost: 16, cooldown: 6, minLevel: 5, effects: [{ kind: 'revive', fraction: 0.35 }], fx: 'heal' }),
  S({ id: 'haste', school: 'restoration', defaultName: 'Quicken', summary: 'An ally is hasted (+2 AP) for 2 turns.', targeting: 'ally', range: 9, ap: 1, cost: 10, cooldown: 5, minLevel: 6, effects: [{ kind: 'status', status: 'hasted', chance: 1, turns: 2 }], fx: 'buff' }),
  S({ id: 'sanctuary', school: 'restoration', defaultName: 'Sanctuary', summary: 'Creates healing ground in an area.', targeting: 'ground', range: 8, radius: 2, ap: 2, cost: 14, cooldown: 5, minLevel: 7, effects: [{ kind: 'surface', surface: 'blessed', radius: 2, turns: 3 }, { kind: 'heal', mult: 0.6 }], fx: 'heal' }),

  // ---------------------------------------------------------------- Utility / passives
  S({ id: 'disarm_trap', school: 'utility', defaultName: 'Disarm Trap', summary: 'Disarm a detected trap. Success scales with Wits and level.', targeting: 'ground', range: 1.6, ap: 1, cost: 0, cooldown: 0, minLevel: 1, effects: [], utility: 'disarm_trap', outOfCombat: true, fx: 'none' }),
  S({ id: 'pick_lock', school: 'utility', defaultName: 'Pick Lock', summary: 'Open locked containers and doors.', targeting: 'ground', range: 1.6, ap: 1, cost: 0, cooldown: 0, minLevel: 1, effects: [], utility: 'pick_lock', outOfCombat: true, fx: 'none' }),
  S({ id: 'keen_eye', school: 'utility', defaultName: 'Keen Eye', summary: 'Passive: detect traps from much farther away.', targeting: 'self', range: 0, ap: 0, cost: 0, cooldown: 0, minLevel: 1, effects: [], passive: true, utility: 'detect_traps', fx: 'none' }),
  S({ id: 'treasure_hunter', school: 'utility', defaultName: 'Treasure Hunter', summary: 'Passive: +30% loot rarity and gold found.', targeting: 'self', range: 0, ap: 0, cost: 0, cooldown: 0, minLevel: 1, effects: [], passive: true, utility: 'loot_bonus', fx: 'none' }),
  S({ id: 'haggler', school: 'utility', defaultName: 'Haggler', summary: 'Passive: buy for 15% less and sell for 15% more.', targeting: 'self', range: 0, ap: 0, cost: 0, cooldown: 0, minLevel: 1, effects: [], passive: true, utility: 'barter', fx: 'none' }),
  S({ id: 'silver_tongue', school: 'utility', defaultName: 'Silver Tongue', summary: 'Passive: NPCs are more easily persuaded.', targeting: 'self', range: 0, ap: 0, cost: 0, cooldown: 0, minLevel: 1, effects: [], passive: true, utility: 'persuasion', fx: 'none' }),
  S({ id: 'first_aid', school: 'utility', defaultName: 'First Aid', summary: 'Restore 50% health to yourself. Out of combat only.', targeting: 'self', range: 0, ap: 1, cost: 0, cooldown: 3, minLevel: 1, effects: [{ kind: 'heal', mult: 2.5 }], utility: 'first_aid', outOfCombat: true, fx: 'heal' }),

  // ---------------------------------------------------------------- Monster-only
  S({ id: 'm_bite', school: 'warfare', defaultName: 'Savage Bite', summary: '130% weapon damage; may cause bleeding.', targeting: 'enemy', range: 1.6, ap: 2, cost: 0, cooldown: 2, minLevel: 1, effects: [{ kind: 'damage', mult: 1.3, type: 'weapon', source: 'weapon' }, { kind: 'status', status: 'bleeding', chance: 0.4, turns: 2 }], fx: 'slash', monsterOnly: true }),
  S({ id: 'm_slam', school: 'warfare', defaultName: 'Crushing Slam', summary: '90% weapon damage around the attacker; knocks down.', targeting: 'self', range: 0, radius: 2, ap: 3, cost: 0, cooldown: 3, minLevel: 3, effects: [{ kind: 'damage', mult: 0.9, type: 'physical', source: 'weapon' }, { kind: 'status', status: 'knocked_down', chance: 0.6, turns: 1 }], fx: 'nova', monsterOnly: true }),
  S({ id: 'm_spit', school: 'occult', defaultName: 'Acid Spit', summary: '80% poison damage at range.', targeting: 'enemy', range: 8, ap: 2, cost: 0, cooldown: 1, minLevel: 1, effects: [{ kind: 'damage', mult: 0.8, type: 'poison', source: 'skill' }, { kind: 'status', status: 'poisoned', chance: 0.5, turns: 2 }], fx: 'bolt', monsterOnly: true }),
  S({ id: 'm_enrage', school: 'warfare', defaultName: 'Enrage', summary: 'Becomes empowered and hasted.', targeting: 'self', range: 0, ap: 1, cost: 0, cooldown: 5, minLevel: 5, effects: [{ kind: 'status', status: 'empowered', chance: 1, turns: 3 }, { kind: 'status', status: 'hasted', chance: 1, turns: 1 }], fx: 'buff', monsterOnly: true }),
];

export const SKILLS: Record<string, SkillTemplate> = Object.fromEntries(SKILL_TEMPLATES.map((s) => [s.id, s]));
export const PLAYER_SKILL_IDS = SKILL_TEMPLATES.filter((s) => !s.monsterOnly).map((s) => s.id);

/** The always-available basic attack. */
export const BASIC_ATTACK: SkillTemplate = {
  id: 'attack', school: 'warfare', defaultName: 'Attack', summary: 'Attack with your weapon.', targeting: 'enemy', range: 'weapon', ap: 2, cost: 0, cooldown: 0, minLevel: 1,
  effects: [{ kind: 'damage', mult: 1, type: 'weapon', source: 'weapon' }], fx: 'slash',
};

export function getSkill(id: string): SkillTemplate | undefined {
  return id === 'attack' ? BASIC_ATTACK : SKILLS[id];
}

/** Skill flavor a world gives a template. */
export interface SkillFlavor {
  name: string;
  description: string;
}
