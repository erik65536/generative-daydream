/**
 * Procedural fallback intent: a complete, well-formed ruleset intent for each genre, used field by field
 * whenever the model output is missing or unusable. Structure is shared; names are themed per genre.
 */
import type { Genre } from '../worldgen/genres';
import type { ClassTreeIntent, ClassesIntent, CoreIntent, GearIntent, RulesetIntent, SkillIntent } from './intent';

interface Theme {
  health: string;
  healthColor: string;
  pools: [string, string, 'physical' | 'magical'][];
  attrs: [string, string, string][]; // name, abbr, description
  types: [string, string, string][]; // name, color, mitigation
  subs: [string, string, string, string][]; // name, type index as string, color, status name
  statuses: { burn: string; poison: string; chill: string; shock: string; bleed: string; weak: string; expose: string; might: string; guard: string; mend: string; root: string; silence: string; disarm: string; slow: string };
  terms: CoreIntent['terminology'];
  rarities: string[];
  classes: [string, string, string, string, string][]; // name, description, then 3 branch names
  weapons: [string, GearIntent['weapons'][number]['style'], number][]; // name, style, type index
  armor: { heavy: string[]; medium: string[]; light: string[] };
  shield: string;
  focus: string;
  ring: string;
  amulet: string;
  potions: [string, string, string, string];
  materials: string[];
  valuables: string[];
  tools: [string, string, string];
  kins: [string, string][];
  ui: CoreIntent['ui'];
  rulesName: string;
  intro: string;
}

const FANTASY: Theme = {
  health: 'Health', healthColor: '#c8322a',
  pools: [['Stamina', '#d8a440', 'physical'], ['Mana', '#4a8ae0', 'magical']],
  attrs: [['Might', 'MIG', 'Raw strength for heavy blows and a sturdier body.'], ['Finesse', 'FIN', 'Precision, agility and a steady aim.'], ['Intellect', 'INT', 'Command over spells and their potency.'], ['Spirit', 'SPI', 'Inner calm that fuels healing and wards.'], ['Wits', 'WIT', 'Quick thinking: criticals, traps and locks.']],
  types: [['Physical', '#d8d0c0', 'Armor'], ['Magical', '#9a7aff', 'Ward']],
  subs: [['Fire', '1', '#ff7a2a', 'Burning'], ['Frost', '1', '#7fd4ff', 'Chilled'], ['Lightning', '1', '#c9a6ff', 'Shocked'], ['Poison', '0', '#7ccf3a', 'Poisoned'], ['Slashing', '0', '#d0c8b8', 'Bleeding'], ['Radiant', '1', '#ffe680', '']],
  statuses: { burn: 'Burning', poison: 'Poisoned', chill: 'Chilled', shock: 'Shocked', bleed: 'Bleeding', weak: 'Weakened', expose: 'Exposed', might: 'Empowered', guard: 'Fortified', mend: 'Regenerating', root: 'Rooted', silence: 'Silenced', disarm: 'Disarmed', slow: 'Slowed' },
  terms: { xp: 'Experience', level: 'Level', actionPoints: 'AP', currency: 'Gold', party: 'Party', town: 'Town', dungeon: 'Dungeon', wilderness: 'Wilds', quest: 'Quest' },
  rarities: ['Common', 'Fine', 'Rare', 'Epic', 'Legendary'],
  classes: [
    ['Warrior', 'A frontline fighter who protects allies and breaks enemy lines.', 'Bulwark', 'Weapon Master', 'Warlord'],
    ['Rogue', 'A quick blade who strikes from the shadows and bleeds foes dry.', 'Assassination', 'Trickery', 'Venoms'],
    ['Ranger', 'A patient hunter who rains arrows from afar.', 'Marksmanship', 'Survival', 'Beastlore'],
    ['Mage', 'A scholar of the elements who devastates groups of enemies.', 'Pyromancy', 'Cryomancy', 'Storms'],
    ['Cleric', 'A devoted healer who mends allies and smites the wicked.', 'Restoration', 'Judgement', 'Protection'],
  ],
  weapons: [['Sword', 'light_melee', 0], ['Greataxe', 'heavy_melee', 0], ['Dagger', 'quick_melee', 0], ['Longbow', 'ranged', 0], ['Staff', 'caster', 1], ['Mace', 'light_melee', 0]],
  armor: { heavy: ['Helm', 'Breastplate', 'Gauntlets', 'Greaves'], medium: ['Leather Cap', 'Brigandine', 'Bracers', 'Boots'], light: ['Hood', 'Robe', 'Gloves', 'Sandals'] },
  shield: 'Shield', focus: 'Tome', ring: 'Ring', amulet: 'Amulet',
  potions: ['Healing Potion', 'Tonic', 'Elixir of Might', 'Fire Flask'],
  materials: ['Iron Ore', 'Herbs', 'Arcane Dust'], valuables: ['Gem', 'Curio'],
  tools: ['Trap Kit', 'Lockpick', 'Recall Scroll'],
  kins: [['Human', 'Adaptable and ambitious.'], ['Elf', 'Graceful, long-lived and keen-eyed.'], ['Dwarf', 'Stout and stubborn as stone.']],
  ui: { material: 'parchment', ornament: 'filigree', tint: '#ffd8a0', mood: 'warm', typeface: 'engraved' },
  rulesName: 'The Old Ways', intro: 'Steel, sorcery and stubborn courage decide every fight. Rest is never far, but every battle is earned.',
};

