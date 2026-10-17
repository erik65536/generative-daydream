/**
 * Procedural content banks. Used when a purpose is configured as 'procedural' and as a per-field
 * fallback whenever a model's output is missing or invalid. Genre is guessed from the user's prompt.
 */
import type { MonsterArchetype, TilesetDef } from '@gd/shared';

export type Genre = 'fantasy' | 'scifi' | 'cozy' | 'modern' | 'horror' | 'whimsy';

const KEYWORDS: Record<Genre, string[]> = {
  scifi: ['space', 'star', 'planet', 'galaxy', 'robot', 'cyber', 'android', 'alien', 'ship', 'laser', 'future', 'mech', 'colony', 'orbital', 'sci-fi', 'scifi'],
  cozy: ['cozy', 'animal', 'bunny', 'rabbit', 'fox', 'badger', 'mouse', 'children', 'kids', 'gentle', 'cute', 'meadow', 'tea', 'woodland'],
  modern: ['office', 'printer', 'city', 'corporate', 'cubicle', 'mall', 'suburb', 'modern', 'present day', 'real world', 'coffee', 'commute', 'comedy'],
  horror: ['horror', 'eldritch', 'cosmic', 'nightmare', 'haunted', 'zombie', 'undead', 'sanity', 'dread', 'cult', 'lovecraft', 'gothic'],
  whimsy: ['wonderland', 'insane', 'dream', 'absurd', 'puzzle', 'mad', 'surreal', 'candy', 'clockwork', 'topsy'],
  fantasy: ['dragon', 'magic', 'kingdom', 'sword', 'elf', 'dwarf', 'wizard', 'fantasy', 'd&d', 'dungeon', 'knight', 'orc'],
};

export function detectGenre(text: string): Genre {
  const t = text.toLowerCase();
  let best: Genre = 'fantasy';
  let bestScore = 0;
  for (const [g, words] of Object.entries(KEYWORDS) as [Genre, string[]][]) {
    const score = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = g;
      bestScore = score;
    }
  }
  return best;
}

export interface FamilyTemplate {
  name: string;
  description: string;
  /** Damage kind name; matched against the world's ruleset. */
  element: string;
  habitat: string;
  colors: string[];
  members: Partial<Record<MonsterArchetype, string>>;
}

export interface GenreBank {
  title: [string[], string[]];
  tone: string;
  artStyle: string;
  playerRole: string;
  /** Legacy naming hints (only `town` is still used, in the fallback intro). */
  terminology: Record<string, unknown>;
  syllables: { start: string[]; mid: string[]; end: string[] };
  firstNames: string[];
  lastNames: string[];
  townSuffix: string[];
  wildNames: [string[], string[]];
  dungeonNames: [string[], string[]];
  families: FamilyTemplate[];
  origins: Record<string, string>;
  items: Record<string, string[]>;
  skills: Record<string, string>;
  /** Tileset style per zone kind. */
  styles: { town: TilesetDef['style'][]; wilderness: TilesetDef['style'][]; dungeon: TilesetDef['style'][]; interior: TilesetDef['style'][] };
  villain: [string[], string[]];
  macguffin: string[];
  threat: string[];
  factions: string[];
  dualEnergy: boolean;
}

