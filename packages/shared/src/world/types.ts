/** The saved, pre-generated world. Instances (save states) reference a world by id. */
import type { CombatMode, CommunicationLevel, GameLength, WorldSize } from '../rules/progression';
import type { ActorAnim } from './anim';
import type { MonsterArchetype, NpcRole, MerchantKind } from '../rules/actors';
import type { QuestDef } from '../rules/quests';
import type { DifficultyId, Modifier, Ruleset } from '../ruleset/types';
import type { NavDef } from './nav';

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

/** How a place feels to be in: its light, sky and weather (decided with its art direction). */
export interface ZoneLook {
  /** Ambient light: 0 pitch dark .. 1 bright day. */
  ambient: number;
  lightColor: string;
  /** Tint of the fog over unexplored ground. */
  fogColor: string;
  /** Under the open sky: the day/night cycle and weather apply. */
  outdoor: boolean;
  weather: 'none' | 'rain' | 'snow' | 'ash' | 'spores' | 'embers' | 'dust' | 'fireflies';
  /** Asset key of the place's tileable mist (brightness is density): over unexplored ground and past the painting. */
  mist?: string;
  /**
   * The light the painting carries, measured from its pixels: the colour of its lit parts and of its shadows, and
   * its mean brightness (0..1). Characters take it, so they stand in the place's light.
   */
  painted?: { light: string; shade: string; level: number };
}

/** A place painted as one picture of its ground (see nav.ts for the projection). */
export interface Painting {
  /** Asset key of the image, already at game scale. */
  image: string;
  width: number;
  height: number;
  /** Picture position (px) of the ground origin. */
  ox: number;
  oy: number;
}

export type ZoneKind = 'town' | 'wilderness' | 'dungeon' | 'interior';

export type FeatureKind = 'door' | 'exit' | 'chest' | 'trap' | 'sign' | 'lore' | 'bed' | 'craft_station' | 'waypoint' | 'object';

/** Something in a place people interact with. Positions are ground metres. */
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
  /** trap: ruleset trap id and level. */
  trapKind?: string;
  trapLevel?: number;
  /** sign / lore */
  text?: string;
  loreId?: string;
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
  look: ZoneLook;
  /** Ground size in metres (set when painted). */
  width: number;
  height: number;
  /** The picture of the place, and where people can walk and see in it (set when painted). */
  painting?: Painting;
  nav?: NavDef;
  /** The painting's art direction and layout (kept for repaints). */
  design?: { style: string; layout: string };
  features: FeatureDef[];
  spawns: SpawnDef[];
  /** Interior parent (for buildings). */
  parentZoneId?: string;
  /** Inside a structure. */
  indoor?: boolean;
  /** Position on the world map (0..1). Interiors share their parent's. */
  mapPos: { x: number; y: number };
  /** Zones directly connected (for the world map). */
  links: string[];
  /** Arrival point when entering without a specific exit (ground metres). */
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
  kind: 'painting' | 'texture' | 'sprite' | 'object' | 'icon' | 'portrait';
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
  /** A character or creature's animation: its clip sheets are the assets `<key>@anim-<clip>` (see world/anim.ts). */
  anim?: ActorAnim;
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
  zones: Omit<ZoneDef, 'nav' | 'design' | 'spawns' | 'lore'>[];
  npcs: Pick<NpcDef, 'id' | 'name' | 'title' | 'role' | 'zoneId' | 'asset' | 'colors' | 'pronouns' | 'appearance' | 'archetype'>[];
  arcs: Pick<ArcDef, 'index' | 'title'>[];
};
