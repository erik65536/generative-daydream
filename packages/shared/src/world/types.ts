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
}

export type ZoneKind = 'town' | 'wilderness' | 'dungeon' | 'interior';

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
}

export interface OriginFlavor {
  id: string;
  name: string;
  description: string;
  asset?: string;
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
}

/** World data that is safe to send to a client (spoilers removed). */
export type ClientWorld = Omit<WorldDefinition, 'zones' | 'npcs' | 'concept' | 'arcs' | 'quests' | 'ending' | 'generationLog' | 'worldFacts'> & {
  concept: Omit<WorldConcept, 'secret'>;
  zones: Omit<ZoneDef, 'ground' | 'objects' | 'variation' | 'spawns' | 'lore'>[];
  npcs: Pick<NpcDef, 'id' | 'name' | 'title' | 'role' | 'zoneId' | 'asset' | 'colors' | 'pronouns' | 'appearance' | 'archetype'>[];
  arcs: Pick<ArcDef, 'index' | 'title'>[];
};
