/** WebSocket protocol between the browser and the authoritative game server. */
import type { ActiveStatus, CharacterState, ItemInstance, JournalEntry, LootPile, PlayerState, Surface, DamageEvent, Presentation } from './world/instance';
import type { ClientWorld, FeatureDef, ZoneDef } from './world/types';
import type { QuestDef, Emotion } from './rules/quests';
import type { MonsterArchetype, NpcRole } from './rules/actors';
import type { DifficultyId } from './ruleset/types';

export interface Motion {
  /** Tile path, starting from the position at `t0`. */
  path: { x: number; y: number }[];
  from: { x: number; y: number };
  /** Tiles per second. */
  speed: number;
  /** Server timestamp (ms) when movement began. */
  t0: number;
}

export type EntityKind = 'character' | 'npc' | 'monster';

export interface EntityView {
  /** Player characters: chosen presentation (procedural figures use it). */
  presentation?: string;
  id: string;
  kind: EntityKind;
  name: string;
  title?: string;
  x: number;
  y: number;
  motion?: Motion;
  facing: number;
  /** Asset key, or empty for procedural art. */
  sprite?: string;
  colors: string[];
  shape: 'humanoid' | 'beast' | 'blob' | 'flyer' | 'hulk';
  scale: number;
  level: number;
  hp: number;
  maxHp: number;
  barrier: number;
  statuses: ActiveStatus[];
  hostile: boolean;
  ownerUserId?: string;
  role?: NpcRole;
  archetype?: MonsterArchetype;
  downed?: boolean;
  dead?: boolean;
  boss?: boolean;
  elite?: boolean;
  /** Visual weapon hint. */
  weapon?: string;
  /** NPC has something for the player (quest marker). */
  marker?: 'quest' | 'turnin' | 'progress' | 'trade';
  inCombat?: string;
  /** NPC bark currently shown. */
  bark?: { text: string; until: number };
  /** Family damage subtype/type id (boss glow, projectiles). */
  element?: string;
}

export interface FeatureState {
  id: string;
  opened?: boolean;
  unlocked?: boolean;
  disarmed?: boolean;
  triggered?: boolean;
  toggled?: boolean;
  /** Traps are only sent when revealed to this player. */
  revealed?: boolean;
  empty?: boolean;
}

export type ZoneView = Omit<ZoneDef, 'spawns' | 'lore' | 'features'> & {
  features: FeatureDef[];
};

export interface CombatantView {
  id: string;
  name: string;
  team: 'players' | 'enemies';
  ap: number;
  maxAp: number;
  initiative: number;
  controllerUserId?: string;
  movementLeft: number;
}

export interface CombatView {
  id: string;
  round: number;
  order: CombatantView[];
  activeId: string;
  turnStartedAt: number;
  /** Seconds a human has before auto end turn (multiplayer only). */
  turnLimit?: number;
}

export interface FxEvent {
  kind: 'damage' | 'skill' | 'projectile' | 'death' | 'text' | 'trap' | 'surface' | 'levelup' | 'loot';
  sourceId?: string;
  targetId?: string;
  x?: number;
  y?: number;
  tx?: number;
  ty?: number;
  skillId?: string;
  fx?: string;
  damage?: DamageEvent;
  text?: string;
  color?: string;
  radius?: number;
  element?: string;
}

export interface DialogMessage {
  speaker: 'player' | 'npc' | 'narrator';
  text: string;
  emotion?: Emotion;
}

export interface DialogState {
  npcId: string;
  npcName: string;
  npcTitle: string;
  sprite?: string;
  colors: string[];
  messages: DialogMessage[];
  thinking: boolean;
  canTrade: boolean;
  disposition: number;
  /** Quick suggestions the player can click. */
  suggestions: string[];
  ended?: boolean;
}

export interface TradeState {
  npcId: string;
  npcName: string;
  stock: (ItemInstance & { price: number })[];
  sellMult: number;
  npcGold: number;
  /** Bag upgrade offered by this merchant (if any left to buy). */
  bagUpgrade?: { cost: number; slots: number };
}

export interface LootView {
  id: string;
  label: string;
  items: ItemInstance[];
  gold: number;
  /** Feature id or loot pile id. */
  sourceKind: 'chest' | 'pile';
}

export interface ClockView {
  minute: number;
  day: number;
  hour: number;
  /** Server time (ms) when sent, for interpolation. */
  at: number;
  paused: boolean;
}

/** Player state with quest definitions resolved (only quests the player knows about). */
export interface PlayerView extends PlayerState {
  questDefs: Record<string, QuestDef>;
  /** Party derived stats are computed on the client with shared rules. */
  loneWolf: boolean;
  /** Quest markers over NPCs for this player. */
  npcMarkers: Record<string, 'quest' | 'turnin' | 'progress'>;
  /** Items created during play (adaptive quests). */
  dynamicItems: Record<string, { name: string; description: string }>;
  /** Visited towns available for fast travel. */
  waypoints: { zoneId: string; name: string }[];
  /** Day/minute of the instance clock. */
  isOwner: boolean;
  difficulty: DifficultyId;
}