const FANTASY: GenreBank = {
  title: [['The Shattered', 'The Last', 'The Sunken', 'The Ember', 'The Hollow', 'The Ashen'], ['Crown', 'Vale', 'Covenant', 'Throne', 'Marches', 'Reliquary']],
  tone: 'adventurous high fantasy with a melancholy undertone',
  artStyle: 'painterly fantasy illustration, rich colors, soft rim lighting, detailed, Baldur\'s Gate style',
  playerRole: 'a wandering sellsword with a mysterious past',
  terminology: {},
  syllables: { start: ['Al', 'Bran', 'Cor', 'Dun', 'El', 'Fen', 'Gal', 'Har', 'Ith', 'Kel', 'Lor', 'Mor', 'Nor', 'Oak', 'Ril', 'Sil', 'Thal', 'Vel', 'Wyn', 'Yr'], mid: ['a', 'e', 'i', 'o', 'ar', 'en', 'il', 'or', 'an'], end: ['dor', 'mere', 'wick', 'ford', 'holm', 'thas', 'garde', 'vale', 'more', 'stead', 'reach'] },
  firstNames: ['Aldric', 'Brenna', 'Caius', 'Dalia', 'Edwyn', 'Fiora', 'Gareth', 'Hesta', 'Ivor', 'Jessa', 'Kael', 'Liora', 'Marek', 'Nessa', 'Orrin', 'Perrin', 'Quill', 'Rowan', 'Sabine', 'Tamsin', 'Ulric', 'Vesna', 'Wren', 'Yorick', 'Zara', 'Elowen', 'Bastian', 'Mira', 'Tobias', 'Isolde'],
  lastNames: ['Ashford', 'Blackwood', 'Copperkettle', 'Dunmore', 'Everhart', 'Fenwick', 'Greyhollow', 'Hawthorne', 'Ironwood', 'Kettleby', 'Lark', 'Marlowe', 'Northcott', 'Oakenshield', 'Pike', 'Quarry', 'Rook', 'Stormrider', 'Thatcher', 'Underbough'],
  townSuffix: ['ford', 'wick', 'haven', 'stead', 'bridge', 'cross', 'mere'],
  wildNames: [['Whispering', 'Thornveil', 'Gloam', 'Sunken', 'Windswept', 'Briar', 'Mistral', 'Amber'], ['Woods', 'Moor', 'Fen', 'Hills', 'Glade', 'Wilds', 'Downs', 'Thicket']],
  dungeonNames: [['Drowned', 'Forgotten', 'Howling', 'Crimson', 'Black', 'Sleeper\'s', 'Ashen', 'Weeping'], ['Crypt', 'Caverns', 'Barrow', 'Halls', 'Mines', 'Sanctum', 'Catacombs', 'Deep']],
  families: [
    { name: 'Goblins', description: 'Cunning, cowardly raiders who strike in numbers.', element: 'poison', habitat: 'forest hills cave', colors: ['#6f8f3a', '#4a5a2a', '#c0a060'], members: { skirmisher: 'Goblin Cutter', archer: 'Goblin Slinger', caster: 'Goblin Hexer', swarm: 'Goblin Runt', brute: 'Hobgoblin Brute' } },
    { name: 'Restless Dead', description: 'Corpses bound by old curses.', element: 'frost', habitat: 'crypt ruins swamp', colors: ['#b8b8a8', '#5a6470', '#90e0ff'], members: { brute: 'Grave Hulk', archer: 'Bone Archer', caster: 'Wight Caller', swarm: 'Crawling Bones', guardian: 'Barrow Knight' } },
    { name: 'Wolves', description: 'Hungry packs that hunt the wild roads.', element: 'physical', habitat: 'forest hills snow', colors: ['#7a7068', '#4a4440', '#d0c8b8'], members: { skirmisher: 'Grey Wolf', brute: 'Dire Wolf', swarm: 'Wolf Pup', assassin: 'Shadow Wolf' } },
    { name: 'Bandits', description: 'Outlaws who prey on travelers.', element: 'physical', habitat: 'hills forest ruins road', colors: ['#8a5a3a', '#3a3a40', '#b0a080'], members: { skirmisher: 'Cutthroat', archer: 'Bandit Archer', brute: 'Bandit Bruiser', healer: 'Hedge Surgeon', assassin: 'Knife in the Dark' } },
    { name: 'Spiders', description: 'Venomous weavers of the dark places.', element: 'poison', habitat: 'cave forest crypt', colors: ['#3a3040', '#6a2a4a', '#a0e060'], members: { skirmisher: 'Cave Spider', swarm: 'Spiderling', caster: 'Venom Spitter', brute: 'Broodmother' } },
    { name: 'Cultists', description: 'Zealots serving a forbidden power.', element: 'psychic', habitat: 'ruins crypt sanctum', colors: ['#5a1a2a', '#2a1a2a', '#e060c0'], members: { caster: 'Cult Adept', healer: 'Blood Priest', skirmisher: 'Zealot', guardian: 'Chosen Guard', assassin: 'Masked Knife' } },
    { name: 'Elementals', description: 'Living storms of fire and stone.', element: 'fire', habitat: 'mountain volcano ruins', colors: ['#d05a20', '#402010', '#ffb040'], members: { brute: 'Magma Brute', caster: 'Flame Wisp', swarm: 'Ember Mote', guardian: 'Stone Warden' } },
    { name: 'Bog Folk', description: 'Slimy marsh-dwellers with old grudges.', element: 'poison', habitat: 'swamp fen river', colors: ['#4a6a4a', '#2a3a2a', '#90a040'], members: { brute: 'Bog Troll', skirmisher: 'Mudskulk', caster: 'Swamp Witch', swarm: 'Leechling' } },
    { name: 'Wyrmkin', description: 'Scaled servants of the elder dragons.', element: 'fire', habitat: 'mountain volcano deep', colors: ['#8a2a1a', '#3a1a10', '#ffd060'], members: { guardian: 'Drake Guard', caster: 'Wyrm Speaker', skirmisher: 'Kobold Scrapper', brute: 'Young Drake' } },
    { name: 'Frost Giants', description: 'Ancient giants of the frozen north.', element: 'frost', habitat: 'snow mountain', colors: ['#a0c0e0', '#405070', '#ffffff'], members: { brute: 'Frost Giant', caster: 'Rime Shaman', skirmisher: 'Ice Hound' } },
  ],
  origins: { o_warrior: 'Sellsword', o_ranger: 'Ranger', o_rogue: 'Cutpurse', o_mage: 'Battlemage', o_cleric: 'Wandering Priest', o_occultist: 'Hexblade' },
  items: {},
  skills: {},
  styles: { town: ['grass', 'dirt'], wilderness: ['grass', 'dirt', 'snow', 'sand'], dungeon: ['stone', 'crystal', 'dirt'], interior: ['wood', 'stone'] },
  villain: [['Malrec', 'Seraphine', 'Vorath', 'Ysolde', 'Kharzul', 'Morgaine'], ['the Hollow King', 'the Ash Witch', 'the Pale Shepherd', 'the Unbound', 'the Grey Tide']],
  macguffin: ['the Heartstone', 'the Sunken Crown', 'the Ember Codex', 'the Moonlit Seal', 'the Shard of Dawn'],
  threat: ['a creeping blight', 'a breaking seal', 'an army of the dead', 'a waking dragon', 'a curse on the bloodline'],
  factions: ['the Lantern Watch', 'the Silver Court', 'the Thornwardens', 'the Free Companies', 'the Order of the Pale Flame'],
  dualEnergy: true,
};