const SCIFI: Theme = {
  ...FANTASY,
  health: 'Integrity', healthColor: '#e04848',
  pools: [['Energy', '#40c8e8', 'physical'], ['Focus', '#b070ff', 'magical']],
  attrs: [['Strength', 'STR', 'Muscle and servo power.'], ['Reflex', 'REF', 'Reaction time and aim.'], ['Tech', 'TEC', 'Mastery of devices and drones.'], ['Will', 'WIL', 'Mental resilience and psionic control.'], ['Cunning', 'CUN', 'Improvisation, critical hits, bypassing security.']],
  types: [['Kinetic', '#d8d8e0', 'Plating'], ['Energy', '#60c0ff', 'Shielding']],
  subs: [['Plasma', '1', '#ff6a2a', 'Melting'], ['Cryo', '1', '#8ae0ff', 'Frozen Joints'], ['Arc', '1', '#c0a0ff', 'Overloaded'], ['Toxin', '0', '#8ad040', 'Contaminated'], ['Ballistic', '0', '#d0c8b8', 'Ruptured'], ['Photon', '1', '#fff080', '']],
  statuses: { burn: 'Melting', poison: 'Contaminated', chill: 'Frozen Joints', shock: 'Overloaded', bleed: 'Ruptured', weak: 'Jammed', expose: 'Targeted', might: 'Overclocked', guard: 'Reinforced', mend: 'Nanorepair', root: 'Tethered', silence: 'Scrambled', disarm: 'Locked Out', slow: 'Lagging' },
  terms: { xp: 'Data', level: 'Clearance', actionPoints: 'AP', currency: 'Credits', party: 'Squad', town: 'Station', dungeon: 'Complex', wilderness: 'Wastes', quest: 'Contract' },
  rarities: ['Standard', 'Tuned', 'Prototype', 'Experimental', 'Relic'],
  classes: [
    ['Vanguard', 'Armored frontliner who holds the line with shields and shock tactics.', 'Bastion', 'Breacher', 'Command'],
    ['Infiltrator', 'Silent specialist with blades, cloaks and toxins.', 'Execution', 'Ghostwork', 'Chemicals'],
    ['Marksman', 'Precision shooter who controls the field from range.', 'Sniping', 'Fieldcraft', 'Drones'],
    ['Technomancer', 'Weaponizes energy fields and unstable tech.', 'Plasma', 'Cryo', 'Arc'],
    ['Medic', 'Keeps the squad alive with nanites and stims.', 'Triage', 'Countermeasures', 'Barriers'],
  ],
  weapons: [['Shock Baton', 'light_melee', 0], ['Breaching Hammer', 'heavy_melee', 0], ['Monoblade', 'quick_melee', 0], ['Rail Rifle', 'ranged', 0], ['Focus Gauntlet', 'caster', 1], ['Stun Mace', 'light_melee', 0]],
  armor: { heavy: ['Combat Helmet', 'Plate Rig', 'Power Gloves', 'Mag Boots'], medium: ['Visor', 'Flak Vest', 'Grip Gloves', 'Runners'], light: ['Hood', 'Undersuit', 'Wraps', 'Soft Boots'] },
  shield: 'Riot Shield', focus: 'Data Core', ring: 'Implant', amulet: 'Neural Chip',
  potions: ['Medkit', 'Energy Cell', 'Combat Stim', 'Plasma Grenade'],
  materials: ['Scrap Alloy', 'Bio-gel', 'Quantum Dust'], valuables: ['Data Shard', 'Old Tech'],
  tools: ['Disarm Kit', 'Bypass Tool', 'Beacon'],
  kins: [['Human', 'Versatile and stubborn survivors.'], ['Synthetic', 'Engineered bodies, tireless and precise.'], ['Colonist', 'Hardened by low gravity and thin air.']],
  ui: { material: 'glass', ornament: 'circuit', tint: '#a0e0ff', mood: 'cold', typeface: 'technical' },
  rulesName: 'Field Protocols', intro: 'Every engagement is a calculation: plating against plasma, shields against kinetic rounds. Patch up between fights; inside one, every action point counts.',
};

const HORROR: Theme = {
  ...FANTASY,
  health: 'Vitality', healthColor: '#a02020',
  pools: [['Nerve', '#c0a060', 'physical'], ['Sanity', '#7a6ad0', 'magical']],
  attrs: [['Brawn', 'BRN', 'Physical force and endurance.'], ['Nerve', 'NRV', 'Steady hands under pressure.'], ['Lore', 'LOR', 'Forbidden knowledge and its use.'], ['Resolve', 'RES', 'Faith and willpower against the dark.'], ['Instinct', 'INS', 'Gut feeling: traps, weak spots, hidden things.']],
  types: [['Flesh', '#c8b8a8', 'Toughness'], ['Occult', '#8a5ad0', 'Warding']],
  subs: [['Fire', '1', '#ff7a2a', 'Burning'], ['Rot', '0', '#7a9a40', 'Festering'], ['Dread', '1', '#9a6ad0', 'Terrified'], ['Cold', '1', '#9ad0e0', 'Numbed'], ['Bleeding', '0', '#a02030', 'Hemorrhaging'], ['Holy', '1', '#ffe8a0', '']],
  statuses: { burn: 'Burning', poison: 'Festering', chill: 'Numbed', shock: 'Terrified', bleed: 'Hemorrhaging', weak: 'Shaken', expose: 'Marked', might: 'Frenzied', guard: 'Steeled', mend: 'Recovering', root: 'Grasped', silence: 'Mute', disarm: 'Trembling Hands', slow: 'Dragging' },
  terms: { xp: 'Insight', level: 'Rank', actionPoints: 'AP', currency: 'Shillings', party: 'Company', town: 'Village', dungeon: 'Crypt', wilderness: 'Moors', quest: 'Errand' },
  rarities: ['Plain', 'Sturdy', 'Strange', 'Cursed', 'Unholy'],
  classes: [
    ['Warden', 'A grim protector who stands between the company and the dark.', 'Bulwark', 'Brutality', 'Vigil'],
    ['Cutthroat', 'A desperate killer with knives and dirty tricks.', 'Butchery', 'Misdirection', 'Toxins'],
    ['Hunter', 'Tracks monsters and shoots them before they get close.', 'Marksmanship', 'Traps', 'Quarry'],
    ['Occultist', 'Bargains with things that should not be named.', 'Hellfire', 'Rot', 'Dread'],
    ['Chaplain', 'Keeps faith and flesh together in the worst places.', 'Mercy', 'Smiting', 'Sanctuary'],
  ],
  weapons: [['Cleaver', 'light_melee', 0], ['Wood Axe', 'heavy_melee', 0], ['Knife', 'quick_melee', 0], ['Crossbow', 'ranged', 0], ['Ritual Rod', 'caster', 1], ['Cudgel', 'light_melee', 0]],
  potions: ['Laudanum', 'Smelling Salts', 'Bitter Tonic', 'Oil Firebomb'],
  materials: ['Grave Iron', 'Nightshade', 'Bone Dust'], valuables: ['Locket', 'Silver Coin'],
  tools: ['Trap Tongs', 'Skeleton Key', 'Lantern Charm'],
  kins: [['Villager', 'Ordinary folk hardened by hard times.'], ['Gentry', 'Educated, connected and secretly curious.'], ['Wanderer', 'No roots, many scars.']],
  ui: { material: 'paper', ornament: 'runes', tint: '#c0b090', mood: 'bleak', typeface: 'gothic' },
  rulesName: 'The Long Night', intro: 'Wounds close between ordeals, but the dark keeps coming. Fight smart: every blow and every prayer costs something.',
};