export type ServerMessage =
  | { t: 'welcome'; world: ClientWorld; instanceId: string; instanceName: string; userId: string; serverTime: number; open: boolean; isOwner: boolean }
  | { t: 'zone'; zone: ZoneView; entities: EntityView[]; features: FeatureState[]; surfaces: Surface[]; loot: LootPile[]; explored: string }
  | { t: 'entities'; upsert: EntityView[]; remove: string[] }
  | { t: 'features'; features: FeatureState[] }
  | { t: 'surfaces'; surfaces: Surface[] }
  | { t: 'loot_piles'; loot: LootPile[] }
  | { t: 'player'; player: PlayerView }
  | { t: 'combat'; combat: CombatView | null }
  | { t: 'fx'; events: FxEvent[] }
  | { t: 'dialog'; dialog: DialogState | null }
  | { t: 'trade'; trade: TradeState | null }
  | { t: 'loot'; loot: LootView | null }
  | { t: 'clock'; clock: ClockView }
  | { t: 'narration'; title: string; text: string; style?: 'intro' | 'arc' | 'ending' | 'quest' | 'death' }
  | { t: 'toast'; text: string; kind?: 'info' | 'good' | 'bad' | 'quest' | 'loot' }
  | { t: 'journal'; entry: JournalEntry }
  | { t: 'log'; text: string; color?: string }
  | { t: 'chat'; from: string; text: string }
  | { t: 'saved'; instanceId: string; name: string }
  | { t: 'error'; message: string }
  | { t: 'pong'; serverTime: number; clientTime: number };

export type ClientMessage =
  | { t: 'join'; instanceId: string }
  | { t: 'ping'; clientTime: number }
  | { t: 'move'; x: number; y: number; charId?: string }
  /** `inspect` opens the loot window instead of taking everything. */
  | { t: 'interact'; targetId: string; charId?: string; inspect?: boolean }
  | { t: 'talk'; npcId: string; text: string; giveItemId?: string; giveGold?: number; useSkillId?: string }
  | { t: 'end_dialog' }
  /** Ask the NPC in the current conversation to trade: the shop opens at once, the reply follows. */
  | { t: 'request_trade' }
  | { t: 'use_skill'; charId: string; skillId: string; targetId?: string; x?: number; y?: number }
  | { t: 'use_item'; charId: string; itemId: string; targetId?: string; x?: number; y?: number }
  | { t: 'equip'; charId: string; itemId: string }
  | { t: 'unequip'; charId: string; slot: string }
  | { t: 'drop_item'; itemId: string; qty?: number }
  | { t: 'end_turn' }
  | { t: 'flee' }
  | { t: 'buy'; npcId: string; itemId: string; qty?: number }
  | { t: 'sell'; npcId: string; itemId: string; qty?: number }
  | { t: 'end_trade' }
  | { t: 'craft'; recipeId: string; charId?: string }
  | { t: 'take_loot'; sourceId: string; itemId?: string; all?: boolean }
  | { t: 'close_loot' }
  /** Spend a tree point on a node. */
  | { t: 'allocate'; charId: string; nodeId: string }
  | { t: 'upgrade_item'; itemId: string; charId?: string }
  | { t: 'enchant_item'; itemId: string; affixIndex: number; charId?: string }
  | { t: 'buy_inventory_upgrade'; npcId: string }
  | { t: 'set_difficulty'; difficulty: DifficultyId }
  | { t: 'set_hotbar'; charId: string; hotbar: (string | null)[] }
  | { t: 'set_leader'; charId: string }
  | { t: 'rest' }
  | { t: 'fast_travel'; zoneId: string }
  | { t: 'hard_save'; name: string }
  | { t: 'set_options'; open?: boolean; commandCompanions?: boolean }
  | { t: 'abandon_quest'; questId: string }
  | { t: 'pin_quest'; questId: string }
  /**
   * Controller walking: keep moving the leader this way (tile units; 0,0 stops). x,y is where the player's own
   * screen has the leader: the server takes it (the walker's view decides), so stopping never snaps back.
   */
  | { t: 'steer'; dx: number; dy: number; x?: number; y?: number }
  | { t: 'dismiss_companion'; charId: string }
  /** Developer options (admins only): go anywhere, see the whole map, reload the daydream after editing it. */
  | { t: 'dev'; action: 'goto'; zoneId: string; x?: number; y?: number }
  | { t: 'dev'; action: 'reveal' }
  | { t: 'dev'; action: 'peace'; on: boolean }
  | { t: 'dev'; action: 'reload' }
  | { t: 'chat'; text: string };

/** Character creation choices. */
export interface CharacterSpec {
  name: string;
  classId: string;
  kinId: string;
  presentation: Presentation;
  pronouns: string;
  sprite?: string;
  colors?: string[];
}

export type { CharacterState };
