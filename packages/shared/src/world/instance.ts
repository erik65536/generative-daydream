/** Save-state of a world being played. Many instances can exist per world. */
import type { QuestDef, QuestProgress, Emotion } from '../rules/quests';
import type { MonsterArchetype } from '../rules/actors';
import type { DifficultyId, Modifier } from '../ruleset/types';

/** A concrete item. Mechanics derive from the ruleset base + level + rarity + affixes (+ upgrade). */
export interface ItemInstance {
  id: string;
  baseId: string;
  level: number;
  rarityId: string;
  affixes: { affixId: string; value: number }[];
  qty: number;
  /** Upgrade level (crafting system). */
  upgrade?: number;
  /** World-defined unique item. */
  uniqueId?: string;
  /** Modifiers of a unique item. */
  uniqueMods?: Modifier[];
  /** Quest items can't be sold or dropped. */
  bound?: boolean;
}

export interface ActiveStatus {
  id: string;
  turns: number;
  /** Skill power of the applier (for damage-over-time). */
  power: number;
  sourceId?: string;
}

export type Presentation = 'feminine' | 'masculine' | 'androgynous';

export interface CharacterState {
  id: string;
  name: string;
  classId: string;
  kinId: string;
  presentation: Presentation;
  pronouns: string;
  /** Asset key for the sprite. */
  sprite: string;
  colors: string[];
  level: number;
  xp: number;
  /** Upgrade tree: node id -> rank. */
  tree: Record<string, number>;
  /** Unspent tree points. */
  treePoints: number;
  hotbar: (string | null)[];
  hp: number;
  pools: Record<string, number>;
  /** Temporary health. */
  barrier: number;
  barrierTurns: number;
  statuses: ActiveStatus[];
  /** Slot id -> item. */
  equipment: Record<string, ItemInstance | undefined>;
  cooldowns: Record<string, number>;
  /** Real-time (ms timestamp) cooldowns for out-of-combat skills. */
  realCooldowns?: Record<string, number>;
  downed: boolean;
  /** Set when this character is a recruited NPC. */
  npcId?: string;
  /** NPC companions are AI driven in combat unless the player opts to command them. */
  aiControlled?: boolean;
  /** Combat role used when AI driven. */
  archetype?: MonsterArchetype;
  /** Legacy (pre-ruleset) characters. */
  originId?: string;
}

export interface JournalEntry {
  day: number;
  minute: number;
  kind: 'quest' | 'story' | 'discovery' | 'combat' | 'social' | 'loot' | 'system';
  text: string;
}

export interface ConversationTurn {
  speaker: 'player' | 'npc' | 'narrator';
  text: string;
  emotion?: Emotion;
  day: number;
}

export interface PlayerState {
  userId: string;
  name: string;
  party: CharacterState[];
  leaderId: string;
  gold: number;
  inventory: ItemInstance[];
  zoneId: string;
  x: number;
  y: number;
  quests: Record<string, QuestProgress>;
  /** zoneId -> base64 bitset of explored tiles. */
  explored: Record<string, string>;
  visitedZones: string[];
  knownZones: string[];
  journal: JournalEntry[];
  conversations: Record<string, ConversationTurn[]>;
  /** Summaries of older conversation turns per NPC. */
  conversationSummaries: Record<string, string>;
  lastTownZoneId: string;
  /** Inventory upgrades bought (each adds the ruleset's slotsPerUpgrade). */
  inventoryUpgrades: number;
  revealedTraps: string[];
  /** Arcs whose revelation has been shown. */
  revealedArcs: number[];
  stats: { kills: number; deaths: number; questsCompleted: number; goldEarned: number; trapsDisarmed: number; itemsCrafted: number };
  completedGame?: boolean;
  createdAt: number;
  /** Companions command toggle. */
  commandCompanions: boolean;
}

export interface Memory {
  id: string;
  text: string;
  /** userId of the player it concerns, or 'world'. */
  about: string;
  aboutName?: string;
  importance: number;
  day: number;
  source: 'conversation' | 'witnessed' | 'rumor' | 'event';
  fromNpcId?: string;
  dueDay?: number;
  /** For due memories: has the NPC acted on it yet (per player). */
  fulfilled?: boolean;
  spread?: 'none' | 'household' | 'town' | 'world';
}