const COZY: Theme = {
  ...FANTASY,
  health: 'Spirits', healthColor: '#e0607a',
  pools: [['Pep', '#f0b040', 'physical'], ['Charm', '#a080f0', 'magical']],
  attrs: [['Grit', 'GRT', 'Stubbornness and sturdy legs.'], ['Knack', 'KNK', 'A light touch and a good eye.'], ['Whimsy', 'WHM', 'Imagination that bends the world a little.'], ['Heart', 'HRT', 'Kindness that mends and protects.'], ['Nous', 'NOU', 'Common sense: noticing, tinkering, haggling.']],
  types: [['Bump', '#e0d0b0', 'Padding'], ['Fancy', '#c090ff', 'Composure']],
  subs: [['Sizzle', '1', '#ff9a4a', 'Flustered'], ['Chill', '1', '#9ae0ff', 'Shivering'], ['Sparkle', '1', '#ffb0f0', 'Dazzled'], ['Sticky', '0', '#a0c050', 'Gooey'], ['Pokey', '0', '#d0b890', 'Ouchie'], ['Sunny', '1', '#fff0a0', '']],
  statuses: { burn: 'Flustered', poison: 'Gooey', chill: 'Shivering', shock: 'Dazzled', bleed: 'Ouchie', weak: 'Grumpy', expose: 'Ticklish', might: 'Pumped', guard: 'Cozy', mend: 'Snuggled', root: 'Stuck', silence: 'Tongue-tied', disarm: 'Butterfingers', slow: 'Sleepy-ish' },
  terms: { xp: 'Memories', level: 'Level', actionPoints: 'AP', currency: 'Buttons', party: 'Friends', town: 'Village', dungeon: 'Burrow', wilderness: 'Meadows', quest: 'Favor' },
  rarities: ['Ordinary', 'Nice', 'Lovely', 'Marvelous', 'Legendary'],
  classes: [
    ['Guardian', 'A big-hearted protector with a sturdy pot lid.', 'Hugs', 'Bonks', 'Courage'],
    ['Scamp', 'A quick little trickster with sticky fingers.', 'Pranks', 'Sneaking', 'Goo'],
    ['Slinger', 'Never misses with a slingshot and a smile.', 'Aim', 'Outdoors', 'Critters'],
    ['Wonderworker', 'Bakes, brews and conjures small miracles.', 'Sizzle', 'Chill', 'Sparkle'],
    ['Caretaker', 'Tea, bandages and gentle words for everyone.', 'Comfort', 'Scolding', 'Blankets'],
  ],
  weapons: [['Rolling Pin', 'light_melee', 0], ['Big Mallet', 'heavy_melee', 0], ['Hairpin', 'quick_melee', 0], ['Slingshot', 'ranged', 0], ['Wand', 'caster', 1], ['Ladle', 'light_melee', 0]],
  armor: { heavy: ['Pot Helmet', 'Quilted Coat', 'Oven Mitts', 'Galoshes'], medium: ['Knit Cap', 'Vest', 'Gloves', 'Boots'], light: ['Ribbon', 'Sweater', 'Mittens', 'Slippers'] },
  shield: 'Pot Lid', focus: 'Recipe Book', ring: 'Charm', amulet: 'Locket',
  potions: ['Warm Tea', 'Honey Drop', 'Fizzy Pop', 'Pepper Bomb'],
  materials: ['Thread', 'Berries', 'Glitter'], valuables: ['Pretty Stone', 'Old Button'],
  tools: ['Tweezers', 'Hairpin Pick', 'Homeward Whistle'],
  kins: [['Mouse', 'Small, brave and quick.'], ['Badger', 'Sturdy and steady.'], ['Hare', 'Fast and full of ideas.']],
  ui: { material: 'paper', ornament: 'vines', tint: '#ffe0c0', mood: 'warm', typeface: 'storybook' },
  rulesName: 'The Gentle Rules', intro: 'Squabbles are settled with bonks, sparkles and stubbornness. Everyone feels better after a short sit-down.',
};

const MODERN: Theme = {
  ...SCIFI,
  health: 'Health', healthColor: '#d03a3a',
  pools: [['Stamina', '#e0a040', 'physical'], ['Focus', '#6aa0f0', 'magical']],
  attrs: [['Fitness', 'FIT', 'Strength and endurance.'], ['Agility', 'AGI', 'Speed and aim.'], ['Smarts', 'SMT', 'Know-how with gadgets and chemistry.'], ['Composure', 'CMP', 'Calm under fire.'], ['Street Sense', 'STS', 'Spotting trouble, picking locks, haggling.']],
  types: [['Physical', '#d8d0c0', 'Protection'], ['Exotic', '#a0a0ff', 'Grounding']],
  subs: [['Fire', '1', '#ff7a2a', 'Burning'], ['Chemical', '0', '#90d040', 'Choking'], ['Electric', '1', '#c0b0ff', 'Tased'], ['Cold', '1', '#a0e0ff', 'Frostbitten'], ['Cutting', '0', '#d0c0b0', 'Bleeding'], ['Sonic', '1', '#fff0a0', '']],
  statuses: { burn: 'Burning', poison: 'Choking', chill: 'Frostbitten', shock: 'Tased', bleed: 'Bleeding', weak: 'Winded', expose: 'Exposed', might: 'Adrenaline', guard: 'Braced', mend: 'Patched Up', root: 'Pinned', silence: 'Jammed', disarm: 'Disarmed', slow: 'Dazed' },
  terms: { xp: 'Experience', level: 'Level', actionPoints: 'AP', currency: 'Dollars', party: 'Crew', town: 'Neighborhood', dungeon: 'Facility', wilderness: 'Outskirts', quest: 'Job' },
  rarities: ['Basic', 'Good', 'Pro', 'Custom', 'Legendary'],
  classes: [
    ['Bruiser', 'Takes hits for the crew and dishes them back.', 'Toughness', 'Brawling', 'Leadership'],
    ['Fixer', 'Knives, tricks and dirty fighting.', 'Takedowns', 'Hustle', 'Chemistry'],
    ['Sharpshooter', 'Calm hands and a long sightline.', 'Precision', 'Recon', 'Gadgets'],
    ['Specialist', 'Turns improvised tech into weapons.', 'Incendiary', 'Cryogenics', 'Electronics'],
    ['Paramedic', 'Keeps everyone breathing.', 'Trauma Care', 'Suppression', 'Cover'],
  ],
  weapons: [['Bat', 'light_melee', 0], ['Sledgehammer', 'heavy_melee', 0], ['Switchblade', 'quick_melee', 0], ['Rifle', 'ranged', 0], ['Taser Rig', 'caster', 1], ['Crowbar', 'light_melee', 0]],
  potions: ['First Aid Kit', 'Energy Drink', 'Adrenaline Shot', 'Molotov'],
  materials: ['Scrap Metal', 'Chemicals', 'Circuits'], valuables: ['Watch', 'Jewelry'],
  tools: ['Wire Cutters', 'Lock Picks', 'Taxi Card'],
  kins: [['Local', 'Knows the streets.'], ['Ex-Military', 'Disciplined and tough.'], ['Academic', 'Clever and curious.']],
  ui: { material: 'metal', ornament: 'rivets', tint: '#d0d8e0', mood: 'muted', typeface: 'modern' },
  rulesName: 'Street Rules', intro: 'No magic shields here — just training, gear and nerve. Patch up after every scrap.',
};