const SCIFI: GenreBank = {
  title: [['Beyond the', 'Echoes of', 'The Last', 'Signal from', 'The Drift of'], ['Kepler Reach', 'Dead Star', 'Orion Gate', 'Iron Nebula', 'Void Frontier']],
  tone: 'gritty space opera with flashes of wonder',
  artStyle: 'sleek sci-fi concept art, neon accents, volumetric lighting, detailed hard-surface design',
  playerRole: 'a freelance salvager with a ship debt to pay',
  terminology: { health: 'Integrity', stamina: 'Energy', focus: 'Bandwidth', physArmor: 'Plating', magArmor: 'Shields', gold: 'Credits', xp: 'Data', town: 'Station', dungeon: 'Derelict', wilderness: 'Surface', quest: 'Contract', party: 'Crew', attributes: { might: 'Power', finesse: 'Reflex', intellect: 'Logic', vitality: 'Grit', spirit: 'Resolve', wits: 'Perception' }, schools: { warfare: 'Assault', marksmanship: 'Gunnery', shadow: 'Infiltration', elemental: 'Plasma Tech', occult: 'Psionics', restoration: 'Med-Tech', utility: 'Engineering' }, damageTypes: { physical: 'Kinetic', piercing: 'Armor-Piercing', fire: 'Plasma', frost: 'Cryo', shock: 'Ion', poison: 'Toxin', psychic: 'Psionic', radiant: 'Photon' } },
  syllables: { start: ['Ar', 'Bex', 'Cyr', 'Dex', 'Ery', 'Hal', 'Ix', 'Ker', 'Lyx', 'Nov', 'Ory', 'Prax', 'Qua', 'Rho', 'Syn', 'Tau', 'Vex', 'Zet'], mid: ['a', 'i', 'o', 'ex', 'yn', 'or'], end: ['-7', ' Prime', ' Station', 'is', 'on', 'ara', ' Outpost', ' Hub'] },
  firstNames: ['Ari', 'Bex', 'Cassius', 'Dax', 'Eko', 'Freya', 'Hux', 'Iona', 'Juno', 'Kaito', 'Lyra', 'Milo', 'Nyx', 'Orion', 'Pax', 'Quinn', 'Rhea', 'Soren', 'Tess', 'Vega', 'Wren', 'Xan', 'Yuki', 'Zed'],
  lastNames: ['Okafor', 'Vance', 'Reyes', 'Kovac', 'Tanaka', 'Mbeki', 'Sorensen', 'Hale', 'Ivanova', 'Castillo', 'Lindqvist', 'Achebe', 'Moreau', 'Chen', 'Duarte'],
  townSuffix: [' Station', ' Hub', ' Outpost', ' Dock', ' Colony'],
  wildNames: [['Red', 'Shattered', 'Frozen', 'Silent', 'Ion', 'Glass'], ['Dunes', 'Flats', 'Canyons', 'Wastes', 'Fields', 'Crater']],
  dungeonNames: [['Derelict', 'Abandoned', 'Infested', 'Dark', 'Quarantined', 'Ghost'], ['Hulk', 'Lab', 'Reactor', 'Mine', 'Vault', 'Ark']],
  families: [
    { name: 'Rogue Drones', description: 'Security machines with corrupted directives.', element: 'shock', habitat: 'station derelict lab', colors: ['#8090a0', '#303840', '#40e0ff'], members: { skirmisher: 'Seeker Drone', archer: 'Sentry Turret', brute: 'Loader Mech', guardian: 'Riot Bot', swarm: 'Micro-Drone' } },
    { name: 'Xenoforms', description: 'Chitinous predators from an unknown world.', element: 'poison', habitat: 'surface derelict hive', colors: ['#3a2a4a', '#6a3a5a', '#c0f040'], members: { skirmisher: 'Stalker', swarm: 'Scuttler', brute: 'Brood Hulk', caster: 'Spitter', assassin: 'Lurker' } },
    { name: 'Raiders', description: 'Void pirates who strip ships for parts.', element: 'fire', habitat: 'station surface wastes', colors: ['#a04030', '#303030', '#f0a040'], members: { skirmisher: 'Raider', archer: 'Gunner', brute: 'Breacher', healer: 'Medic', caster: 'Pyro' } },
    { name: 'Synthetics', description: 'Androids pursuing a cold, alien logic.', element: 'psychic', habitat: 'lab vault station', colors: ['#e0e0f0', '#506080', '#ff40a0'], members: { caster: 'Logic Node', assassin: 'Infiltrator Unit', guardian: 'Warden Frame', healer: 'Repair Unit' } },
    { name: 'Cryo Fauna', description: 'Beasts adapted to frozen worlds.', element: 'frost', habitat: 'surface ice crater', colors: ['#a0d0f0', '#405060', '#ffffff'], members: { brute: 'Tundra Behemoth', skirmisher: 'Ice Runner', swarm: 'Frost Mite' } },
    { name: 'Corporate Security', description: 'Mercenaries guarding company secrets.', element: 'physical', habitat: 'station vault lab', colors: ['#202838', '#4060a0', '#e0e0e0'], members: { archer: 'Marksman', guardian: 'Shield Trooper', skirmisher: 'Operative', healer: 'Field Medic' } },
  ],
  origins: { o_warrior: 'Marine', o_ranger: 'Sharpshooter', o_rogue: 'Slicer', o_mage: 'Plasma Engineer', o_cleric: 'Combat Medic', o_occultist: 'Psion' },
  items: { w_blade: ['Shock Baton', 'Vibro-Blade', 'Arc Saber'], w_heavy: ['Power Maul', 'Breach Hammer', 'Grav Cleaver'], w_dagger: ['Mono-Knife', 'Stiletto', 'Ion Shiv'], w_bow: ['Rail Rifle', 'Pulse Carbine', 'Gauss Rifle'], w_staff: ['Plasma Caster', 'Ion Projector', 'Singularity Lance'], w_wand: ['Blaster Pistol', 'Arc Pistol', 'Neural Emitter'], s_shield: ['Riot Shield', 'Hardlight Barrier'], s_focus: ['Psi Amplifier'], a_head_heavy: ['Combat Helmet'], a_head_light: ['Visor'], a_chest_heavy: ['Exo-Plate'], a_chest_light: ['Flight Suit'], a_hands_heavy: ['Power Gauntlets'], a_hands_light: ['Tech Gloves'], a_feet_heavy: ['Mag Boots'], a_feet_light: ['Runner Boots'], t_ring: ['Neural Implant'], t_amulet: ['Data Core'], c_heal: ['Medi-Gel'], c_stamina: ['Stim Pack'], c_focus: ['Neuro Booster'], c_antidote: ['Purge Injector'], c_bomb_fire: ['Plasma Grenade'], c_bomb_frost: ['Cryo Grenade'], c_elixir: ['Combat Stim'], c_recall: ['Beacon Recall'], c_food: ['Ration Bar'], c_skillbook: ['Training Chip'], tool_trapkit: ['Bypass Kit'], tool_lockpick: ['Decryptor'], m_herb: ['Bio-Gel'], m_ore: ['Scrap Alloy'], m_hide: ['Polymer'], m_cloth: ['Fiber Mesh'], m_essence: ['Power Cell'], m_crystal: ['Quantum Crystal'], v_gem: ['Data Shard'], v_trinket: ['Old-Earth Relic'] },
  skills: { heal: 'Nano-Repair', firebolt: 'Plasma Bolt', fireball: 'Plasma Grenade Launcher', frost_lance: 'Cryo Beam', lightning: 'Ion Arc', mind_spike: 'Neural Spike', smite: 'Photon Lance' },
  styles: { town: ['metal'], wilderness: ['sand', 'snow', 'dirt', 'crystal'], dungeon: ['metal', 'flesh', 'crystal'], interior: ['metal'] },
  villain: [['Director Vale', 'ARCHON', 'Admiral Kross', 'The Hivemind', 'Unit Zero'], ['the Silent Fleet', 'the Consortium', 'the Signal', 'the Swarm']],
  macguffin: ['the Ark Core', 'the Origin Signal', 'the Nav Key', 'the Seed Vault codes'],
  threat: ['a spreading nanoplague', 'a rogue AI awakening', 'an alien swarm', 'a dying star'],
  factions: ['the Free Haulers Union', 'Helix Consortium', 'the Colonial Guard', 'the Choir of the Signal'],
  dualEnergy: true,
};

