/** The saved, pre-generated world. Instances (save states) reference a world by id. */
import type { CombatMode, CommunicationLevel, GameLength, WorldSize } from '../rules/progression';
import type { MonsterArchetype, NpcRole, MerchantKind } from '../rules/actors';
import type { QuestDef } from '../rules/quests';
import type { DifficultyId, Modifier, Ruleset } from '../ruleset/types';

/** Advanced rule choices from the world creation form; anything unset is decided by the generator. */
export interface RulesChoices {
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

export interface WorldInput {
  setting: string;
  story?: string;
  notes?: string;
  size: WorldSize;
  length: GameLength;
  communication: CommunicationLevel;
  combatMode: CombatMode;
  seed?: string;
  /** 'none' skips image generation entirely (procedural art is always available). */
  art: 'none' | 'essential' | 'full';
  rules?: RulesChoices;
  /** Default difficulty for new journeys. */
  difficulty?: DifficultyId;
}

export interface WorldConcept {
  title: string;
  pitch: string;
  genre: string;
  tone: string;
  /** Appended to every image prompt for a consistent look. */
  artStyle: string;
  /** Opening narration shown when a new instance begins. */
  intro: string;
  /** Hidden truth the story builds toward (never sent to clients). */
  secret: string;
  playerRole: string;
  palette: { primary: string; secondary: string; accent: string; ui: string };
}

/** Fixed tile roles. Ground layer codes. */
export const GROUND = { void: 0, floor: 1, floorAlt: 2, path: 3, water: 4, wall: 5 } as const;
export type GroundCode = (typeof GROUND)[keyof typeof GROUND];
/** Object layer codes (static decoration; stateful things are Features). */
export const OBJ = { none: 0, tree: 1, rock: 2, plant: 3, light: 4, furniture: 5, rubble: 6, pillar: 7 } as const;
export type ObjCode = (typeof OBJ)[keyof typeof OBJ];

/**
 * Places designed from a floor plan use their own props and surfaces instead of the fixed roles. Their codes
 * live above the fixed ones: ground codes from SURFACE_BASE are the tileset's extra surfaces (all walkable);
 * object codes encode the prop's index and how it behaves, so movement and sight need no lookup.
 */
export const SURFACE_BASE = 16;
export const MAX_SURFACES = 32;
export const MAX_PROPS = 48;
/** Object code bases: blocks movement and sight / blocks movement only / walkable (rugs, papers, chairs). */
export const PROP_TALL = 16;
export const PROP_SOLID = 64;
export const PROP_LOW = 128;
/** The other tiles of a prop bigger than one tile (drawn by its anchor, the footprint's back corner). */
export const PROP_COVER = 240;
export const PROP_COVER_TALL = 241;

export const isWalkableGround = (g: number) => g === GROUND.floor || g === GROUND.floorAlt || g === GROUND.path || (g >= SURFACE_BASE && g < SURFACE_BASE + MAX_SURFACES);
/** Objects you cannot walk through. */
export const objBlocks = (o: number) => o === OBJ.tree || o === OBJ.rock || o === OBJ.furniture || o === OBJ.pillar || o === OBJ.light || (o >= PROP_TALL && o < PROP_SOLID + MAX_PROPS) || o === PROP_COVER || o === PROP_COVER_TALL;
/** Objects you cannot see past. */
export const objOpaque = (o: number) => o === OBJ.tree || o === OBJ.pillar || (o >= PROP_TALL && o < PROP_TALL + MAX_PROPS) || o === PROP_COVER_TALL;
/** The tileset prop an object code stands for, or -1. */
export function propIndex(o: number): number {
  if (o >= PROP_TALL && o < PROP_TALL + MAX_PROPS) return o - PROP_TALL;
  if (o >= PROP_SOLID && o < PROP_SOLID + MAX_PROPS) return o - PROP_SOLID;
  if (o >= PROP_LOW && o < PROP_LOW + MAX_PROPS) return o - PROP_LOW;
  return -1;
}
export const propCode = (index: number, p: Pick<PropDef, 'blocks' | 'height'>) => (!p.blocks ? PROP_LOW : p.height === 'tall' ? PROP_TALL : PROP_SOLID) + index;

/** A specific thing that stands in a place (a desk, a server rack, a tent), painted once and placed by the plan. */
export interface PropDef {
  id: string;
  name: string;
  /** What it looks like (for the painter). */
  prompt: string;
  colors: string[];
  /** Footprint in tiles (square). */
  size: 1 | 2;
  /** low: below the knee (a chair, a crate); mid: about waist to chest (a desk, a counter); tall: above head height (a rack, a tree). */
  height: 'low' | 'mid' | 'tall';
  /** Whether people must walk around it. */
  blocks: boolean;
  /** Gives off light. */
  light?: boolean;
  asset?: string;
}

/** An extra ground material for one part of a place (the break room's tiles, the lobby's marble). */
export interface GroundDef {
  id: string;
  name: string;
  prompt: string;
  colors: string[];
  asset?: string;
}

/** How copies of a prop are set out within an area. */
export interface BlueprintArrangement {
  prop: string;
  pattern: 'rows' | 'grid' | 'along_walls' | 'around' | 'cluster' | 'scatter' | 'center' | 'corners' | 'line' | 'ring';
  amount: 'few' | 'some' | 'many';
  /** A second prop set beside each copy (chairs at desks, stools around a table). */
  with?: string;
}

/** One part of a place with a purpose (an office, a server room, a campsite). */
export interface BlueprintArea {
  id: string;
  name: string;
  purpose: string;
  /** How many such areas (four identical meeting rooms). */
  count: number;
  size: 'small' | 'medium' | 'large';
  /** A surface id, one of the place's own floor, floorAlt or path, or water (a pond, a pool: impassable). */
  floor: string;
  /** Walled rooms have doorways; open areas are only set apart by their floor and furniture. */
  enclosure: 'walled' | 'open';
  where: 'entrance' | 'center' | 'edge' | 'deep' | 'any';
  arrangements: BlueprintArrangement[];
  /** The enterable building this area holds (its name), in towns. */
  building?: string;
  /** People spend their time here. */
  gathering?: boolean;
}

/** A place's floor plan, designed per place and realised by the engine. */
export interface Blueprint {
  summary: string;
  /** built: rooms and corridors on a grid; natural: organic regions joined by trails. */
  style: 'built' | 'natural';
  /** The ground of corridors, lanes and trails (a surface id or path). */
  corridors: string;
  /** Natural places: what lies between the areas (dense filler, impassable water crossed by causeways, or open ground). */
  between?: 'filler' | 'water' | 'open';
  /** What fills the edge and leftover ground (a prop id), e.g. dense trees around a clearing. */
  filler?: string;
  /** Small walkable props scattered thinly over all the ground (reeds, tufts, pebbles, litter, papers). */
  groundCover?: string[];
  /** Props set along the corridors, lanes or trails (lamps, planters, bins). */
  corridorProps?: BlueprintArrangement[];
  areas: BlueprintArea[];
}

export const TILE_ROLES = ['floor', 'floorAlt', 'path', 'water', 'wall', 'tree', 'rock', 'plant', 'light', 'furniture', 'rubble', 'pillar', 'door', 'chest', 'exit', 'shrine', 'sign', 'lever', 'bed'] as const;
export type TileRole = (typeof TILE_ROLES)[number];

export interface TileRoleDef {
  name: string;
  /** Hex colors used by the procedural renderer (and as an art hint). */
  colors: string[];
  /** Image prompt (without global style) used for generated art. */
  prompt: string;
  /** Asset key once art exists. */
  asset?: string;
}

export interface TilesetDef {
  id: string;
  name: string;
  /** Overall look: drives procedural textures. */
  style: 'grass' | 'stone' | 'sand' | 'snow' | 'dirt' | 'wood' | 'metal' | 'crystal' | 'flesh' | 'void';
  roles: Record<TileRole, TileRoleDef>;
  /** Ambient light 0 (pitch dark) .. 1 (bright day), and fog tint. */
  ambient: number;
  fogColor: string;
  lightColor: string;
  /** Whether the outdoor day/night cycle applies. */
  outdoor: boolean;
  /** Ambient particles. */
  weather?: 'none' | 'rain' | 'snow' | 'ash' | 'spores' | 'embers' | 'dust' | 'fireflies';
  /** Set once the art-direction pass has made every element specific to its place. */
  directed?: boolean;
  /** Elements outside the fixed roles: building roofs (towns) and the crafting station. */
  extras?: { roof?: TileRoleDef; craft?: TileRoleDef };
  /** Specific props and extra surfaces of places built from a floor plan. */
  props?: PropDef[];
  surfaces?: GroundDef[];
}

export type ZoneKind = 'town' | 'wilderness' | 'dungeon' | 'interior';

/**
 * How a zone is laid out, in environment-neutral terms the level designer (the LLM) picks per zone and the
 * engine turns into a map. The art direction then decides what each element looks like in that place.
 */
export interface ZoneLayoutPlan {
  /** open: free-form ground; grid: blocks between straight lanes; hub: a centre with enterable structures around it;
   *  rooms: chambers joined by corridors; caves: irregular connected hollows. */
  structure: 'open' | 'grid' | 'hub' | 'rooms' | 'caves';
  /** Under a roof or ceiling: no sky, day/night, rain or snow. */
  enclosed: boolean;
  /** The large impassable elements (the "tree" role). */
  blockers: { amount: 'sparse' | 'some' | 'dense'; arrangement: 'scattered' | 'clusters' | 'rows' | 'edges' };
  /** Impassable liquid, chasm or void (the "water" role). */
  hazard: 'none' | 'pools' | 'river' | 'channels';
  /** How enterable structures look from outside: roofed buildings, or walled rooms seen from above. */
  structures: 'roofed' | 'walled';
  /** Small walkable or minor clutter (the "rock", "plant" and "rubble" roles). */
  clutter: 'sparse' | 'some' | 'dense';
}

export const LAYOUT_STRUCTURES = ['open', 'grid', 'hub', 'rooms', 'caves'] as const;

export type FeatureKind = 'door' | 'exit' | 'chest' | 'trap' | 'shrine' | 'sign' | 'lever' | 'gate' | 'lore' | 'bed' | 'craft_station' | 'waypoint';

export interface FeatureDef {
  id: string;
  kind: FeatureKind;
  x: number;
  y: number;
  name?: string;
  /** door/exit target. */
  targetZoneId?: string;
  targetFeatureId?: string;
  /** chest */
  lootTier?: number;
  lockLevel?: number;
  keyUniqueId?: string;
  items?: string[];
  /** trap */
  /** Ruleset trap id. */
  trapKind?: string;
  trapLevel?: number;
  /** shrine */
  shrineEffect?: 'heal' | 'empower' | 'restore';
  /** sign / lore */
  text?: string;
  loreId?: string;
  /** lever -> gate ids */
  gateIds?: string[];
  /** Exit direction for edge exits (for nice arrows on the client). */
  facing?: 'n' | 's' | 'e' | 'w';
}

export interface SpawnDef {
  id: string;
  kind: 'monster';
  familyId: string;
  archetype: MonsterArchetype;
  level: number;
  x: number;
  y: number;
  groupId: string;
  bossId?: string;
  elite?: boolean;
}

export interface ZoneDef {
  id: string;
  name: string;
  kind: ZoneKind;
  description: string;
  regionIndex: number;
  levelRange: [number, number];
  tilesetId: string;
  width: number;
  height: number;
  /** Base64-encoded Uint8Array (width*height) of GROUND codes. */
  ground: string;
  /** Base64-encoded Uint8Array (width*height) of OBJ codes. */
  objects: string;
  /** Base64-encoded Uint8Array of per-tile variation seeds (0-255). */
  variation?: string;
  features: FeatureDef[];
  spawns: SpawnDef[];
  /** Interior parent (for buildings). */
  parentZoneId?: string;
  /** Inside a structure (no sky, no day/night, no pitched roofs). */
  indoor?: boolean;
  /** The level design this zone was built from. */
  layout?: ZoneLayoutPlan;
  /** The floor plan this zone was built from (props and surfaces are in its tileset). */
  blueprint?: Blueprint;
  /** Position on the world map (0..1). Interiors share their parent's. */
  mapPos: { x: number; y: number };
  /** Zones directly connected (for the world map). */
  links: string[];
  /** Arrival point when entering without a specific exit. */
  entry: { x: number; y: number };
  /** Town building interiors list their purpose. */
  buildingPurpose?: string;
  /** Hidden flavor used in NPC/LLM context. */
  lore?: string;
  /** Local monster families. */
  familyIds: string[];
}

export interface MonsterMember {
  archetype: MonsterArchetype;
  name: string;
  description: string;
  appearance: string;
  asset?: string;
}

export interface MonsterFamily {
  id: string;
  name: string;
  description: string;
  /** Ruleset damage subtype (or type) the family deals and resists. */
  element: string;
  /** Preferred habitat words, used to place families in matching zones. */
  habitat: string;
  members: MonsterMember[];
  /** Hex color hints for procedural sprites. */
  colors: string[];
}

export interface BossDef {
  id: string;
  name: string;
  title: string;
  description: string;
  familyId: string;
  archetype: MonsterArchetype;
  level: number;
  zoneId: string;
  appearance: string;
  /** Unique item ids dropped on defeat. */
  drops: string[];
  asset?: string;
  /** Spoken when combat begins. */
  taunt?: string;
}

export interface NpcDef {
  id: string;
  name: string;
  title: string;
  role: NpcRole;
  merchantKind?: MerchantKind;
  zoneId: string;
  x: number;
  y: number;
  pronouns: string;
  personality: string;
  appearance: string;
  backstory: string;
  /** Things this NPC knows and may share. */
  knowledge: string[];
  /** Things this NPC knows but hides unless persuaded. Never sent to clients. */
  secrets: string[];
  /** Speaking style. */
  voice: string;
  greeting: string;
  barks: string[];
  level: number;
  archetype: MonsterArchetype;
  canJoinParty: boolean;
  essential: boolean;
  /** Quest ids this NPC can hand out. */
  questIds: string[];
  /** Skills a trainer can teach. */
  teaches?: string[];
  /** Unique items the NPC starts with (quest items to hand over). */
  inventory?: string[];
  /** Other NPC ids this NPC is close to (household/friends) for gossip. */
  relations?: string[];
  faction?: string;
  asset?: string;
  colors: string[];
  /** Wanders around its spawn point. */
  wanders: boolean;
}

export interface UniqueItemDef {
  id: string;
  baseId: string;
  name: string;
  description: string;
  rarityId: string;
  /** Compiled modifiers (priced like a legendary). */
  mods: Modifier[];
  /** Quest items are bound (can't be sold) and weigh nothing. */
  questItem?: boolean;
}

export interface LoreNote {
  id: string;
  title: string;
  text: string;
  arcIndex?: number;
}

export interface ArcDef {
  index: number;
  title: string;
  summary: string;
  /** Narration revealed when the arc completes (twists). */
  revelation: string;
  questIds: string[];
  regionIndex: number;
}

export interface AssetRecord {
  key: string;
  kind: 'texture' | 'sprite' | 'object' | 'icon' | 'portrait';
  file?: string;
  /** Short brief of what to depict. */
  prompt: string;
  /** Full prompt in the image model's preferred style (written by the image.prompt LLM). */
  imagePrompt?: string;
  status: 'pending' | 'ok' | 'failed' | 'skipped';
  score?: number;
  attempts?: number;
  width?: number;
  height?: number;
  /** Anchor (0..1) of the feet within the image for sprites. */
  anchorY?: number;
  error?: string;
  /** Variants (pose frames, an open chest) are painted from this base asset's image. */
  ref?: string;
  /** Which variant this is (walk_a, walk_b, attack, open). */
  variant?: string;
  /** Variant height relative to its base (a lunge is shorter than a standing pose). */
  relHeight?: number;
  /** Animation strips (the walk cycle): number of equal frames side by side. */
  frames?: number;
  /** Art pipeline version that painted it (older art is repainted when the pipeline improves). */
  gen?: number;
  /** Re-roll count: each owner-requested repaint uses fresh seeds. */
  roll?: number;
}

/** The owner's changes to one asset: a custom brief or image prompt, and how often it was re-rolled. */
export interface ArtOverride {
  brief?: string;
  imagePrompt?: string;
  roll?: number;
}

export interface OriginFlavor {
  id: string;
  name: string;
  description: string;
  /** Legacy single sprite (used when no per-presentation sprite exists). */
  asset?: string;
  /** Sprite per chosen presentation. */
  assets?: Partial<Record<'feminine' | 'masculine' | 'androgynous', string>>;
  appearance: string;
}

export interface WorldDefinition {
  id: string;
  formatVersion: number;
  ownerId: string;
  ownerName: string;
  public: boolean;
  createdAt: number;
  updatedAt: number;
  status: 'generating' | 'ready' | 'failed';
  seed: string;
  input: WorldInput;
  concept: WorldConcept;
  /** The world's generated rules (pure data). */
  ruleset: Ruleset;
  /** The intent the ruleset was compiled from (kept so rules can be rebalanced or recompiled). */
  rulesIntent?: unknown;
  maxLevel: number;
  /** Look of each class (id = ruleset class id), used for art. */
  origins: OriginFlavor[];
  uniqueItems: Record<string, UniqueItemDef>;
  families: MonsterFamily[];
  bosses: BossDef[];
  tilesets: Record<string, TilesetDef>;
  zones: ZoneDef[];
  npcs: NpcDef[];
  quests: QuestDef[];
  arcs: ArcDef[];
  finalQuestId: string;
  ending: string;
  lore: LoreNote[];
  assets: Record<string, AssetRecord>;
  startZoneId: string;
  /** Free-form facts the generator decided, fed to NPC prompts. */
  worldFacts: string[];
  factions: { id: string; name: string; description: string }[];
  generationLog?: string[];
  /** Owner edits to asset prompts (keyed by asset key), applied whenever art is planned. */
  artOverrides?: Record<string, ArtOverride>;
}

/** World data that is safe to send to a client (spoilers removed). */
export type ClientWorld = Omit<WorldDefinition, 'zones' | 'npcs' | 'concept' | 'arcs' | 'quests' | 'ending' | 'generationLog' | 'worldFacts'> & {
  concept: Omit<WorldConcept, 'secret'>;
  zones: Omit<ZoneDef, 'ground' | 'objects' | 'variation' | 'spawns' | 'lore'>[];
  npcs: Pick<NpcDef, 'id' | 'name' | 'title' | 'role' | 'zoneId' | 'asset' | 'colors' | 'pronouns' | 'appearance' | 'archetype'>[];
  arcs: Pick<ArcDef, 'index' | 'title'>[];
};