const WHIMSY: Theme = { ...COZY, ui: { material: 'organic', ornament: 'vines', tint: '#f0d0ff', mood: 'vivid', typeface: 'storybook' }, rulesName: 'The Topsy Rules' };

export const THEMES: Record<Genre, Theme> = { fantasy: FANTASY, scifi: SCIFI, horror: HORROR, cozy: COZY, modern: MODERN, whimsy: WHIMSY };

// ------------------------------------------------------------------------------------ builders

export function defaultCore(genre: Genre): CoreIntent {
  const t = THEMES[genre];
  const [might, finesse, intellect, spirit, wits] = t.attrs.map((a) => a[0]);
  const [phys, mag] = t.types.map((x) => x[0]);
  const pool0 = t.pools[0]?.[0], pool1 = t.pools[1]?.[0];
  const sub = (i: number) => t.subs[i]![0];
  return {
    name: t.rulesName,
    intro: t.intro,
    numbers: genre === 'cozy' || genre === 'whimsy' ? 'small' : genre === 'scifi' ? 'large' : 'medium',
    health: { name: t.health, color: t.healthColor },
    terminology: t.terms,
    pools: t.pools.map(([name, color, use]) => ({ name, color, use, description: use === 'physical' ? 'Spent by martial techniques.' : 'Spent by spells and special abilities.' })),
    attributes: [
      { name: might!, abbr: t.attrs[0]![1], description: t.attrs[0]![2], effects: [{ effect: 'melee_damage', weight: 3 }, { effect: 'health', weight: 2 }] },
      { name: finesse!, abbr: t.attrs[1]![1], description: t.attrs[1]![2], effects: [{ effect: 'ranged_damage', weight: 3 }, { effect: 'dodge', weight: 1 }, { effect: 'initiative', weight: 1 }] },
      { name: intellect!, abbr: t.attrs[2]![1], description: t.attrs[2]![2], effects: [{ effect: 'skill_damage', weight: 3 }, ...(pool1 ? [{ effect: 'pool' as const, of: pool1, weight: 1 }] : [])] },
      { name: spirit!, abbr: t.attrs[3]![1], description: t.attrs[3]![2], effects: [{ effect: 'healing', weight: 2 }, { effect: 'mitigation', of: mag, weight: 1 }, { effect: 'health_regen', weight: 1 }] },
      { name: wits!, abbr: t.attrs[4]![1], description: t.attrs[4]![2], effects: [{ effect: 'crit_chance', weight: 3 }, { effect: 'trap_sense', weight: 1 }, { effect: 'lockpicking', weight: 1 }] },
    ],
    damageTypes: t.types.map(([name, color, mitigationName]) => ({ name, color, mitigationName, description: name === phys ? 'Blows, blades and projectiles.' : 'Elemental and supernatural forces.' })),
    subtypes: t.subs.map(([name, type, color, status]) => ({ name, type: t.types[Number(type)]![0], color, status: status || undefined })),
    statuses: [
      { name: t.statuses.burn, color: '#ff7a2a', description: 'Takes damage each turn.', kind: 'damage_over_time', subtype: sub(0) },
      { name: t.statuses.poison, color: '#7ccf3a', description: 'Takes damage each turn and deals less damage.', kind: 'damage_over_time', subtype: sub(3), stats: [{ effect: 'all_damage', direction: 'down' }] },
      { name: t.statuses.bleed, color: '#c03040', description: 'Loses health each turn.', kind: 'damage_over_time', subtype: sub(4) },
      { name: t.statuses.chill, color: '#9fe0ff', description: 'Moves at half speed.', kind: 'debuff', stats: [{ effect: 'movement', direction: 'down' }] },
      { name: t.statuses.shock, color: '#c9a6ff', description: 'Loses an action point each turn.', kind: 'control', control: 'slow' },
      { name: t.statuses.weak, color: '#a08060', description: 'Deals less damage.', kind: 'debuff', stats: [{ effect: 'all_damage', direction: 'down' }] },
      { name: t.statuses.expose, color: '#e070d0', description: 'Takes more damage.', kind: 'debuff', stats: [{ effect: 'mitigation', of: phys, direction: 'down' }, { effect: 'mitigation', of: mag, direction: 'down' }] },
      { name: t.statuses.might, color: '#ff9060', description: 'Deals more damage.', kind: 'buff', stats: [{ effect: 'all_damage', direction: 'up' }] },
      { name: t.statuses.guard, color: '#c0c0d0', description: 'Takes less damage.', kind: 'buff', stats: [{ effect: 'mitigation', of: phys, direction: 'up' }, { effect: 'mitigation', of: mag, direction: 'up' }] },
      { name: t.statuses.mend, color: '#60e090', description: 'Recovers health each turn.', kind: 'heal_over_time' },
      { name: t.statuses.root, color: '#90a060', description: 'Cannot move.', kind: 'control', control: 'root' },
      { name: t.statuses.silence, color: '#8090c0', description: 'Cannot use skills, only weapon attacks.', kind: 'control', control: 'silence' },
    ],
    slots: [
      { name: 'Weapon', kind: 'weapon' }, { name: 'Off-hand', kind: 'offhand' }, { name: 'Head', kind: 'armor' }, { name: 'Body', kind: 'armor' },
      { name: 'Hands', kind: 'armor' }, { name: 'Feet', kind: 'armor' }, { name: t.ring, kind: 'accessory' }, { name: t.amulet, kind: 'accessory' },
    ],
    rarities: t.rarities,
    traps: [{ name: 'Spike Trap', subtype: sub(4), status: t.statuses.bleed }, { name: `${sub(0)} Trap`, subtype: sub(0), status: t.statuses.burn }, { name: `${sub(3)} Trap`, subtype: sub(3), status: t.statuses.poison }, { name: `${sub(2)} Trap`, subtype: sub(2), status: t.statuses.shock }],
    systems: { traps: true, locks: true, surfaces: true, crafting: true, upgrades: true, enchanting: true, buffPotions: true, damagePotions: true, control: true },
    rules: { crit: true, dodge: true, variance: 'medium', revive: 'special' },
    inventory: { slots: 40, upgrades: 4 },
    ui: t.ui,
  };
  void pool0;
}