const COZY: GenreBank = {
  title: [['The Great', 'A Season in', 'The Lantern of', 'The Secret of'], ['Thistledown', 'Brambleberry Hollow', 'Mossy Meadow', 'Willowmere']],
  tone: 'warm, gentle storybook adventure with soft peril',
  artStyle: 'cozy storybook watercolor illustration, soft pastel colors, rounded shapes, charming, children\'s book style',
  playerRole: 'a young woodland critter setting out on their first adventure',
  terminology: { health: 'Hearts', stamina: 'Pep', focus: 'Wonder', physArmor: 'Padding', magArmor: 'Courage', gold: 'Acorns', xp: 'Stars', town: 'Village', dungeon: 'Burrow', wilderness: 'Meadow', quest: 'Errand', party: 'Friends', attributes: { might: 'Strength', finesse: 'Nimbleness', intellect: 'Cleverness', vitality: 'Heartiness', spirit: 'Kindness', wits: 'Curiosity' }, damageTypes: { physical: 'Bonk', piercing: 'Poke', fire: 'Spicy', frost: 'Chilly', shock: 'Zappy', poison: 'Stinky', psychic: 'Spooky', radiant: 'Sparkle' }, schools: { warfare: 'Scrapping', marksmanship: 'Slingshot', shadow: 'Sneaking', elemental: 'Hedge Magic', occult: 'Mischief', restoration: 'Mending', utility: 'Know-how' } },
  syllables: { start: ['Bramble', 'Thistle', 'Clover', 'Mossy', 'Willow', 'Honey', 'Pebble', 'Acorn', 'Fern', 'Tumble'], mid: [''], end: ['brook', 'dale', 'hollow', 'bottom', 'nook', 'end', 'bury'] },
  firstNames: ['Pip', 'Hazel', 'Bramble', 'Clover', 'Juniper', 'Rosie', 'Barnaby', 'Wilbur', 'Maple', 'Tansy', 'Fennel', 'Basil', 'Poppy', 'Bertram', 'Daisy', 'Thimble'],
  lastNames: ['Bristlewhisker', 'Thornapple', 'Puddleby', 'Mossbottom', 'Honeysuckle', 'Burrows', 'Quillfeather', 'Nutkin', 'Tumbledown'],
  townSuffix: ['brook', 'dale', 'hollow', 'nook'],
  wildNames: [['Buttercup', 'Dewdrop', 'Whistling', 'Sunny', 'Tangled'], ['Meadow', 'Woods', 'Hedgerow', 'Pond', 'Orchard']],
  dungeonNames: [['Grumbly', 'Dark', 'Twisty', 'Old', 'Spooky'], ['Burrow', 'Root Cellar', 'Hollow Log', 'Molehills', 'Badger Sett']],
  families: [
    { name: 'Weasel Gang', description: 'Sly troublemakers who pinch pies from windowsills.', element: 'physical', habitat: 'meadow woods hedgerow', colors: ['#a07040', '#604020', '#f0e0c0'], members: { skirmisher: 'Weasel Pickpocket', archer: 'Weasel Slingshotter', brute: 'Big Stoat', assassin: 'Ferret Sneak' } },
    { name: 'Grumpy Beetles', description: 'Armored beetles who hate being woken.', element: 'physical', habitat: 'burrow woods log', colors: ['#3a5a3a', '#203020', '#80c060'], members: { guardian: 'Shellback Beetle', swarm: 'Grub', brute: 'Stag Beetle' } },
    { name: 'Mischief Sprites', description: 'Giggling sprites who play pranks with magic.', element: 'shock', habitat: 'meadow pond orchard', colors: ['#c0a0f0', '#6040a0', '#fff0a0'], members: { caster: 'Prankster Sprite', swarm: 'Wisplet', healer: 'Dew Sprite' } },
    { name: 'Crows', description: 'Noisy crows who collect shiny things.', element: 'psychic', habitat: 'orchard woods field', colors: ['#202028', '#404050', '#c0c0d0'], members: { skirmisher: 'Crow Bully', caster: 'Old Raven', swarm: 'Fledgling' } },
    { name: 'Bog Toads', description: 'Big-mouthed toads that guard the marshes.', element: 'poison', habitat: 'pond marsh burrow', colors: ['#6a8a3a', '#3a4a20', '#d0e080'], members: { brute: 'Bullfrog', caster: 'Toad Witch', swarm: 'Tadpole' } },
  ],
  origins: { o_warrior: 'Brave Badger', o_ranger: 'Sharp-eyed Squirrel', o_rogue: 'Sneaky Mouse', o_mage: 'Hedge-witch Hare', o_cleric: 'Kindly Hedgehog', o_occultist: 'Mysterious Owl' },
  items: { w_blade: ['Twig Sword', 'Thorn Rapier'], w_heavy: ['Acorn Mallet', 'Log Club'], w_dagger: ['Sewing Needle', 'Rose Thorn'], w_bow: ['Slingshot', 'Willow Bow'], w_staff: ['Hazel Wand-Staff', 'Moonbeam Staff'], w_wand: ['Twinkle Wand'], s_shield: ['Pot Lid', 'Walnut Shell Shield'], s_focus: ['Storybook'], a_head_heavy: ['Thimble Helm'], a_head_light: ['Knitted Cap'], a_chest_heavy: ['Bark Vest'], a_chest_light: ['Woolly Jumper'], a_hands_heavy: ['Gardening Gloves'], a_hands_light: ['Mittens'], a_feet_heavy: ['Clogs'], a_feet_light: ['Slippers'], t_ring: ['Daisy Ring'], t_amulet: ['Lucky Pebble'], c_heal: ['Blackberry Tart'], c_stamina: ['Honey Cake'], c_focus: ['Chamomile Tea'], c_antidote: ['Mint Sprig'], c_bomb_fire: ['Pepper Pouch'], c_bomb_frost: ['Snowball'], c_elixir: ['Brave Juice'], c_recall: ['Homing Feather'], c_food: ['Cheese Wedge'], c_skillbook: ['Picture Book'], tool_trapkit: ['Fiddly Kit'], tool_lockpick: ['Hairpin'], m_herb: ['Clover'], m_ore: ['Shiny Pebble'], m_hide: ['Leaf'], m_cloth: ['Thread'], m_essence: ['Dewdrop'], m_crystal: ['Moonstone'], v_gem: ['Marble'], v_trinket: ['Button'] },
  skills: { heal: 'Warm Hug', firebolt: 'Spicy Sneeze', whirlwind: 'Tumble Spin', backstab: 'Sneak Poke', smite: 'Sparkle Bop' },
  styles: { town: ['grass'], wilderness: ['grass', 'dirt'], dungeon: ['dirt', 'wood'], interior: ['wood'] },
  villain: [['Baron Grimtooth', 'Old Mother Thorn', 'The Fox King', 'Lord Mugwort'], ['the Long Winter', 'the Grumble', 'the Shadow Under the Hill']],
  macguffin: ['the Spring Lantern', 'the Golden Acorn', 'the First Seed', 'the Moon Bell'],
  threat: ['an endless winter', 'a stolen spring', 'a spreading gloom'],
  factions: ['the Hedge Council', 'the Lantern Lighters', 'the Mole Miners Guild'],
  dualEnergy: false,
};

