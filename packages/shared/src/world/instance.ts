/** Save-state of a world being played. Many instances can exist per world. */
import type { AttributeId, StatusId, SurfaceType, DamageType } from '../rules/core';
import type { EquipSlot, ItemInstance } from '../rules/items';
import type { QuestDef, QuestProgress, Emotion } from '../rules/quests';
import type { MonsterArchetype } from '../rules/actors';

export interface ActiveStatus {
  id: StatusId;
  turns: number;
  /** Skill power of the applier (for damage-over-time). */
  power: number;
  sourceId?: string;
}

export interface CharacterState {
  id: string;
  name: string;
  originId: string;
  /** Asset key or origin key for the sprite. */
  sprite: string;
  colors: string[];
  level: number;
  xp: number;
  attributes: Record<AttributeId, number>;
  unspentAttributes: number;
  unspentSkillPoints: number;
  skills: string[];
  hotbar: (string | null)[];
  hp: number;
  stamina: number;
  focus: number;
  physArmor: number;
  magArmor: number;
  statuses: ActiveStatus[];
  equipment: Partial<Record<EquipSlot, ItemInstance>>;
  cooldowns: Record<string, number>;
  /** Real-time (ms timestamp) cooldowns for out-of-combat skills. */
  realCooldowns?: Record<string, number>;
  downed: boolean;
  /** Set when this character is a recruited NPC. */
  npcId?: string;
  /** NPC companions are AI driven in combat unless the player opts to command them. */
  aiControlled?: boolean;
  archetype?: MonsterArchetype;
  pronouns?: string;
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
}

export interface MonsterRuntime {
  spawnId: string;
  hp: number;
  dead: boolean;
  x: number;
  y: number;
  diedAt?: number;
  /** Day on which it respawns (non-boss). */
  respawnDay?: number;
  looted?: boolean;
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
  type: SurfaceType;
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
  keepRunning: boolean;
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
  keepRunning: boolean;
  day: number;
  players: { userId: string; name: string; level: number; zone: string }[];
  online?: number;
}

export interface DamageEvent {
  targetId: string;
  amount: number;
  type: DamageType | 'heal' | 'armor_phys' | 'armor_mag';
  crit?: boolean;
  miss?: boolean;
}