export interface NpcRuntime {
  npcId: string;
  zoneId: string;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  hostileTo: string[];
  disposition: Record<string, number>;
  memories: Memory[];
  stock: ItemInstance[];
  stockDay: number;
  /** Unique items held (quest items). */
  inventory: ItemInstance[];
  partyOf?: string;
  gold: number;
  /** Gathering: NPC goes to a place at a time. */
  gathering?: { zoneId: string; x: number; y: number; day: number; reason: string };
  fled?: boolean;
  /** Day this NPC last gave each player a gift (gifts are occasional). */
  giftDay?: Record<string, number>;
  /** Secrets (indexes into the NPC's secrets) already told to each player. */
  secretsTold?: Record<string, number[]>;
}

export interface MonsterRuntime {
  spawnId: string;
  hp: number;
  dead: boolean;
  x: number;
  y: number;
  diedAt?: number;
  /** Legacy: day on which it respawns (non-boss). */
  respawnDay?: number;
  /** Game-clock minute after which it may respawn (non-boss); packs return together once all are due. */
  respawnAt?: number;
  looted?: boolean;
  /** Pack fitting (decided when the pack spawns): left out for a smaller party. */
  absent?: boolean;
  /** Threat multiplier that fits the pack to the party (1 = as designed). */
  scale?: number;
  /** Promoted to elite by the difficulty. */
  elite?: boolean;
  /** An extra member added by the difficulty: the spawn it copies. */
  extraOf?: string;
}

export interface FeatureRuntime {
  opened?: boolean;
  unlocked?: boolean;
  disarmed?: boolean;
  triggered?: boolean;
  toggled?: boolean;
  usedDay?: number;
  /** Loot remaining (chests). */
  loot?: ItemInstance[];
  lootGold?: number;
}

export interface Surface {
  x: number;
  y: number;
  type: string;
  turns: number;
  power: number;
}

export interface LootPile {
  id: string;
  x: number;
  y: number;
  items: ItemInstance[];
  gold: number;
  /** Visible only to this user (personal loot), or everyone if absent. */
  ownerUserId?: string;
  label: string;
  createdAt: number;
  /** The party's remains after a defeat (bag contents to recover). */
  corpse?: boolean;
}

export interface ZoneRuntime {
  zoneId: string;
  monsters: Record<string, MonsterRuntime>;
  features: Record<string, FeatureRuntime>;
  surfaces: Surface[];
  loot: LootPile[];
}

export interface ScheduledEvent {
  id: string;
  day: number;
  kind: 'gathering';
  zoneId: string;
  x: number;
  y: number;
  about: string;
  reason: string;
  npcIds: string[];
  done?: boolean;
}

export interface InstanceState {
  id: string;
  worldId: string;
  ownerId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Game minutes since start. */
  clock: number;
  /** Allow other users to join (experimental multiplayer). */
  open: boolean;
  /** Snapshot instances are hard saves of another instance. */
  snapshotOf?: string;
  players: Record<string, PlayerState>;
  npcs: Record<string, NpcRuntime>;
  zones: Record<string, ZoneRuntime>;
  dynamicQuests: QuestDef[];
  events: ScheduledEvent[];
  /** Shared world rumors (communication level >= 2). */
  rumors: Memory[];
  lastActiveAt: number;
  /** Unique items created during play. */
  dynamicItems?: Record<string, import('./types').UniqueItemDef>;
  difficulty: DifficultyId;
  /** Engine/ruleset version the save was created with. */
  rulesVersion?: number;
}

export interface InstanceSummary {
  id: string;
  worldId: string;
  name: string;
  ownerId: string;
  ownerName?: string;
  updatedAt: number;
  createdAt: number;
  snapshotOf?: string;
  open: boolean;
  day: number;
  players: { userId: string; name: string; level: number; zone: string }[];
  online?: number;
  difficulty: DifficultyId;
  /** Set when the save can't be played with the current engine/rules. */
  incompatible?: string;
}

export interface DamageEvent {
  targetId: string;
  amount: number;
  /** Damage subtype/type id, or 'heal' / 'barrier'. */
  type: string;
  crit?: boolean;
  miss?: boolean;
}