const MODERN: GenreBank = {
  title: [['Operation', 'The Last', 'Paper Jam:', 'Out of'], ['Toner', 'Printer', 'Office Hours', 'Q4']],
  tone: 'dry workplace comedy that slowly escalates into absurd conspiracy',
  artStyle: 'clean modern illustration, flat shading, muted office colors with bold accents, slightly satirical cartoon',
  playerRole: 'a mid-level employee who has finally had enough',
  terminology: { health: 'Composure', stamina: 'Caffeine', focus: 'Patience', physArmor: 'Thick Skin', magArmor: 'Cool Head', gold: 'Dollars', xp: 'Promotion Points', level: 'Pay Grade', town: 'Floor', dungeon: 'Department', wilderness: 'Parking Lot', quest: 'Task', party: 'Team', actionPoints: 'Initiative', attributes: { might: 'Grit', finesse: 'Hustle', intellect: 'Smarts', vitality: 'Stamina', spirit: 'Optimism', wits: 'Street Smarts' }, damageTypes: { physical: 'Blunt', piercing: 'Paper Cut', fire: 'Burnout', frost: 'Cold Shoulder', shock: 'Static', poison: 'Toxic Positivity', psychic: 'Passive-Aggression', radiant: 'Good Vibes' }, schools: { warfare: 'Hardball', marksmanship: 'Office Supplies', shadow: 'Office Politics', elemental: 'IT Wizardry', occult: 'Middle Management', restoration: 'HR', utility: 'Know-how' } },
  syllables: { start: ['North', 'East', 'Central', 'Upper', 'West', 'Lower'], mid: [' '], end: ['Tower', 'Plaza', 'Annex', 'Campus', 'Park'] },
  firstNames: ['Karen', 'Dave', 'Priya', 'Marcus', 'Linda', 'Kevin', 'Tasha', 'Greg', 'Mei', 'Brad', 'Olu', 'Sandra', 'Raj', 'Becky', 'Tom', 'Jordan'],
  lastNames: ['from Accounting', 'from IT', 'from Legal', 'Henderson', 'Patel', 'Nguyen', 'Johnson', 'Kowalski', 'Garcia', 'Smith'],
  townSuffix: [' Plaza', ' Tower', ' Campus'],
  wildNames: [['Level B', 'North', 'Overflow', 'Visitor', 'Executive'], ['Parking', 'Courtyard', 'Loading Dock', 'Smoking Area']],
  dungeonNames: [['Records', 'Server', 'Basement', 'Legal', 'Executive'], ['Archive', 'Room', 'Storage', 'Department', 'Suite']],
  families: [
    { name: 'Rogue Printers', description: 'Office machines that have become self-aware and spiteful.', element: 'shock', habitat: 'office server archive', colors: ['#d0d0c8', '#505058', '#40c0ff'], members: { brute: 'Floor Copier', archer: 'Laser Printer', swarm: 'Paper Jam', guardian: 'Industrial Shredder', caster: 'Fax of Doom' } },
    { name: 'Interns', description: 'Overworked interns, desperate for approval.', element: 'psychic', habitat: 'office plaza parking', colors: ['#4060a0', '#e0e0e0', '#f0c040'], members: { swarm: 'Unpaid Intern', skirmisher: 'Eager Intern', healer: 'Coffee Runner' } },
    { name: 'Middle Managers', description: 'They schedule meetings that could have been emails.', element: 'psychic', habitat: 'office suite department', colors: ['#303848', '#a0a0b0', '#e04040'], members: { caster: 'Synergy Consultant', guardian: 'Department Head', healer: 'HR Liaison', assassin: 'Backstabbing Colleague' } },
    { name: 'Security', description: 'Rent-a-cops who take the badge policy very seriously.', element: 'physical', habitat: 'parking plaza lobby', colors: ['#202030', '#606070', '#e0c040'], members: { guardian: 'Night Guard', skirmisher: 'Mall Cop', archer: 'Taser Guard' } },
    { name: 'Breakroom Horrors', description: 'Things that evolved in the communal fridge.', element: 'poison', habitat: 'breakroom basement archive', colors: ['#7a9a3a', '#3a4a2a', '#d0e060'], members: { swarm: 'Mold Spore', brute: 'Forgotten Casserole', caster: 'Sentient Yogurt' } },
  ],
  origins: { o_warrior: 'Warehouse Lead', o_ranger: 'Sales Rep', o_rogue: 'Office Gossip', o_mage: 'IT Guy', o_cleric: 'HR Rep', o_occultist: 'Day Trader' },
  items: { w_blade: ['Stapler', 'Letter Opener', 'Golf Club'], w_heavy: ['Fire Extinguisher', 'Water Cooler Jug'], w_dagger: ['Scissors', 'Box Cutter'], w_bow: ['Rubber Band Gun', 'Nerf Blaster'], w_staff: ['Laser Pointer', 'Presentation Clicker'], w_wand: ['USB Stick', 'Company Pen'], s_shield: ['Clipboard', 'Laptop'], s_focus: ['Employee Handbook'], a_head_heavy: ['Bike Helmet'], a_head_light: ['Headset'], a_chest_heavy: ['Puffer Vest'], a_chest_light: ['Blazer'], a_hands_heavy: ['Work Gloves'], a_hands_light: ['Wrist Brace'], a_feet_heavy: ['Steel-toe Boots'], a_feet_light: ['Sneakers'], t_ring: ['Smartwatch'], t_amulet: ['Lanyard Badge'], c_heal: ['Donut'], c_stamina: ['Espresso'], c_focus: ['Energy Drink'], c_antidote: ['Antacid'], c_bomb_fire: ['Burnt Popcorn'], c_bomb_frost: ['Ice Pack'], c_elixir: ['Motivational Poster'], c_recall: ['Rideshare Voucher'], c_food: ['Granola Bar'], c_skillbook: ['Training Webinar'], tool_trapkit: ['Multitool'], tool_lockpick: ['Paperclip'], m_herb: ['Coffee Beans'], m_ore: ['Spare Parts'], m_hide: ['Duct Tape'], m_cloth: ['Sticky Notes'], m_essence: ['Batteries'], m_crystal: ['Microchip'], v_gem: ['Gift Card'], v_trinket: ['Fidget Toy'] },
  skills: { heal: 'Pep Talk', firebolt: 'Hot Take', whirlwind: 'Desk Spin', smite: 'Performance Review', mind_spike: 'Reply All', taunt: 'Call a Meeting' },
  styles: { town: ['metal'], wilderness: ['stone'], dungeon: ['metal', 'stone'], interior: ['wood', 'metal'] },
  villain: [['The CEO', 'PRINT-0', 'Regional Manager Doug', 'The Board'], ['the Algorithm', 'the Merger', 'the Final Audit']],
  macguffin: ['the Master Toner Cartridge', 'the Admin Password', 'the Golden Stapler', 'the Original Org Chart'],
  threat: ['a hostile takeover', 'a printer uprising', 'mandatory weekend overtime'],
  factions: ['the IT Department', 'Facilities', 'the Union of Interns', 'the Executive Floor'],
  dualEnergy: true,
};