export function defaultGear(genre: Genre): GearIntent {
  const t = THEMES[genre];
  const slotNames = ['Head', 'Body', 'Hands', 'Feet'];
  const armor: GearIntent['armor'] = [];
  for (const w of ['heavy', 'medium', 'light'] as const) t.armor[w].forEach((name, i) => armor.push({ name, slot: slotNames[i]!, weight: w, description: `${w === 'heavy' ? 'Heavy' : w === 'medium' ? 'Sturdy' : 'Light'} protection.` }));
  return {
    weapons: t.weapons.map(([name, style, type]) => ({ name, style, damageType: t.types[type]?.[0] ?? t.types[0]![0], description: style === 'caster' ? 'Channels skill power.' : style === 'ranged' ? 'Strikes from afar.' : 'A dependable weapon.' })),
    armor,
    offhands: [{ name: t.shield, style: 'shield', description: 'Blocks blows.' }, { name: t.focus, style: 'focus', description: 'Sharpens the mind.' }],
    accessories: [{ name: t.ring, slot: t.ring, description: 'Small but potent.' }, { name: t.amulet, slot: t.amulet, description: 'Worn close to the heart.' }],
    potions: [
      { name: t.potions[0], description: `Restores ${t.health}.`, effect: 'heal' },
      { name: t.potions[1], description: 'Restores your reserves.', effect: 'restore', of: t.pools[0]?.[0] },
      { name: t.potions[2], description: 'A burst of strength.', effect: 'buff', of: t.statuses.might },
      { name: t.potions[3], description: 'Throw it at enemies.', effect: 'damage', of: t.subs[0]![0] },
      { name: 'Antidote', description: 'Cures harmful effects.', effect: 'cleanse' },
    ],
    materials: t.materials.map((name, i) => ({ name, description: 'Useful for crafting.', tier: i + 1 })),
    valuables: t.valuables.map((name) => ({ name })),
    tools: { disarm: t.tools[0], unlock: t.tools[1], recall: t.tools[2] },
    affixNames: [],
    kins: t.kins.map(([name, description], i) => ({ name, description, attributes: [{ attribute: t.attrs[i % t.attrs.length]![0], points: 2 }], perk: i === 0 ? { effect: 'barter', weight: 2 } : i === 1 ? { effect: 'dodge', weight: 2 } : { effect: 'health', weight: 2 } })),
  };
}

export function defaultClasses(genre: Genre): ClassesIntent {
  const t = THEMES[genre];
  const a = t.attrs.map((x) => x[0]);
  const w = t.weapons.map((x) => x[0]);
  const p0 = t.pools[0]?.[0], p1 = t.pools[1]?.[0];
  const spec: [ClassesIntent['classes'][number]['role'], string[], string | undefined, string, 'heavy' | 'medium' | 'light', string | undefined][] = [
    ['tank', [a[0]!, a[3]!], p0, w[0]!, 'heavy', t.shield],
    ['melee', [a[1]!, a[4]!], p0, w[2]!, 'medium', undefined],
    ['ranged', [a[1]!, a[4]!], p0, w[3]!, 'medium', undefined],
    ['caster', [a[2]!], p1, w[4]!, 'light', t.focus],
    ['support', [a[3]!, a[0]!], p1, w[5]!, 'heavy', t.shield],
  ];
  return {
    classes: t.classes.map(([name, description, b0, b1, b2], i) => ({
      name, description, role: spec[i]![0], primaryAttributes: spec[i]![1], pool: spec[i]![2], weapon: spec[i]![3], armor: spec[i]![4], offhand: spec[i]![5],
      appearance: `${name}: ${description.replace(/\.$/, '')}, in ${spec[i]![4]} gear with a ${spec[i]![3].toLowerCase()}`,
      branches: [{ name: b0, theme: `${b0} techniques` }, { name: b1, theme: `${b1} techniques` }, { name: b2, theme: `${b2} techniques` }],
    })),
  };
}

const S = (s: SkillIntent) => s;

