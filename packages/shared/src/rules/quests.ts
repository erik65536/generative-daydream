/** Fixed quest objective vocabulary and the closed set of actions NPCs may take. */
import type { MonsterArchetype } from './actors';

export const OBJECTIVE_TYPES = ['talk', 'kill', 'kill_unique', 'collect', 'deliver', 'reach', 'interact', 'disarm', 'craft', 'persuade'] as const;
export type ObjectiveType = (typeof OBJECTIVE_TYPES)[number];

export interface QuestObjective {
  id: string;
  type: ObjectiveType;
  description: string;
  /** talk / deliver / persuade target. */
  npcId?: string;
  /** kill: monster family (any member) and/or archetype, optionally limited to a zone. */
  familyId?: string;
  archetype?: MonsterArchetype;
  /** kill_unique: boss id or NPC id. */
  targetId?: string;
  /** collect / deliver: unique (world-defined) item or base item. */
  itemUniqueId?: string;
  baseId?: string;
  /** reach / kill scope. */
  zoneId?: string;
  /** interact: feature id within a zone. */
  featureId?: string;
  count?: number;
  /** Hidden until all previous objectives are complete. */
  hidden?: boolean;
  optional?: boolean;
}

export interface QuestReward {
  xp: number;
  gold: number;
  /** Unique item ids or base item ids (base items are rolled at quest level). */
  items: string[];
}

export interface QuestDef {
  id: string;
  title: string;
  summary: string;
  main: boolean;
  arcIndex?: number;
  level: number;
  giverNpcId?: string;
  turnInNpcId?: string;
  zoneId?: string;
  objectives: QuestObjective[];
  rewards: QuestReward;
  prerequisites: string[];
  /** Started automatically when prerequisites complete (e.g. the opening main quest). */
  autoStart?: boolean;
  completionText?: string;
  /** Unique item ids handed to the player when the quest starts (e.g. a letter to deliver). */
  grantsOnStart?: string[];
  /** True for quests created during play. */
  dynamic?: boolean;
}

export type QuestStatus = 'active' | 'completed' | 'failed';

export interface ObjectiveProgress {
  progress: number;
  done: boolean;
}

export interface QuestProgress {
  questId: string;
  status: QuestStatus;
  objectives: Record<string, ObjectiveProgress>;
  /** Objectives replaced or added during play (adaptive quests). */
  overrides?: QuestObjective[];
  /** Short log lines, newest last. */
  log: { day: number; text: string }[];
  startedDay: number;
}

/** The closed set of NPC actions. The LLM chooses among these; the engine executes them. */
export const NPC_ACTIONS = [
  'none', 'give_item', 'give_gold', 'accept_gift', 'refuse_gift', 'offer_quest', 'complete_objective', 'modify_objective',
  'add_objective', 'complete_quest', 'fail_quest', 'open_trade', 'attack', 'change_disposition',
  'remember', 'reveal_location', 'teach_skill', 'create_quest', 'end_conversation', 'flee', 'call_guards',
  'give_gift', 'share_secret', 'share_lead',
] as const;
export type NpcActionType = (typeof NPC_ACTIONS)[number];

export const NPC_ACTION_INFO: Record<NpcActionType, string> = {
  none: 'Only speak; take no other action.',
  give_item: 'Give the player an item you own (itemRef = one of your item refs).',
  give_gold: 'Give the player some currency (amount).',
  accept_gift: 'Accept the item or currency the player is offering you.',
  refuse_gift: 'Refuse the item or currency the player is offering you.',
  offer_quest: 'Give the player one of your available quests (questId).',
  complete_objective: 'Mark an objective of an active quest as done because of this conversation (questId, objectiveId). Use for persuasion or when the player genuinely satisfied it.',
  modify_objective: 'Change an objective of an active quest because circumstances changed (questId, objectiveId, newObjective).',
  add_objective: 'Add a new objective to an active quest (questId, newObjective).',
  complete_quest: 'Complete an active quest you are involved with and grant its reward (questId).',
  fail_quest: 'Fail an active quest because of what the player did or said (questId).',
  open_trade: 'Open your shop so the player can buy and sell.',
  attack: 'Become hostile and start a fight.',
  change_disposition: 'Change how much you like the player (amount from -25 to 25).',
  remember: 'Remember a fact for later (memory). Optionally due in N days and whether it spreads to others (spread).',
  reveal_location: 'Tell the player where a place is so it appears on their map (zoneId).',
  teach_skill: 'Teach the player a skill you know (skillId).',
  create_quest: 'Create a brand-new small quest for the player (newQuest).',
  end_conversation: 'End the conversation.',
  flee: 'Run away from the player.',
  call_guards: 'Call the guards on the player.',
  give_gift: 'Give the player something useful you can spare (gift: supplies, gear, material or keepsake).',
  share_secret: 'Tell the player one of your secrets (secretRef); it goes in their journal.',
  share_lead: 'Tell the player something important they should act on: a rumour, a warning, where to look (lead: one sentence for their journal).',
};

export const NPC_GIFTS = ['supplies', 'gear', 'material', 'keepsake'] as const;
export type NpcGift = (typeof NPC_GIFTS)[number];

export interface NewObjectiveSpec {
  type: ObjectiveType;
  description: string;
  /** Target reference: npc id, family id, item ref, zone id or feature id depending on type. */
  target?: string;
  count?: number;
}

export interface NpcAction {
  type: NpcActionType;
  questId?: string;
  objectiveId?: string;
  itemRef?: string;
  amount?: number;
  zoneId?: string;
  skillId?: string;
  memory?: string;
  dueInDays?: number;
  spread?: 'none' | 'household' | 'town' | 'world';
  gathering?: boolean;
  newObjective?: NewObjectiveSpec;
  newQuest?: { title: string; summary: string; objectives: NewObjectiveSpec[]; rewardGold?: number };
  gift?: NpcGift;
  secretRef?: string;
  lead?: string;
}

export const EMOTIONS = ['neutral', 'happy', 'amused', 'sad', 'angry', 'afraid', 'surprised', 'suspicious', 'grateful', 'thoughtful'] as const;
export type Emotion = (typeof EMOTIONS)[number];