const HORROR: GenreBank = {
  ...FANTASY,
  title: [['The Whispering', 'The Drowned', 'The Black', 'Below'], ['Parish', 'Lighthouse', 'Archive', 'Saltmarsh']],
  tone: 'creeping cosmic horror where knowledge has a price',
  artStyle: 'dark gothic illustration, desaturated palette with sickly accents, heavy shadows, unsettling details',
  playerRole: 'an investigator who received a letter from a dead friend',
  terminology: { health: 'Health', stamina: 'Stamina', focus: 'Sanity', magArmor: 'Resolve', physArmor: 'Armor', gold: 'Shillings', town: 'Village', dungeon: 'Depths', wilderness: 'Moors', schools: { warfare: 'Brawling', marksmanship: 'Firearms', shadow: 'Stealth', elemental: 'Alchemy', occult: 'Forbidden Lore', restoration: 'Medicine', utility: 'Investigation' } },
  families: [FANTASY.families[1]!, FANTASY.families[5]!, FANTASY.families[4]!, { name: 'Deep Ones', description: 'Fish-eyed things that rise from the sea.', element: 'frost', habitat: 'coast swamp depths', colors: ['#3a5a5a', '#1a2a2a', '#80d0b0'], members: { brute: 'Deep Brute', skirmisher: 'Hybrid', caster: 'Tide Priest', swarm: 'Spawn' } }],
  styles: { town: ['dirt', 'grass'], wilderness: ['dirt', 'grass'], dungeon: ['stone', 'flesh'], interior: ['wood'] },
  villain: [['The Drowned Bishop', 'Professor Halloway', 'The Thing in the Lighthouse'], ['the Choir Below', 'the Yellow Sign']],
};

const WHIMSY: GenreBank = {
  ...COZY,
  title: [['Through the', 'The Riddle of', 'Down the'], ['Looking Glass', 'Clockwork Tea Party', 'Upside-Down Garden']],
  tone: 'surreal, playful nonsense with sharp riddles',
  artStyle: 'surreal storybook illustration, vivid saturated colors, impossible architecture, whimsical Victorian details',
  playerRole: 'a curious visitor who fell somewhere they should not have',
  terminology: { health: 'Sense', stamina: 'Pluck', focus: 'Imagination', gold: 'Buttons', town: 'Borough', dungeon: 'Labyrinth', wilderness: 'Garden', quest: 'Riddle', xp: 'Curiosity' },
  styles: { town: ['grass', 'crystal'], wilderness: ['grass', 'crystal'], dungeon: ['crystal', 'void'], interior: ['wood'] },
  families: [
    { name: 'Card Soldiers', description: 'Flat, pompous soldiers who follow absurd rules.', element: 'physical', habitat: 'garden borough labyrinth', colors: ['#e0e0e0', '#c02020', '#202020'], members: { guardian: 'Ten of Spades', archer: 'Card Archer', skirmisher: 'Two of Hearts', brute: 'King\'s Guard' } },
    { name: 'Clockwork Critters', description: 'Wind-up animals that tick menacingly.', element: 'shock', habitat: 'labyrinth borough', colors: ['#b08040', '#504030', '#f0d080'], members: { swarm: 'Wind-up Mouse', skirmisher: 'Brass Hare', caster: 'Cuckoo Clock' } },
    { name: 'Rude Flowers', description: 'Gossiping flowers with poisonous tongues.', element: 'poison', habitat: 'garden', colors: ['#e060a0', '#40a040', '#ffe060'], members: { caster: 'Tiger Lily', swarm: 'Snapdragon', healer: 'Rose' } },
  ],
};

export const BANKS: Record<Genre, GenreBank> = { fantasy: FANTASY, scifi: SCIFI, cozy: COZY, modern: MODERN, horror: HORROR, whimsy: WHIMSY };

// ---------------------------------------------------------------------------------- tilesets