/** Default trees per class role, themed with the genre's subtype and status names. */
export function defaultTree(genre: Genre, role: ClassesIntent['classes'][number]['role'], className: string): ClassTreeIntent {
  const t = THEMES[genre];
  const st = t.statuses;
  const sub = (i: number) => t.subs[i]![0];
  const p = (name: string) => `${name}`;
  void className;
  switch (role) {
    case 'tank':
      return {
        skills: [
          S({ name: 'Heavy Blow', description: 'A crushing strike.', branch: 1, tier: 0, targeting: 'enemy', range: 'weapon', area: 'none', ap: 2, cooldown: 'short', cost: 'low', usesWeapon: true, effects: [{ kind: 'damage', weight: 4 }, { kind: 'status', of: st.weak, weight: 1 }], fx: 'slash' }),
          S({ name: 'Shield Up', description: 'Brace behind your guard.', branch: 0, tier: 0, targeting: 'self', range: 'melee', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'barrier', weight: 3 }, { kind: 'status', of: st.guard, weight: 2, self: true }], fx: 'buff' }),
          S({ name: 'Cleave', description: 'Sweep through every foe around you.', branch: 1, tier: 1, targeting: 'self', range: 'melee', area: 'small', ap: 2, cooldown: 'short', cost: 'medium', usesWeapon: true, effects: [{ kind: 'damage', weight: 5 }], fx: 'nova' }),
          S({ name: 'Charge', description: 'Rush an enemy and strike.', branch: 2, tier: 1, targeting: 'enemy', range: 'short', area: 'none', ap: 2, cooldown: 'long', cost: 'medium', usesWeapon: true, effects: [{ kind: 'dash', weight: 2 }, { kind: 'damage', weight: 3 }], fx: 'slash' }),
          S({ name: 'Rallying Shout', description: 'Allies nearby fight harder.', branch: 2, tier: 2, targeting: 'self', range: 'melee', area: 'large', ap: 1, cooldown: 'long', cost: 'medium', usesWeapon: false, effects: [{ kind: 'status', of: st.might, weight: 4 }], fx: 'buff' }),
          S({ name: 'Pin Down', description: 'Hook an enemy so it cannot move.', branch: 0, tier: 2, targeting: 'enemy', range: 'weapon', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: true, effects: [{ kind: 'damage', weight: 2 }, { kind: 'status', of: st.root, weight: 3 }], fx: 'slash' }),
          S({ name: 'Shockwave', description: 'Slam the ground and stagger enemies.', branch: 1, tier: 3, targeting: 'self', range: 'melee', area: 'large', ap: 3, cooldown: 'long', cost: 'high', usesWeapon: true, effects: [{ kind: 'damage', weight: 4 }, { kind: 'push', weight: 1 }], fx: 'nova' }),
          S({ name: 'Last Stand', description: 'Shield every ally nearby.', branch: 0, tier: 3, targeting: 'self', range: 'melee', area: 'large', ap: 2, cooldown: 'long', cost: 'high', usesWeapon: false, effects: [{ kind: 'barrier', weight: 5 }], fx: 'buff' }),
        ],
        passives: [
          { name: 'Thick Skin', description: 'More health.', branch: 0, tier: 0, capstone: false, effects: [{ effect: 'health', weight: 3 }] },
          { name: 'Iron Hide', description: 'Better protection.', branch: 0, tier: 1, capstone: false, effects: [{ effect: 'mitigation', of: t.types[0]![0], weight: 3 }] },
          { name: 'Brutality', description: 'Hit harder in melee.', branch: 1, tier: 0, capstone: false, effects: [{ effect: 'melee_damage', weight: 3 }] },
          { name: 'Thorned Guard', description: 'Attackers get hurt.', branch: 2, tier: 0, capstone: false, effects: [{ effect: 'thorns', weight: 2 }, { effect: 'health', weight: 1 }] },
          { name: 'Unbreakable', description: 'A wall of a warrior.', branch: 0, tier: 3, capstone: true, effects: [{ effect: 'health', weight: 2 }, { effect: 'resist_all', weight: 2 }] },
          { name: 'Battle Hunger', description: 'Recover in the thick of it.', branch: 2, tier: 2, capstone: false, effects: [{ effect: 'health_regen', weight: 3 }] },
        ],
      };
    case 'melee':
      return {
        skills: [
          S({ name: 'Backstab', description: 'A precise strike at a weak spot.', branch: 0, tier: 0, targeting: 'enemy', range: 'melee', area: 'none', ap: 2, cooldown: 'short', cost: 'low', usesWeapon: true, effects: [{ kind: 'damage', weight: 5 }], fx: 'shadow' }),
          S({ name: 'Rend', description: 'Open a bleeding wound.', branch: 2, tier: 0, targeting: 'enemy', range: 'melee', area: 'none', ap: 1, cooldown: 'none', cost: 'low', usesWeapon: true, effects: [{ kind: 'damage', weight: 2 }, { kind: 'status', of: st.bleed, weight: 3 }], fx: 'slash' }),
          S({ name: 'Shadowstep', description: 'Vanish and reappear nearby.', branch: 1, tier: 1, targeting: 'ground', range: 'short', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'teleport', weight: 3 }], fx: 'shadow' }),
          S({ name: 'Toxic Blade', description: 'Coat your blade in poison.', branch: 2, tier: 1, targeting: 'enemy', range: 'melee', area: 'none', ap: 2, cooldown: 'short', cost: 'medium', usesWeapon: true, effects: [{ kind: 'damage', weight: 2 }, { kind: 'status', of: st.poison, weight: 3 }], fx: 'slash' }),
          S({ name: 'Flurry', description: 'A storm of quick cuts.', branch: 0, tier: 2, targeting: 'enemy', range: 'melee', area: 'none', ap: 3, cooldown: 'short', cost: 'medium', usesWeapon: true, effects: [{ kind: 'damage', weight: 5 }], fx: 'slash' }),
          S({ name: 'Smoke Bomb', description: 'Blind and confuse those around you.', branch: 1, tier: 2, targeting: 'self', range: 'melee', area: 'small', ap: 1, cooldown: 'long', cost: 'medium', usesWeapon: false, effects: [{ kind: 'status', of: st.silence, weight: 2 }, { kind: 'status', of: st.weak, weight: 2 }], fx: 'cloud' }),
          S({ name: 'Execute', description: 'End a weakened foe.', branch: 0, tier: 3, targeting: 'enemy', range: 'melee', area: 'none', ap: 2, cooldown: 'long', cost: 'high', usesWeapon: true, effects: [{ kind: 'damage', weight: 5 }], fx: 'shadow' }),
          S({ name: 'Venom Cloud', description: 'A choking cloud of poison.', branch: 2, tier: 3, targeting: 'ground', range: 'short', area: 'large', ap: 2, cooldown: 'long', cost: 'high', usesWeapon: false, effects: [{ kind: 'damage', of: sub(3), weight: 2 }, { kind: 'status', of: st.poison, weight: 3 }], fx: 'cloud' }),
        ],
        passives: [
          { name: 'Keen Edge', description: 'Find the weak spot.', branch: 0, tier: 0, capstone: false, effects: [{ effect: 'crit_chance', weight: 3 }] },
          { name: 'Nimble', description: 'Hard to hit.', branch: 1, tier: 0, capstone: false, effects: [{ effect: 'dodge', weight: 3 }] },
          { name: 'Fleet Foot', description: 'Move faster.', branch: 1, tier: 1, capstone: false, effects: [{ effect: 'movement', weight: 3 }] },
          { name: 'Potent Venoms', description: 'Poisons hurt more.', branch: 2, tier: 2, capstone: false, effects: [{ effect: 'subtype_damage', of: sub(3), weight: 3 }] },
          { name: 'Deadly', description: 'Criticals devastate.', branch: 0, tier: 3, capstone: true, effects: [{ effect: 'crit_damage', weight: 3 }, { effect: 'melee_damage', weight: 2 }] },
          { name: 'Light Fingers', description: 'Locks and traps are no trouble.', branch: 1, tier: 2, capstone: false, effects: [{ effect: 'lockpicking', weight: 2 }, { effect: 'trap_sense', weight: 2 }] },
        ],
      };
    case 'ranged':
      return {
        skills: [
          S({ name: 'Aimed Shot', description: 'Take careful aim.', branch: 0, tier: 0, targeting: 'enemy', range: 'weapon', area: 'none', ap: 2, cooldown: 'short', cost: 'low', usesWeapon: true, effects: [{ kind: 'damage', weight: 5 }], fx: 'arrow' }),
          S({ name: 'Crippling Shot', description: 'Shoot the legs out from under them.', branch: 1, tier: 0, targeting: 'enemy', range: 'weapon', area: 'none', ap: 2, cooldown: 'short', cost: 'low', usesWeapon: true, effects: [{ kind: 'damage', weight: 2 }, { kind: 'status', of: st.chill, weight: 3 }], fx: 'arrow' }),
          S({ name: 'Volley', description: 'Rain shots on an area.', branch: 0, tier: 1, targeting: 'ground', range: 'long', area: 'small', ap: 2, cooldown: 'short', cost: 'medium', usesWeapon: true, effects: [{ kind: 'damage', weight: 5 }], fx: 'arrow' }),
          S({ name: 'Tactical Leap', description: 'Jump to a better position.', branch: 1, tier: 1, targeting: 'ground', range: 'short', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'teleport', weight: 3 }], fx: 'shadow' }),
          S({ name: 'Snare', description: 'Tangle an enemy where it stands.', branch: 2, tier: 1, targeting: 'enemy', range: 'long', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'status', of: st.root, weight: 4 }], fx: 'debuff' }),
          S({ name: 'Mark Prey', description: 'Expose an enemy to your allies.', branch: 2, tier: 2, targeting: 'enemy', range: 'long', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'status', of: st.expose, weight: 4 }], fx: 'debuff' }),
          S({ name: 'Piercing Shot', description: 'A shot that passes through ranks.', branch: 0, tier: 3, targeting: 'enemy', range: 'weapon', area: 'none', ap: 3, cooldown: 'long', cost: 'high', usesWeapon: true, effects: [{ kind: 'damage', weight: 4 }, { kind: 'chain', weight: 2 }], fx: 'arrow' }),
          S({ name: 'Field Dressing', description: 'Quick first aid.', branch: 1, tier: 2, targeting: 'ally', range: 'short', area: 'none', ap: 1, cooldown: 'long', cost: 'medium', usesWeapon: false, effects: [{ kind: 'heal', weight: 4 }], fx: 'heal' }),
        ],
        passives: [
          { name: 'Steady Hands', description: 'Better shots.', branch: 0, tier: 0, capstone: false, effects: [{ effect: 'ranged_damage', weight: 3 }] },
          { name: 'Eagle Eye', description: 'Find the gaps.', branch: 0, tier: 2, capstone: false, effects: [{ effect: 'crit_chance', weight: 3 }] },
          { name: 'Woodcraft', description: 'Spot traps from far away.', branch: 1, tier: 0, capstone: false, effects: [{ effect: 'trap_sense', weight: 3 }, { effect: 'movement', weight: 1 }] },
          { name: 'Hunter\'s Instinct', description: 'Act first.', branch: 2, tier: 0, capstone: false, effects: [{ effect: 'initiative', weight: 2 }, { effect: 'dodge', weight: 2 }] },
          { name: 'Deadeye', description: 'Every shot counts.', branch: 0, tier: 3, capstone: true, effects: [{ effect: 'ranged_damage', weight: 3 }, { effect: 'crit_damage', weight: 2 }] },
        ],
      };
    case 'caster':
      return {
        skills: [
          S({ name: `${sub(0)} Bolt`, description: `Hurl a bolt of ${sub(0).toLowerCase()}.`, branch: 0, tier: 0, targeting: 'enemy', range: 'long', area: 'none', ap: 2, cooldown: 'none', cost: 'low', usesWeapon: false, effects: [{ kind: 'damage', of: sub(0), weight: 4 }, { kind: 'status', of: st.burn, weight: 1 }], fx: 'bolt' }),
          S({ name: `${sub(1)} Lance`, description: 'A piercing shard that slows.', branch: 1, tier: 0, targeting: 'enemy', range: 'long', area: 'none', ap: 2, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'damage', of: sub(1), weight: 3 }, { kind: 'status', of: st.chill, weight: 2 }], fx: 'bolt' }),
          S({ name: `${sub(2)} Arc`, description: 'Energy leaps between enemies.', branch: 2, tier: 1, targeting: 'enemy', range: 'long', area: 'none', ap: 2, cooldown: 'short', cost: 'medium', usesWeapon: false, effects: [{ kind: 'damage', of: sub(2), weight: 3 }, { kind: 'chain', weight: 2 }], fx: 'beam' }),
          S({ name: `${sub(0)} Burst`, description: 'An explosion that leaves the ground aflame.', branch: 0, tier: 2, targeting: 'ground', range: 'long', area: 'small', ap: 3, cooldown: 'long', cost: 'high', usesWeapon: false, effects: [{ kind: 'damage', of: sub(0), weight: 4 }, { kind: 'surface', of: sub(0), weight: 1 }], fx: 'bolt' }),
          S({ name: `${sub(1)} Nova`, description: 'A freezing blast around you.', branch: 1, tier: 2, targeting: 'self', range: 'melee', area: 'small', ap: 2, cooldown: 'long', cost: 'medium', usesWeapon: false, effects: [{ kind: 'damage', of: sub(1), weight: 2 }, { kind: 'status', of: st.root, weight: 3 }], fx: 'nova' }),
          S({ name: 'Blink', description: 'Step through space.', branch: 2, tier: 1, targeting: 'ground', range: 'short', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'teleport', weight: 3 }], fx: 'beam' }),
          S({ name: 'Storm', description: 'A tempest that shocks a whole area.', branch: 2, tier: 3, targeting: 'ground', range: 'long', area: 'large', ap: 3, cooldown: 'long', cost: 'high', usesWeapon: false, effects: [{ kind: 'damage', of: sub(2), weight: 4 }, { kind: 'status', of: st.shock, weight: 1 }], fx: 'cloud' }),
          S({ name: 'Mana Shield', description: 'Wrap yourself in protective force.', branch: 1, tier: 3, targeting: 'self', range: 'melee', area: 'none', ap: 1, cooldown: 'long', cost: 'medium', usesWeapon: false, effects: [{ kind: 'barrier', weight: 4 }], fx: 'buff' }),
        ],
        passives: [
          { name: 'Arcane Study', description: 'Stronger spells.', branch: 0, tier: 0, capstone: false, effects: [{ effect: 'skill_damage', weight: 3 }] },
          { name: 'Deep Reserves', description: 'More to spend.', branch: 1, tier: 0, capstone: false, effects: [{ effect: 'pool', of: p(t.pools[1]?.[0] ?? t.pools[0]?.[0] ?? ''), weight: 2 }, { effect: 'pool_regen', of: p(t.pools[1]?.[0] ?? t.pools[0]?.[0] ?? ''), weight: 1 }] },
          { name: `${sub(0)} Affinity`, description: `${sub(0)} burns hotter.`, branch: 0, tier: 1, capstone: false, effects: [{ effect: 'subtype_damage', of: sub(0), weight: 3 }] },
          { name: `${sub(2)} Affinity`, description: `${sub(2)} strikes harder.`, branch: 2, tier: 2, capstone: false, effects: [{ effect: 'subtype_damage', of: sub(2), weight: 3 }] },
          { name: 'Archmage', description: 'Mastery of the art.', branch: 0, tier: 3, capstone: true, effects: [{ effect: 'skill_damage', weight: 3 }, { effect: 'crit_chance', weight: 2 }] },
        ],
      };
    default:
      return {
        skills: [
          S({ name: 'Mend', description: 'Heal an ally.', branch: 0, tier: 0, targeting: 'ally', range: 'long', area: 'none', ap: 1, cooldown: 'none', cost: 'low', usesWeapon: false, effects: [{ kind: 'heal', weight: 5 }], fx: 'heal' }),
          S({ name: 'Smite', description: 'Strike with radiant force.', branch: 1, tier: 0, targeting: 'enemy', range: 'long', area: 'none', ap: 2, cooldown: 'none', cost: 'low', usesWeapon: false, effects: [{ kind: 'damage', of: sub(5), weight: 5 }], fx: 'beam' }),
          S({ name: 'Renewal', description: 'Healing over time.', branch: 0, tier: 1, targeting: 'ally', range: 'long', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'status', of: st.mend, weight: 4 }], fx: 'heal' }),
          S({ name: 'Ward', description: 'Shield an ally.', branch: 2, tier: 0, targeting: 'ally', range: 'long', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'barrier', weight: 4 }], fx: 'buff' }),
          S({ name: 'Purify', description: 'Cleanse harmful effects.', branch: 2, tier: 1, targeting: 'ally', range: 'long', area: 'none', ap: 1, cooldown: 'short', cost: 'low', usesWeapon: false, effects: [{ kind: 'cleanse', weight: 2 }, { kind: 'heal', weight: 2 }], fx: 'heal' }),
          S({ name: 'Mending Wave', description: 'Heal every ally in an area.', branch: 0, tier: 2, targeting: 'ground', range: 'long', area: 'large', ap: 2, cooldown: 'long', cost: 'high', usesWeapon: false, effects: [{ kind: 'heal', weight: 5 }], fx: 'heal' }),
          S({ name: 'Judgement', description: 'Radiance that weakens the wicked.', branch: 1, tier: 2, targeting: 'enemy', range: 'long', area: 'small', ap: 2, cooldown: 'short', cost: 'medium', usesWeapon: false, effects: [{ kind: 'damage', of: sub(5), weight: 3 }, { kind: 'status', of: st.weak, weight: 2 }], fx: 'nova' }),
          S({ name: 'Revive', description: 'Bring a fallen ally back.', branch: 0, tier: 3, targeting: 'ally', range: 'short', area: 'none', ap: 3, cooldown: 'long', cost: 'high', usesWeapon: false, effects: [{ kind: 'revive', weight: 5 }], fx: 'heal' }),
          S({ name: 'Sanctuary', description: 'Hallowed ground that fortifies allies.', branch: 2, tier: 3, targeting: 'ground', range: 'short', area: 'large', ap: 2, cooldown: 'long', cost: 'high', usesWeapon: false, effects: [{ kind: 'status', of: st.guard, weight: 3 }, { kind: 'heal', weight: 2 }], fx: 'heal' }),
        ],
        passives: [
          { name: 'Devotion', description: 'Stronger healing.', branch: 0, tier: 0, capstone: false, effects: [{ effect: 'healing', weight: 3 }] },
          { name: 'Zeal', description: 'Stronger smiting.', branch: 1, tier: 0, capstone: false, effects: [{ effect: 'skill_damage', weight: 3 }] },
          { name: 'Faithful', description: 'Hardier in body and soul.', branch: 2, tier: 0, capstone: false, effects: [{ effect: 'health', weight: 2 }, { effect: 'mitigation', of: t.types[1]?.[0] ?? t.types[0]![0], weight: 2 }] },
          { name: 'Wellspring', description: 'Restore reserves faster.', branch: 0, tier: 1, capstone: false, effects: [{ effect: 'pool_regen', of: t.pools[1]?.[0] ?? t.pools[0]?.[0] ?? '', weight: 3 }] },
          { name: 'Saint', description: 'A beacon to allies.', branch: 0, tier: 3, capstone: true, effects: [{ effect: 'healing', weight: 3 }, { effect: 'resist_all', weight: 2 }] },
        ],
      };
  }
}

export function defaultIntent(genre: Genre): RulesetIntent {
  const classes = defaultClasses(genre);
  return { core: defaultCore(genre), gear: defaultGear(genre), classes, trees: classes.classes.map((c) => defaultTree(genre, c.role, c.name)) };
}