const STYLE_COLORS: Record<TilesetDef['style'], { floor: string[]; alt: string[]; path: string[]; wall: string[]; water: string[]; tree: string[]; rock: string[]; plant: string[] }> = {
  grass: { floor: ['#5f8a3c', '#4f7a32', '#6e9a46'], alt: ['#7a9a4a', '#8aa858', '#6a8a40'], path: ['#9a8360', '#8a7350', '#a89070'], wall: ['#8a8378', '#6e675e', '#a39a8a'], water: ['#3f78a8', '#2f6898', '#5a90c0'], tree: ['#3e6a2e', '#2e5a26', '#5a3a22'], rock: ['#8a8680', '#6a6660'], plant: ['#7ab04a', '#e0d060', '#d06a8a'] },
  dirt: { floor: ['#7a6448', '#6a553c', '#8a7454'], alt: ['#6a7040', '#5a6036', '#7a8048'], path: ['#a08a68', '#8f7a5a', '#b09878'], wall: ['#6a5a4a', '#504538', '#80705c'], water: ['#4a6a70', '#3a5a60', '#5a7a80'], tree: ['#4a5a2a', '#3a4a22', '#4a3220'], rock: ['#7a7064', '#5a5248'], plant: ['#8a9a40', '#a07a40', '#6a8a3a'] },
  stone: { floor: ['#5a5a62', '#4a4a52', '#66666e'], alt: ['#52524a', '#5e5e56', '#48483f'], path: ['#6e6a64', '#7a766e', '#625e58'], wall: ['#3e3c44', '#2e2c34', '#4e4c54'], water: ['#2a4a5a', '#1e3a4a', '#3a5a6a'], tree: ['#4a4a50', '#3a3a40', '#5a5a60'], rock: ['#6a6870', '#4a4850'], plant: ['#5a7a5a', '#4a8a7a', '#8a7aa0'] },
  sand: { floor: ['#c8b07a', '#b8a06a', '#d6be88'], alt: ['#b8986a', '#c8a878', '#a88a5a'], path: ['#a8906a', '#98805a', '#b89c76'], wall: ['#a07a50', '#8a6640', '#b08a60'], water: ['#3a90a0', '#2a8090', '#4aa0b0'], tree: ['#6a8a3a', '#5a7a2a', '#8a6a40'], rock: ['#a08a6a', '#8a7454'], plant: ['#8aa04a', '#c0a050', '#a0b060'] },
  snow: { floor: ['#e6eef4', '#d6e0ea', '#f2f6fa'], alt: ['#c8d6e2', '#bccad8', '#d4e0ea'], path: ['#b4b0aa', '#a49e98', '#c2beb8'], wall: ['#8a94a0', '#6e7884', '#a0aab4'], water: ['#9ac8e0', '#7ab4d4', '#b4dcee'], tree: ['#2e4a3a', '#24402e', '#e8f0f4'], rock: ['#9aa4ae', '#7a848e'], plant: ['#a0b4b8', '#c0d0d8', '#80a0a8'] },
  wood: { floor: ['#8a6a48', '#7a5c3c', '#9a7854'], alt: ['#7a3a32', '#8a4a3a', '#6a2e28'], path: ['#a07a54', '#906c48', '#b08a60'], wall: ['#5a4434', '#4a382a', '#6a5240'], water: ['#3a6a8a', '#2a5a7a', '#4a7a9a'], tree: ['#6a5040', '#5a4232', '#7a5e4a'], rock: ['#7a6a5a', '#5a4e42'], plant: ['#6a9a4a', '#c06a6a', '#e0c060'] },
  metal: { floor: ['#5a646e', '#4c5660', '#68727c'], alt: ['#4a5560', '#56626e', '#3e4852'], path: ['#7a8490', '#6a7480', '#8a94a0'], wall: ['#38404a', '#2a323a', '#48525c'], water: ['#2aa0b0', '#1a90a0', '#40c0d0'], tree: ['#5a6a7a', '#4a5a6a', '#40e0ff'], rock: ['#6a747e', '#4e5862'], plant: ['#40c0a0', '#40a0e0', '#e0a040'] },
  crystal: { floor: ['#5a4a7a', '#4a3a6a', '#6a5a8a'], alt: ['#4a5a8a', '#5a6a9a', '#3e4a7a'], path: ['#8a7aa8', '#7a6a98', '#9a8ab8'], wall: ['#3a2e5a', '#2a2048', '#4a3e6a'], water: ['#60c0e0', '#40a0d0', '#80e0f0'], tree: ['#a080e0', '#8060c0', '#e0c0ff'], rock: ['#7a6aa0', '#5a4a80'], plant: ['#e080e0', '#80e0e0', '#c0a0ff'] },
  flesh: { floor: ['#6a3a3e', '#5a2e32', '#7a464a'], alt: ['#7a4a3a', '#6a3e30', '#8a5a48'], path: ['#8a5a5a', '#7a4c4c', '#9a6a6a'], wall: ['#4a2428', '#3a1a1e', '#5a3034'], water: ['#8a2a2a', '#7a1e1e', '#a03a3a'], tree: ['#6a2a3a', '#5a1e2e', '#a04a5a'], rock: ['#7a4a4a', '#5a3434'], plant: ['#a05a6a', '#c07a5a', '#80a050'] },
  void: { floor: ['#2a2638', '#221e30', '#343046'], alt: ['#302a48', '#3a3454', '#26203a'], path: ['#4a4466', '#3e3858', '#565074'], wall: ['#16121e', '#0e0a16', '#1e1a28'], water: ['#6040a0', '#503090', '#7050b0'], tree: ['#40306a', '#30205a', '#a080ff'], rock: ['#3a3450', '#2a2440'], plant: ['#8060e0', '#40e0c0', '#e060a0'] },
};

const ROLE_NAMES: Record<TilesetDef['style'], Partial<Record<string, string>>> = {
  grass: { floor: 'Grass', floorAlt: 'Wildflower Meadow', path: 'Dirt Road', water: 'Pond', wall: 'Fieldstone Wall', tree: 'Oak Tree', rock: 'Boulder', plant: 'Shrub', light: 'Lantern Post', pillar: 'Standing Stone' },
  dirt: { floor: 'Packed Earth', floorAlt: 'Scrub', path: 'Trail', water: 'Muddy Pool', wall: 'Timber Palisade', tree: 'Gnarled Tree', rock: 'Rock', plant: 'Bramble', light: 'Torch', pillar: 'Old Post' },
  stone: { floor: 'Flagstones', floorAlt: 'Cracked Tiles', path: 'Worn Stone', water: 'Black Water', wall: 'Masonry Wall', tree: 'Stalagmite', rock: 'Rubble Heap', plant: 'Cave Moss', light: 'Brazier', pillar: 'Pillar' },
  sand: { floor: 'Sand', floorAlt: 'Dunes', path: 'Hardpan Track', water: 'Oasis', wall: 'Sandstone Wall', tree: 'Palm', rock: 'Sandstone Outcrop', plant: 'Desert Scrub', light: 'Oil Lamp', pillar: 'Obelisk' },
  snow: { floor: 'Snow', floorAlt: 'Frosted Grass', path: 'Trodden Path', water: 'Frozen Lake', wall: 'Ice Wall', tree: 'Pine', rock: 'Frosted Boulder', plant: 'Winter Shrub', light: 'Watch Fire', pillar: 'Ice Spire' },
  wood: { floor: 'Wooden Floorboards', floorAlt: 'Rug', path: 'Hallway Planks', water: 'Wash Basin', wall: 'Timber Wall', tree: 'Support Beam', rock: 'Crates', plant: 'Potted Plant', light: 'Candelabra', pillar: 'Beam' },
  metal: { floor: 'Deck Plating', floorAlt: 'Grating', path: 'Walkway', water: 'Coolant Pool', wall: 'Bulkhead', tree: 'Antenna Mast', rock: 'Cargo Crate', plant: 'Hydroponic Planter', light: 'Floodlight', pillar: 'Support Strut' },
  crystal: { floor: 'Crystal Floor', floorAlt: 'Glowing Moss', path: 'Polished Path', water: 'Luminous Pool', wall: 'Crystal Wall', tree: 'Crystal Spire', rock: 'Geode', plant: 'Glowcap', light: 'Floating Light', pillar: 'Crystal Pillar' },
  flesh: { floor: 'Pulsing Floor', floorAlt: 'Sinew', path: 'Bone Path', water: 'Ichor Pool', wall: 'Flesh Wall', tree: 'Bone Spire', rock: 'Calcified Mass', plant: 'Tendrils', light: 'Glowing Pustule', pillar: 'Rib Column' },
  void: { floor: 'Starlit Void', floorAlt: 'Shimmer', path: 'Floating Path', water: 'Abyss', wall: 'Edge of Nothing', tree: 'Dream Spire', rock: 'Floating Rock', plant: 'Star Lily', light: 'Wisp', pillar: 'Obelisk' },
};

export function fallbackTileset(id: string, name: string, style: TilesetDef['style'], kind: 'town' | 'wilderness' | 'dungeon' | 'interior', genre: Genre): TilesetDef {
  const c = STYLE_COLORS[style];
  const n = ROLE_NAMES[style];
  const extra = genre === 'scifi' || genre === 'modern';
  const role = (name: string, colors: string[], prompt: string) => ({ name, colors, prompt });
  const ambientByKind = { town: 1, wilderness: 1, dungeon: 0.35, interior: 0.7 };
  return {
    id,
    name,
    style,
    ambient: ambientByKind[kind],
    fogColor: kind === 'dungeon' ? '#0a0810' : '#101820',
    lightColor: extra ? '#c0e8ff' : '#ffc070',
    outdoor: kind === 'town' || kind === 'wilderness',
    weather: kind === 'dungeon' ? 'dust' : style === 'snow' ? 'snow' : kind === 'wilderness' && style === 'grass' ? 'fireflies' : 'none',
    roles: {
      floor: role(n.floor ?? 'Ground', c.floor, `${n.floor ?? 'ground'} surface`),
      floorAlt: role(n.floorAlt ?? 'Rough Ground', c.alt, `${n.floorAlt ?? 'rough ground'} surface`),
      path: role(n.path ?? 'Path', c.path, `${n.path ?? 'path'} surface`),
      water: role(n.water ?? 'Water', c.water, `${n.water ?? 'water'} surface`),
      wall: role(n.wall ?? 'Wall', c.wall, `${n.wall ?? 'wall'} surface`),
      tree: role(n.tree ?? 'Tree', c.tree, n.tree ?? 'tree'),
      rock: role(n.rock ?? 'Rock', c.rock, n.rock ?? 'rock'),
      plant: role(n.plant ?? 'Plant', c.plant, n.plant ?? 'plant'),
      light: role(n.light ?? 'Lamp', ['#5a4a3a', '#ffd080'], n.light ?? 'lamp'),
      furniture: role(extra ? 'Console' : 'Table', ['#7a5a3a', '#5a4028'], extra ? 'computer console' : 'wooden table'),
      rubble: role('Debris', c.rock, 'scattered debris'),
      pillar: role(n.pillar ?? 'Pillar', c.wall, n.pillar ?? 'pillar'),
      door: role(extra ? 'Sliding Door' : 'Door', ['#6a4a2a', '#3a2a1a'], extra ? 'sliding door' : 'wooden door'),
      chest: role(extra ? 'Supply Locker' : 'Chest', ['#8a5a2a', '#d0a040'], extra ? 'supply locker' : 'treasure chest'),
      exit: role(kind === 'dungeon' ? 'Stairway' : 'Passage', ['#3a3030', '#a09080'], kind === 'dungeon' ? 'stone stairway' : 'passage'),
      shrine: role(extra ? 'Recharge Station' : 'Shrine', ['#c0c0d0', '#80e0ff'], extra ? 'glowing recharge station' : 'ancient shrine'),
      sign: role(extra ? 'Terminal' : 'Signpost', ['#7a5a3a', '#e0d0b0'], extra ? 'info terminal' : 'wooden signpost'),
      lever: role(extra ? 'Control Panel' : 'Lever', ['#6a6a70', '#d04040'], extra ? 'control panel' : 'iron lever'),
      bed: role(extra ? 'Bunk' : 'Bed', ['#7a4a3a', '#d0c0a0'], extra ? 'bunk bed' : 'bed'),
    },
  };
}

/** Deterministic name from syllables. */
export function syllableName(bank: GenreBank, r: () => number): string {
  const p = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const s = bank.syllables;
  return (p(s.start) + (r() < 0.4 ? p(s.mid) : '') + p(s.end)).replace(/\s+/g, ' ').trim();
}
