/**
 * NPC conversations. Each player turn asks the decision model to choose from a closed set of actions
 * (with ids constrained by dynamic enums) and to speak; the engine validates and executes the actions.
 * Without a model, a rule-based "procedural brain" keeps NPCs useful and quests completable.
 */
import { z } from 'zod';
import {
  EMOTIONS, NPC_ACTION_INFO, NPC_GIFTS, OBJECTIVE_TYPES, rx, uid, type NpcGift, type JournalEntry,
  type DialogMessage, type DialogState, type Emotion, type ItemInstance, type Memory, type NpcAction, type NpcActionType, type NpcDef, type NpcRuntime,
  type PlayerState, type QuestDef, type QuestObjective, type ZoneDef, type NewObjectiveSpec,
} from '@gd/shared';
import { genai } from '../genai/service';
import type { DecisionQuestion } from '../genai/types';
import { currentObjectiveIndex, objectivesOf, type QuestEngine } from './quests';
import type { WorldCtx } from './worldctx';

/** A recruitable person's starting feeling toward the player ("friendly"), and the feeling at which they agree to come along. */
const RECRUIT_START = 30;
const JOIN_AT = 15;
/** The player asks someone to come along. */
const ASKS_TO_JOIN = /\b(join (me|us|my|our)|travel with|come with (me|us)|come along|be my companion|companion|join (the|my|our) (party|team|group|crew|squad)|team up|adventure together|tag along|fight (with|alongside) (me|us))/i;

export interface DialogueHost {
  ctx: WorldCtx;
  quests: QuestEngine;
  day(): number;
  timeOfDay(): string;
  player(userId: string): PlayerState | undefined;
  npcRt(npcId: string): NpcRuntime | undefined;
  sendDialog(userId: string, d: DialogState | null): void;
  openTrade(userId: string, npcId: string): void;
  npcAttack(npcId: string, userId: string): void;
  callGuards(npcId: string, userId: string): void;
  npcFlee(npcId: string, userId: string): void;
  joinParty(userId: string, npcId: string): string | null;
  leaveParty(userId: string, npcId: string): void;
  healParty(userId: string): void;
  giveItemsToPlayer(userId: string, items: ItemInstance[]): void;
  takeItemFromPlayer(userId: string, itemId: string): ItemInstance | null;
  revealZone(userId: string, zoneId: string): boolean;
  teachSkill(userId: string, skillId: string, price: number): string | null;
  /** Skills a trainer could teach this player's leader right now. */
  teachableSkills(userId: string): string[];
  remember(npcId: string, mem: Memory): void;
  scheduleGathering(npcId: string, about: string, day: number, reason: string): void;
  playerChanged(p: PlayerState): void;
  journal(p: PlayerState, kind: JournalEntry['kind'], text: string): void;
  /** Something an NPC can spare, made at the party's level ("within reason": modest rarity). */
  rollGift(userId: string, kind: NpcGift, generous: boolean): ItemInstance | null;
  grantXp(userId: string, amount: number): void;
  partySummary(userId: string): string;
  communication(): 0 | 1 | 2 | 3;
  dynamicQuest(def: QuestDef): void;
  questDef(id: string): QuestDef | undefined;
  createDynamicItem(name: string, description: string, nearZoneId: string): string;
  spendLeaderResource(userId: string, skillId: string): string | null;
  /** Mechanical result of a harmful skill used on an NPC. */
  hostileSkill(userId: string, npcId: string, skillId: string): void;
}

type TurnInput = { text: string; offered?: ItemInstance; gold?: number; skillId?: string; event?: string };

interface Session {
  npcId: string;
  messages: DialogMessage[];
  thinking: boolean;
  ended: boolean;
}

const MAX_HISTORY = 24;
/** Days between gifts from the same person, and the feeling they need toward the player to give one unprompted. */
const GIFT_EVERY_DAYS = 3;
const GIFT_AT = 20;

export class DialogueEngine {
  private sessions = new Map<string, Session>();
  constructor(private h: DialogueHost) {}

  session(userId: string) {
    return this.sessions.get(userId);
  }

  private npc(npcId: string): NpcDef | undefined {
    return this.h.ctx.npcs.get(npcId);
  }

  disposition(rt: NpcRuntime, userId: string) {
    // People who could travel with the player were written as companions: they start out well disposed.
    return rt.disposition[userId] ?? (this.recruitable(rt) ? RECRUIT_START : 0);
  }

  private send(userId: string) {
    const s = this.sessions.get(userId);
    if (!s) return this.h.sendDialog(userId, null);
    const def = this.npc(s.npcId)!;
    const rt = this.h.npcRt(s.npcId)!;
    this.h.sendDialog(userId, {
      npcId: s.npcId,
      npcName: def.name,
      npcTitle: def.title,
      sprite: def.asset,
      colors: def.colors,
      messages: s.messages.slice(-40),
      thinking: s.thinking,
      canTrade: def.role === 'merchant' || def.role === 'innkeeper' || def.role === 'crafter',
      disposition: this.disposition(rt, userId),
      suggestions: this.suggestions(userId, def, rt),
      ended: s.ended,
    });
  }

  /** Add a narrator line to an open conversation. Returns false if none is open. */
  note(userId: string, text: string): boolean {
    const s = this.sessions.get(userId);
    if (!s) return false;
    s.messages.push({ speaker: 'narrator', text });
    this.send(userId);
    return true;
  }

  close(userId: string) {
    this.sessions.delete(userId);
    this.h.sendDialog(userId, null);
  }

  private record(p: PlayerState, npcId: string, speaker: 'player' | 'npc' | 'narrator', text: string, emotion?: Emotion) {
    const list = (p.conversations[npcId] ??= []);
    list.push({ speaker, text, emotion, day: this.h.day() });
    if (list.length > MAX_HISTORY) {
      const old = list.splice(0, list.length - MAX_HISTORY);
      const summary = old.filter((t) => t.speaker !== 'narrator').map((t) => `${t.speaker === 'player' ? p.name : 'I'}: ${t.text}`).join(' ');
      p.conversationSummaries[npcId] = `${p.conversationSummaries[npcId] ?? ''} ${summary}`.slice(-1500);
    }
  }

  /** Quests this NPC can give the player now. */
  availableQuests(p: PlayerState, def: NpcDef): QuestDef[] {
    return def.questIds
      .map((id) => this.h.questDef(id))
      .filter((q): q is QuestDef => !!q && !q.autoStart && !p.quests[q.id] && q.prerequisites.every((r) => p.quests[r]?.status === 'completed'));
  }

  /** Active quests where this NPC is the giver, turn-in or an objective target. */
  involvedQuests(p: PlayerState, npcId: string): { def: QuestDef; objectives: QuestObjective[]; current: number }[] {
    const out: { def: QuestDef; objectives: QuestObjective[]; current: number }[] = [];
    for (const [qid, prog] of Object.entries(p.quests)) {
      if (prog.status !== 'active') continue;
      const def = this.h.questDef(qid);
      if (!def) continue;
      const objectives = objectivesOf(def, prog);
      if (def.giverNpcId === npcId || def.turnInNpcId === npcId || objectives.some((o) => o.npcId === npcId)) out.push({ def, objectives, current: currentObjectiveIndex(def, prog) });
    }
    return out;
  }

  /** Trainers teach skills of the player's own class that the leader is ready for. */
  private teachList(def: NpcDef, p: PlayerState): string[] {
    return def.role === 'trainer' ? this.h.teachableSkills(p.userId) : [];
  }

  private suggestions(userId: string, def: NpcDef, rt: NpcRuntime): string[] {
    const p = this.h.player(userId);
    if (!p) return [];
    const out: string[] = [];
    if (this.availableQuests(p, def).length) out.push('Is there anything I can help with?');
    const involved = this.involvedQuests(p, def.id);
    const persuade = involved.flatMap((q) => q.objectives.filter((o, i) => i === q.current && o.type === 'persuade' && o.npcId === def.id));
    if (persuade[0]) out.push(`About ${persuade[0].description.toLowerCase().replace(/^persuade\s+\S+\s+(to\s+)?/, '')}...`.slice(0, 80));
    if (def.role === 'innkeeper') out.push('I need a room for the night.');
    if (this.teachList(def, p).length) out.push('Can you teach me something?');
    if (def.canJoinParty && !rt.partyOf) out.push('Would you travel with me?');
    if (rt.partyOf === userId) out.push('It is time we parted ways.');
    out.push(`What's the news around here?`);
    out.push('Farewell.');
    return out.slice(0, 5);
  }

  // ------------------------------------------------------------------ opening

  async open(userId: string, npcId: string) {
    const p = this.h.player(userId);
    const def = this.npc(npcId);
    const rt = this.h.npcRt(npcId);
    if (!p || !def || !rt) return;
    const s: Session = { npcId, messages: [], thinking: false, ended: false };
    this.sessions.set(userId, s);
    // Recent history so the conversation feels continuous.
    for (const t of (p.conversations[npcId] ?? []).slice(-6)) s.messages.push({ speaker: t.speaker, text: t.text, emotion: t.emotion });
    const events: string[] = [];
    if (this.h.quests.onTalk(p, npcId)) events.push('The player came to speak with you as part of a task they are doing.');
    for (const d of this.h.quests.tryDeliver(p, npcId)) {
      const names = d.items.map((i) => this.h.ctx.itemName(i)).join(', ');
      s.messages.push({ speaker: 'narrator', text: `You hand over ${names}.` });
      this.record(p, npcId, 'narrator', `Handed over ${names}.`);
      events.push(`The player just handed you ${names}, as requested.`);
      rt.inventory.push(...d.items);
    }
    const due = rt.memories.filter((m) => m.about === userId && m.dueDay !== undefined && m.dueDay <= this.h.day() && !m.fulfilled);
    for (const m of due) {
      m.fulfilled = true;
      events.push(`Today is the day you remembered: "${m.text}". Bring it up warmly and naturally.`);
    }
    const firstMeeting = !(p.conversations[npcId]?.length);
    if (events.length || (firstMeeting && !def.greeting)) {
      s.thinking = true;
      this.send(userId);
      await this.turn(userId, { text: '', event: events.join(' ') || 'The player approaches you for the first time.' });
      return;
    }
    const line = firstMeeting ? def.greeting : this.returnGreeting(def, rt, p);
    s.messages.push({ speaker: 'npc', text: line, emotion: 'neutral' });
    this.record(p, npcId, 'npc', line, 'neutral');
    this.send(userId);
  }

  private returnGreeting(def: NpcDef, rt: NpcRuntime, p: PlayerState): string {
    const disp = this.disposition(rt, p.userId);
    const name = p.name;
    const pool =
      disp > 40 ? [`${name}! Always good to see you.`, `There you are, ${name}. What do you need, friend?`]
      : disp < -30 ? ['You again.', 'What do you want now?', `Make it quick, ${name}.`]
      : [`Back again, ${name}?`, 'Yes?', `Hello again, ${name}.`, 'What can I do for you?'];
    return pool[(this.h.day() + def.name.length) % pool.length]!;
  }

  // ------------------------------------------------------------------ trade

  /** The Trade button: open the shop straight away (no model call, no reply). */
  requestTrade(userId: string) {
    const s = this.sessions.get(userId);
    const p = this.h.player(userId);
    if (!s || !p || s.thinking) return;
    const def = this.npc(s.npcId)!;
    if (!(def.role === 'merchant' || def.role === 'innkeeper' || def.role === 'crafter')) return;
    this.h.openTrade(userId, s.npcId);
  }

  // ------------------------------------------------------------------ turns

  async say(userId: string, text: string, opts: { giveItemId?: string; giveGold?: number; useSkillId?: string } = {}) {
    const s = this.sessions.get(userId);
    const p = this.h.player(userId);
    if (!s || !p || s.thinking) return;
    const clean = text.trim().slice(0, 600);
    let offered: ItemInstance | undefined;
    if (opts.giveItemId) offered = p.inventory.find((i) => i.id === opts.giveItemId);
    const gold = Math.max(0, Math.min(p.gold, Math.floor(opts.giveGold ?? 0)));
    const parts: string[] = [];
    if (offered) parts.push(`(offers ${this.h.ctx.itemName(offered)})`);
    if (gold) parts.push(`(offers ${gold} ${this.h.ctx.r.terminology.currency})`);
    if (opts.useSkillId) {
      const err = this.h.spendLeaderResource(userId, opts.useSkillId);
      if (err) {
        s.messages.push({ speaker: 'narrator', text: err });
        this.send(userId);
        return;
      }
      parts.push(`(uses ${this.h.ctx.skillName(opts.useSkillId)})`);
      const sk = rx(this.h.ctx.r).skill.get(opts.useSkillId);
      if (sk?.effects.some((e) => e.kind === 'damage')) {
        s.messages.push({ speaker: 'player', text: `${parts.join(' ')} ${clean}`.trim() });
        this.record(p, s.npcId, 'player', `${parts.join(' ')} ${clean}`.trim());
        this.h.hostileSkill(userId, s.npcId, opts.useSkillId);
        this.close(userId);
        return;
      }
    }
    const shown = `${parts.join(' ')} ${clean}`.trim();
    if (!shown) return;
    s.messages.push({ speaker: 'player', text: shown });
    this.record(p, s.npcId, 'player', shown);
    s.thinking = true;
    this.send(userId);
    await this.turn(userId, { text: clean, offered, gold, skillId: opts.useSkillId });
  }

  private async turn(userId: string, input: TurnInput) {
    const s = this.sessions.get(userId);
    const p = this.h.player(userId);
    if (!s || !p) return;
    const def = this.npc(s.npcId)!;
    const rt = this.h.npcRt(s.npcId)!;
    let decision: { actions: NpcAction[]; emotion: Emotion; speech: string; needsSpeech?: boolean };
    const g = genai();
    try {
      if (g.isProcedural('npc.decision')) throw new Error('procedural');
      decision = g.isDecision('npc.decision') ? await this.decisionModelTurn(userId, p, def, rt, input) : await this.llmDecision(userId, p, def, rt, input);
    } catch (e) {
      if ((e as Error).message !== 'procedural') console.warn('[dialogue] model failed, using procedural brain:', (e as Error).message);
      decision = this.proceduralDecision(userId, p, def, rt, input);
    }
    if (!this.sessions.has(userId)) return;
    const narration = this.execute(userId, p, def, rt, decision.actions, input);
    // Optional separate speech model.
    let speech = decision.speech;
    if ((decision.needsSpeech || !g.config.combineNpcDecisionAndDialogue) && !g.isProcedural('npc.dialogue')) {
      try {
        speech = await g.text('npc.dialogue', {
          system: this.persona(p, def, rt),
          messages: [{ role: 'user', content: `${this.transcript(p, def)}\n\n${input.text ? `${p.name} just said: "${input.text}"\n` : ''}${input.event ? `[SITUATION: ${input.event}]\n` : ''}You decided to: ${decision.actions.map((a) => NPC_ACTION_INFO[a.type]).join(' ') || 'just talk'} You feel ${decision.emotion}. ${narration.join(' ')}\nWrite only what ${def.name} says now (1-4 sentences, in character, no quotation marks).` }],
          maxTokens: 300,
        });
      } catch {
        /* keep decision speech */
      }
    }
    speech = sanitizeSpeech(speech, def.name);
    s.thinking = false;
    if (speech) {
      s.messages.push({ speaker: 'npc', text: speech, emotion: decision.emotion });
      this.record(p, s.npcId, 'npc', speech, decision.emotion);
    }
    for (const n of narration) {
      s.messages.push({ speaker: 'narrator', text: n });
      this.record(p, s.npcId, 'narrator', n);
    }
    if (decision.actions.some((a) => a.type === 'end_conversation' || a.type === 'attack' || a.type === 'flee' || a.type === 'call_guards')) s.ended = true;
    this.send(userId);
    if (decision.actions.some((a) => a.type === 'open_trade')) this.h.openTrade(userId, s.npcId);
    this.h.playerChanged(p);
  }

  /** Could join the player's party now (a companion in a world played with recruited companions). */
  private recruitable(rt: NpcRuntime): boolean {
    const def = this.h.ctx.npcs.get(rt.npcId);
    return !!def?.canJoinParty && !rt.partyOf && this.h.ctx.world.input.combatMode === 'party_npc';
  }

  /**
   * The player asks a recruitable person who likes them to come along: they say yes. The decision is made here
   * so the spoken reply (written to match the decision) and the outcome agree.
   */
  private acceptsJoin(p: PlayerState, def: NpcDef, rt: NpcRuntime, text: string): boolean {
    return !!text && this.recruitable(rt) && def.canJoinParty && ASKS_TO_JOIN.test(text) && this.disposition(rt, p.userId) >= JOIN_AT;
  }

  // ------------------------------------------------------------------ LLM decision

  private persona(p: PlayerState, def: NpcDef, rt: NpcRuntime): string {
    const w = this.h.ctx.world;
    const zone: ZoneDef | undefined = this.h.ctx.zones.get(rt.zoneId);
    const outer = zone?.parentZoneId ? this.h.ctx.zones.get(zone.parentZoneId) : zone;
    const disp = this.disposition(rt, p.userId);
    const mems = rt.memories.filter((m) => m.about === p.userId || m.about === 'world').slice(-12);
    const label = disp > 60 ? 'deep trust and affection' : disp > 25 ? 'friendly' : disp > -10 ? 'neutral, still forming an opinion' : disp > -40 ? 'wary and unfriendly' : 'hostile and contemptuous';
    return [
      `You are ${def.name}, ${def.title}, a character in "${w.concept.title}". ${w.concept.pitch}`,
      `Tone of the world: ${w.concept.tone}.`,
      `YOU (${def.pronouns}): personality — ${def.personality}. Voice — ${def.voice}. Backstory — ${def.backstory}${def.faction ? ` Faction: ${def.faction}.` : ''}`,
      `You are in ${zone?.name ?? 'town'}${outer && outer !== zone ? `, in ${outer.name}` : ''}: ${outer?.description ?? ''} It is ${this.h.timeOfDay()} on day ${this.h.day()}.`,
      def.knowledge.length ? `Things you know and may share when relevant:\n${def.knowledge.map((k) => `- ${k}`).join('\n')}` : '',
      def.secrets.length ? `Secrets you keep (reveal only if the player earns real trust or truly persuades you):\n${def.secrets.map((k) => `- ${k}`).join('\n')}` : '',
      `World facts you might know:\n${w.worldFacts.slice(0, 6).map((f) => `- ${f}`).join('\n')}`,
      mems.length ? `What you remember:\n${mems.map((m) => `- ${m.source === 'rumor' ? `(heard from ${this.npc(m.fromNpcId ?? '')?.name ?? 'someone'}) ` : ''}${m.text}${m.dueDay !== undefined ? ` (day ${m.dueDay})` : ''}`).join('\n')}` : '',
      `Your feelings toward ${p.name}: ${label}.`,
      `How to behave: stay fully in character and speak as ${def.name} would — natural dialogue, 1-4 sentences unless asked for detail. React to exactly what the player says and does; you can be charmed, persuaded, offended, fooled or unimpressed like a real person with your personality. Never mention being an AI, game mechanics, JSON, ids or numbers.`,
      `Make talking to you worth it. You have a life, worries and things you know; when the conversation earns it, act on them the way a real person would, through the actions you are offered each turn, and say it in your own words. Do not hand out things to strangers who have done nothing; small talk can stay small talk.`,
      `How you feel about ${p.name} is never said as a label or number: show it in tone, in what you share and in what you will do for them.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private transcript(p: PlayerState, def: NpcDef): string {
    const hist = (p.conversations[def.id] ?? []).slice(-14);
    const summary = p.conversationSummaries[def.id];
    return [summary ? `Earlier conversations (summary): ${summary.slice(-800)}` : '', 'Conversation so far:', ...hist.map((t) => (t.speaker === 'player' ? `${p.name}: ${t.text}` : t.speaker === 'npc' ? `${def.name}: ${t.text}` : `[${t.text}]`))]
      .filter(Boolean)
      .join('\n');
  }

  /** Everything the NPC may know and do this turn; shared by the LLM and decision-model paths. */
  private turnContext(userId: string, p: PlayerState, def: NpcDef, rt: NpcRuntime, input: TurnInput) {
    const w = this.h.ctx.world;
    const available = this.availableQuests(p, def);
    const involved = this.involvedQuests(p, def.id);
    const npcItems = rt.inventory;
    const knownZones = this.knownZones(def, rt);
    const allowed: NpcActionType[] = ['none', 'remember', 'change_disposition', 'end_conversation', 'attack', 'flee'];
    if (input.offered || input.gold) allowed.push('accept_gift', 'refuse_gift');
    if (available.length) allowed.push('offer_quest');
    if (involved.length) allowed.push('complete_objective', 'modify_objective', 'add_objective', 'complete_quest', 'fail_quest');
    if (npcItems.length) allowed.push('give_item');
    if (rt.gold > 0) allowed.push('give_gold');
    if (def.role === 'merchant' || def.role === 'innkeeper' || def.role === 'crafter') allowed.push('open_trade');
    if (this.teachList(def, p).length) allowed.push('teach_skill');
    if (def.canJoinParty && !rt.partyOf) allowed.push('join_party');
    if (rt.partyOf === userId) allowed.push('leave_party');
    if (def.role === 'innkeeper' || def.role === 'mystic' || def.role === 'trainer') allowed.push('heal_player');
    if (knownZones.length) allowed.push('reveal_location');
    if (this.h.ctx.r.systems.dynamicQuests) allowed.push('create_quest');
    if (def.role !== 'guard' && this.h.ctx.townOf(rt.zoneId)) allowed.push('call_guards');
    const gift = this.canGift(rt, userId);
    if (gift) allowed.push('give_gift');
    const untold = this.untoldSecrets(def, rt, userId);
    if (untold.length) allowed.push('share_secret');
    allowed.push('share_lead');
    const lines: string[] = [];
    lines.push(`THE PLAYER: ${this.h.partySummary(userId)}`);
    if (available.length) lines.push(`QUESTS YOU COULD OFFER (use offer_quest with questId when it fits the conversation, e.g. they ask for work or help):\n${available.map((q) => `- ${q.id}: "${q.title}" — ${q.summary}`).join('\n')}`);
    if (involved.length)
      lines.push(
        `ACTIVE QUESTS INVOLVING YOU:\n${involved
          .map((q) => `- ${q.def.id} "${q.def.title}" — ${q.def.summary}\n${q.objectives.map((o, i) => `   ${o.id} [${p.quests[q.def.id]!.objectives[o.id]?.done ? 'done' : i === q.current ? 'CURRENT' : 'later'}] (${o.type}) ${o.description}`).join('\n')}`)
          .join('\n')}\nUse complete_objective only for a CURRENT objective this conversation genuinely satisfies (e.g. a "persuade" objective when the player made a convincing case). Use modify_objective/add_objective if the story should change because of what the player said or did. Be skeptical of unproven claims.`,
      );
    if (npcItems.length) lines.push(`ITEMS YOU HAVE (give_item with itemRef):\n${npcItems.map((it, i) => `- item${i}: ${this.h.ctx.itemName(it)} — ${this.h.ctx.itemDescription(it)}`).join('\n')}`);
    if (this.teachList(def, p).length) lines.push(`SKILLS YOU CAN TEACH for ${this.teachPrice(p)} ${this.h.ctx.r.terminology.currency} (teach_skill with skillId):\n${this.teachList(def, p).map((sk) => `- ${sk}: ${this.h.ctx.skillName(sk)} — ${rx(this.h.ctx.r).skill.get(sk)?.description ?? ''}`).join('\n')}`);
    if (allowed.includes('open_trade')) lines.push('You run a shop: use open_trade when the player wants to buy or sell.');
    if (allowed.includes('join_party'))
      lines.push(
        this.acceptsJoin(p, def, rt, input.text)
          ? `The player is asking you to travel with them, and you like them: you accept and join (join_party), in your own voice and manner.`
          : `You are ready to travel with the player as a companion (join_party) — part of why you are here. If they ask and have not mistreated you, say yes, perhaps with a condition or a remark in character; do not string them along.`,
      );
    if (knownZones.length) lines.push(`PLACES YOU KNOW (reveal_location with zoneId when you tell them how to get there): ${knownZones.map((zz) => `${zz.id}=${zz.name}`).join(', ')}`);
    if (gift) lines.push(`GIFTS: you could give ${p.name} something you can spare (give_gift with gift = supplies: remedies and consumables; gear: a piece of equipment; material: crafting stock; keepsake: something of small value) — as thanks, out of friendship, or to help with a danger you talked about. ${gift === 'generous' ? 'You feel generous toward them.' : 'Something modest.'} Not every conversation.`);
    if (untold.length) lines.push(`SECRETS YOU COULD CONFIDE (share_secret with secretRef, only when trust is earned or you are truly persuaded): ${untold.map((i) => `secret${i}`).join(', ')} — the secrets listed above, in order (secret0 is the first).`);
    lines.push('LEADS: when you tell them something they should act on — a warning, a rumour, where something can be found — also record it with share_lead (one plain sentence) so it goes in their journal.');
    const comm = this.h.communication();
    lines.push(`MEMORY: use "remember" for anything about the player worth recalling later (promises, personal details, deeds). If it is about a future date set dueInDays. "spread" says who you would tell (${['nobody — keep it to yourself', 'close friends and family', 'the whole town', 'anyone, far and wide'][comm]} is the most this world allows). Set gathering=true only for an event the community would gather for (a celebration, a memorial).`);
    if (allowed.includes('create_quest')) {
      const people = [...this.h.ctx.npcs.values()].filter((n) => n.id !== def.id && this.h.ctx.townOf(n.zoneId) === this.h.ctx.townOf(rt.zoneId)).slice(0, 12).map((n) => n.name);
      const families = w.families.slice(0, 6).map((f) => f.name);
      lines.push(`NEW WORK (create_quest): when you ask for help with a problem of your own, make it a real task: 1-3 objectives, each of a type the world can track — talk/persuade (target: a person's name), kill (target: a creature kind), reach (target: a place name), collect (target: the thing to bring back, named plainly). Use names from this world: people ${people.join(', ') || '(none)'}; creatures ${families.join(', ')}; places ${knownZones.map((zz) => zz.name).join(', ') || '(none)'}. The engine adds "return to you" at the end. Set rewardGold to what you would honestly pay.`);
    }
    lines.push(`AVAILABLE ACTIONS: ${allowed.map((a) => `${a} (${NPC_ACTION_INFO[a]})`).join('; ')}`);
    lines.push('BEFORE YOU ANSWER: every job, payment, direction, gift, secret or promise in your speech must have its action in this same reply (offer_quest or create_quest for work, reveal_location for directions, give_gift / give_item / give_gold for things, share_secret, share_lead). If you would not take the action, do not offer it in words.');
    lines.push(this.transcript(p, def));
    if (input.event) lines.push(`[SITUATION: ${input.event}]`);
    if (input.offered) lines.push(`[The player offers you: ${this.h.ctx.itemName(input.offered)} — ${this.h.ctx.itemDescription(input.offered) || rx(this.h.ctx.r).item.get(input.offered.baseId)?.category}. Accept or refuse it.]`);
    if (input.gold) lines.push(`[The player offers you ${input.gold} ${this.h.ctx.r.terminology.currency}.]`);
    if (input.skillId) lines.push(`[The player uses an ability on you: ${this.h.ctx.skillName(input.skillId)} — ${rx(this.h.ctx.r).skill.get(input.skillId)?.description}. React to it.]`);
    lines.push(input.text ? `${p.name} says: "${input.text}"` : `Respond as ${def.name} now.`);
    return { available, involved, npcItems, knownZones, allowed, lines, untold };
  }

  private async llmDecision(userId: string, p: PlayerState, def: NpcDef, rt: NpcRuntime, input: TurnInput) {
    const { available, involved, npcItems, knownZones, allowed, lines, untold } = this.turnContext(userId, p, def, rt, input);
    const itemRefs = npcItems.map((_, i) => `item${i}`);
    const questIds = [...available.map((q) => q.id), ...involved.map((q) => q.def.id)];
    const objectiveIds = involved.flatMap((q) => q.objectives.map((o) => o.id));
    const skillIds = this.teachList(def, p);
    const enumOr = (vals: string[]) => z.enum((vals.length ? vals : ['none']) as [string, ...string[]]);
    const newObjective = z.object({ type: z.enum(OBJECTIVE_TYPES), description: z.string().max(240), target: z.string().max(80).optional(), count: z.coerce.number().int().min(1).max(10).optional() });
    const schema = z.object({
      thought: z.string().max(400).optional(),
      actions: z
        .array(
          z.object({
            type: z.enum(allowed as [string, ...string[]]),
            questId: enumOr(questIds).optional(),
            objectiveId: enumOr(objectiveIds).optional(),
            itemRef: enumOr(itemRefs).optional(),
            amount: z.coerce.number().optional(),
            zoneId: enumOr(knownZones.map((z) => z.id)).optional(),
            skillId: enumOr(skillIds).optional(),
            memory: z.string().max(300).optional(),
            dueInDays: z.coerce.number().int().min(0).max(60).optional(),
            spread: z.enum(['none', 'household', 'town', 'world']).optional(),
            gathering: z.boolean().optional(),
            newObjective: newObjective.optional(),
            newQuest: z.object({ title: z.string().max(80), summary: z.string().max(300), objectives: z.array(newObjective).min(1).max(3), rewardGold: z.coerce.number().optional() }).optional(),
            gift: z.enum(NPC_GIFTS).optional(),
            secretRef: enumOr(untold.map((i) => `secret${i}`)).optional(),
            lead: z.string().max(240).optional(),
          }),
        )
        .max(5),
      emotion: z.enum(EMOTIONS),
      speech: z.string().min(1).max(1200),
    });
    lines.push(`Reply with JSON: "actions" (may be empty), "emotion", and "speech" (only ${def.name}'s spoken words).`);
    const out = await genai().structured('npc.decision', { system: this.persona(p, def, rt), prompt: lines.join('\n\n'), schema, name: 'npc_turn' });
    const actions: NpcAction[] = out.actions.map((a) => ({
      ...a,
      type: a.type as NpcActionType,
      itemRef: a.itemRef,
      questId: a.questId === 'none' ? undefined : a.questId,
      objectiveId: a.objectiveId === 'none' ? undefined : a.objectiveId,
      zoneId: a.zoneId === 'none' ? undefined : a.zoneId,
      skillId: a.skillId === 'none' ? undefined : a.skillId,
      newObjective: a.newObjective as NewObjectiveSpec | undefined,
      newQuest: a.newQuest as NpcAction['newQuest'],
      gift: a.gift ?? undefined,
      secretRef: a.secretRef === 'none' ? undefined : a.secretRef ?? undefined,
      lead: a.lead ?? undefined,
    }));
    if (this.acceptsJoin(p, def, rt, input.text) && !actions.some((a) => a.type === 'join_party')) actions.push({ type: 'join_party' });
    return { actions, emotion: out.emotion as Emotion, speech: out.speech };
  }

  /** Decision-model path: actions chosen by a decision model (choice/score/yes-no), speech by a text model. */
  private async decisionModelTurn(userId: string, p: PlayerState, def: NpcDef, rt: NpcRuntime, input: TurnInput): Promise<{ actions: NpcAction[]; emotion: Emotion; speech: string; needsSpeech: boolean }> {
    const g = genai();
    const c = this.turnContext(userId, p, def, rt, input);
    const simple = c.allowed.filter((a) => a !== 'create_quest' && a !== 'modify_objective' && a !== 'add_objective' && a !== 'remember' && a !== 'change_disposition' && a !== 'share_lead');
    const questions: Record<string, DecisionQuestion> = {
      action: { type: 'choice', instructions: `Which single action should ${def.name} take right now, in response to what the player just said and did? Prefer "none" unless the conversation clearly calls for something.`, criteria: Object.fromEntries(simple.map((a) => [a, NPC_ACTION_INFO[a]])) },
      emotion: { type: 'choice', instructions: `How does ${def.name} feel right now?`, criteria: Object.fromEntries(EMOTIONS.map((e) => [e, null])) },
      attitude: { type: 'score', instructions: `After this exchange, how does ${def.name} feel about the player compared to before?`, criteria: ['much worse', 'worse', 'unchanged', 'better', 'much better'] },
      remember: { type: 'noul', instructions: `Did the player just share something ${def.name} would remember later (a promise, a personal detail, a date, a deed)?` },
    };
    const questChoices = [...c.available.map((q) => [q.id, q.title] as const), ...c.involved.map((q) => [q.def.id, q.def.title] as const)];
    if (questChoices.length) questions.quest = { type: 'choice', instructions: 'If the action involves a quest, which one?', criteria: Object.fromEntries(questChoices) };
    if (c.npcItems.length) questions.item = { type: 'choice', instructions: 'If giving an item, which one?', criteria: Object.fromEntries(c.npcItems.map((it, i) => [`item${i}`, this.h.ctx.itemName(it)])) };
    if (this.teachList(def, p).length) questions.skill = { type: 'choice', instructions: 'If teaching a skill, which one?', criteria: Object.fromEntries(this.teachList(def, p).map((sk) => [sk, this.h.ctx.skillName(sk)])) };
    if (c.knownZones.length) questions.zone = { type: 'choice', instructions: 'If revealing a location, which place?', criteria: Object.fromEntries(c.knownZones.map((zz) => [zz.id, zz.name])) };
    if (c.allowed.includes('give_gift')) questions.gift = { type: 'choice', instructions: 'If giving a gift, what kind?', criteria: { supplies: 'remedies and consumables', gear: 'a piece of equipment', material: 'crafting stock', keepsake: 'something of small value' } };
    if (c.untold.length) questions.secret = { type: 'choice', instructions: 'If confiding a secret, which one?', criteria: Object.fromEntries(c.untold.map((i) => [`secret${i}`, def.secrets[i]!])) };
    const ans = await g.decide('npc.decision', { state: `${this.persona(p, def, rt)}\n\n${c.lines.join('\n\n')}`, questions });
    const pick = (k: string) => (ans[k]?.type === 'choice' ? (ans[k] as { choice: string }).choice : undefined);
    const type = (this.acceptsJoin(p, def, rt, input.text) ? 'join_party' : pick('action') ?? 'none') as NpcActionType;
    const actions: NpcAction[] = [];
    const quest = pick('quest');
    const prog = quest ? c.involved.find((q) => q.def.id === quest) : undefined;
    actions.push({ type, questId: quest, objectiveId: prog?.objectives[prog.current]?.id, itemRef: pick('item'), skillId: pick('skill'), zoneId: pick('zone'), gift: pick('gift') as NpcGift | undefined, secretRef: pick('secret') });
    const att = ans.attitude?.type === 'score' ? ans.attitude.score : 2;
    if (Math.abs(att - 2) > 0.4) actions.push({ type: 'change_disposition', amount: Math.round((att - 2) * 8) });
    if (ans.remember?.type === 'noul' && ans.remember.noul > 0.6 && input.text) {
      const t = input.text.toLowerCase();
      const due = /\btomorrow\b/.test(t) ? 1 : /\bnext week\b/.test(t) ? 7 : /\bin (\d+) days?\b/.test(t) ? Number(t.match(/in (\d+) days?/)![1]) : undefined;
      actions.push({ type: 'remember', memory: `${p.name} told me: "${input.text.slice(0, 200)}"`, dueInDays: due, spread: 'town', gathering: due !== undefined && /birthday|wedding|festival|anniversary/.test(t) });
    }
    const emotion = (pick('emotion') ?? 'neutral') as Emotion;
    // Speech comes from the text model; without one, the procedural brain words it.
    const fallback = this.proceduralDecision(userId, p, def, rt, input);
    return { actions, emotion, speech: fallback.speech, needsSpeech: true };
  }

  private knownZones(def: NpcDef, rt: NpcRuntime): ZoneDef[] {
    const home = this.h.ctx.zones.get(this.h.ctx.outerZone(rt.zoneId));
    if (!home) return [];
    const near = new Set<string>([home.id, ...home.links]);
    for (const l of home.links) for (const l2 of this.h.ctx.zones.get(l)?.links ?? []) near.add(l2);
    return [...near].map((id) => this.h.ctx.zones.get(id)!).filter((z) => z && z.kind !== 'interior' && z.regionIndex <= home.regionIndex + 1).slice(0, 10);
    void def;
  }

  /** Whether this person could give the player a gift now: 'generous' for someone they are fond of. */
  private canGift(rt: NpcRuntime, userId: string): 'modest' | 'generous' | null {
    const last = rt.giftDay?.[userId];
    if (last !== undefined && this.h.day() - last < GIFT_EVERY_DAYS) return null;
    const disp = this.disposition(rt, userId);
    if (disp < GIFT_AT && !this.h.player(userId)?.stats.questsCompleted) return null;
    return disp >= 60 ? 'generous' : 'modest';
  }

  private untoldSecrets(def: NpcDef, rt: NpcRuntime, userId: string): number[] {
    const told = new Set(rt.secretsTold?.[userId] ?? []);
    return def.secrets.map((_, i) => i).filter((i) => !told.has(i));
  }

  teachPrice(p: PlayerState) {
    const lvl = Math.max(...p.party.map((c) => c.level));
    return 40 + lvl * 25;
  }

  // ------------------------------------------------------------------ action execution

  private execute(userId: string, p: PlayerState, def: NpcDef, rt: NpcRuntime, actions: NpcAction[], input: { offered?: ItemInstance; gold?: number }): string[] {
    const notes: string[] = [];
    const w = this.h.ctx.world;
    let disp = 0;
    let giftHandled = false;
    let leads = 0;
    for (const a of actions.slice(0, 5)) {
      try {
        switch (a.type) {
          case 'none':
          case 'end_conversation':
            break;
          case 'accept_gift': {
            if (giftHandled) break;
            giftHandled = true;
            if (input.offered) {
              // The gift may be exactly what a delivery objective asked for.
              const delivered = this.h.quests.tryDeliver(p, def.id);
              if (delivered.length) {
                for (const d of delivered) rt.inventory.push(...d.items);
                notes.push(`${def.name} takes ${delivered.flatMap((d) => d.items).map((i) => this.h.ctx.itemName(i)).join(', ')}.`);
              } else {
                const it = this.h.takeItemFromPlayer(userId, input.offered.id);
                if (it) {
                  rt.inventory.push(it);
                  notes.push(`${def.name} accepts the ${this.h.ctx.itemName(it)}.`);
                  disp += Math.min(15, 3 + Math.round(Math.sqrt(rx(this.h.ctx.r).item.get(it.baseId)?.price ?? 5)));
                }
              }
            }
            if (input.gold) {
              p.gold -= input.gold;
              rt.gold += input.gold;
              notes.push(`${def.name} takes the ${input.gold} ${this.h.ctx.r.terminology.currency}.`);
              disp += Math.min(20, Math.round(input.gold / 10) + 2);
            }
            break;
          }
          case 'refuse_gift':
            giftHandled = true;
            notes.push(`${def.name} declines.`);
            break;
          case 'give_item': {
            const idx = Number((a.itemRef ?? '').replace('item', ''));
            const it = Number.isFinite(idx) ? rt.inventory[idx] : undefined;
            if (!it) break;
            rt.inventory.splice(idx, 1);
            this.h.giveItemsToPlayer(userId, [it]);
            notes.push(`${def.name} gives you ${this.h.ctx.itemName(it)}.`);
            break;
          }
          case 'give_gold': {
            const amt = Math.max(0, Math.min(rt.gold, Math.round(a.amount ?? 0), 500));
            if (!amt) break;
            rt.gold -= amt;
            p.gold += amt;
            notes.push(`${def.name} gives you ${amt} ${this.h.ctx.r.terminology.currency}.`);
            break;
          }
          case 'offer_quest': {
            const q = a.questId && this.availableQuests(p, def).find((x) => x.id === a.questId);
            if (q && this.h.quests.start(p, q.id, `${def.name} asked for your help.`)) notes.push(`New ${this.h.ctx.r.terminology.quest.toLowerCase()}: ${q.title}`);
            break;
          }
          case 'complete_objective': {
            const inv = this.involvedQuests(p, def.id).find((q) => q.def.id === a.questId);
            if (!inv) break;
            const o = inv.objectives.find((x) => x.id === a.objectiveId) ?? inv.objectives[inv.current];
            // Only the current objective, and only if it's something conversation can satisfy or involves this NPC.
            if (!o || inv.objectives.indexOf(o) !== inv.current) break;
            if (!(o.type === 'persuade' || o.type === 'talk' || o.npcId === def.id)) break;
            this.h.quests.completeObjective(p, inv.def.id, o.id);
            break;
          }
          case 'modify_objective':
          case 'add_objective': {
            const inv = this.involvedQuests(p, def.id).find((q) => q.def.id === a.questId);
            if (!inv || !a.newObjective) break;
            const obj = this.resolveObjective(a.newObjective, rt.zoneId, def.id);
            if (!obj) break;
            if (a.type === 'modify_objective') {
              const target = inv.objectives.find((x) => x.id === a.objectiveId) ?? inv.objectives[inv.current];
              if (target) this.h.quests.modifyObjective(p, inv.def.id, target.id, obj, `${def.name}`);
            } else this.h.quests.addObjective(p, inv.def.id, obj);
            break;
          }
          case 'complete_quest': {
            const inv = this.involvedQuests(p, def.id).find((q) => q.def.id === a.questId);
            if (!inv) break;
            // Allowed when the remaining objectives are conversational with this NPC, or the quest is a side quest the giver chooses to close.
            const remaining = inv.objectives.slice(inv.current).filter((o) => !p.quests[inv.def.id]!.objectives[o.id]?.done);
            const onlyTalk = remaining.every((o) => (o.type === 'talk' || o.type === 'persuade') && o.npcId === def.id);
            if (onlyTalk || (!inv.def.main && inv.def.giverNpcId === def.id && remaining.length <= 1)) this.h.quests.complete(p, inv.def.id, `${def.name} considered the matter settled.`);
            break;
          }
          case 'fail_quest': {
            const inv = this.involvedQuests(p, def.id).find((q) => q.def.id === a.questId);
            if (inv) this.h.quests.fail(p, inv.def.id, `${def.name} will have nothing more to do with it.`);
            break;
          }
          case 'open_trade':
            break; // handled after the speech is shown
          case 'attack':
            this.h.npcAttack(def.id, userId);
            break;
          case 'call_guards':
            this.h.callGuards(def.id, userId);
            notes.push(`${def.name} shouts for the guards!`);
            break;
          case 'flee':
            this.h.npcFlee(def.id, userId);
            notes.push(`${def.name} runs away.`);
            break;
          case 'join_party': {
            const err = this.h.joinParty(userId, def.id);
            notes.push(err ?? `${def.name} joins your ${this.h.ctx.r.terminology.party.toLowerCase()}.`);
            break;
          }
          case 'leave_party':
            this.h.leaveParty(userId, def.id);
            notes.push(`${def.name} leaves your ${this.h.ctx.r.terminology.party.toLowerCase()}.`);
            break;
          case 'change_disposition':
            disp += Math.max(-25, Math.min(25, Math.round(a.amount ?? 0)));
            break;
          case 'remember': {
            if (!a.memory) break;
            const comm = this.h.communication();
            const levels = ['none', 'household', 'town', 'world'] as const;
            const req = levels.indexOf(a.spread ?? 'none');
            const spread = levels[Math.max(0, Math.min(req, comm))]!;
            const due = a.dueInDays !== undefined ? this.h.day() + a.dueInDays : undefined;
            this.h.remember(def.id, { id: uid('m'), text: a.memory.slice(0, 300), about: userId, aboutName: p.name, importance: 3, day: this.h.day(), source: 'conversation', dueDay: due, spread });
            if (a.gathering && due !== undefined && comm >= 2) this.h.scheduleGathering(def.id, userId, due, a.memory);
            break;
          }
          case 'reveal_location': {
            if (!a.zoneId) break;
            const z = this.h.ctx.zones.get(a.zoneId);
            if (z && this.h.revealZone(userId, z.id)) notes.push(`${z.name} is marked on your map.`);
            break;
          }
          case 'heal_player':
            this.h.healParty(userId);
            notes.push(`${def.name} tends to your ${this.h.ctx.r.terminology.party.toLowerCase()}. You feel restored.`);
            break;
          case 'teach_skill': {
            if (!a.skillId || !this.teachList(def, p).includes(a.skillId)) break;
            const err = this.h.teachSkill(userId, a.skillId, this.teachPrice(p));
            notes.push(err ?? `You learn ${this.h.ctx.skillName(a.skillId)} (−${this.teachPrice(p)} ${this.h.ctx.r.terminology.currency}).`);
            break;
          }
          case 'give_gift': {
            const kind = this.canGift(rt, userId);
            if (!kind) break;
            const it = this.h.rollGift(userId, a.gift ?? 'supplies', kind === 'generous');
            if (!it) break;
            (rt.giftDay ??= {})[userId] = this.h.day();
            this.h.giveItemsToPlayer(userId, [it]);
            notes.push(`${def.name} gives you ${this.h.ctx.itemName(it)}.`);
            break;
          }
          case 'share_secret': {
            const i = Number((a.secretRef ?? '').replace('secret', ''));
            if (!Number.isInteger(i) || !this.untoldSecrets(def, rt, userId).includes(i)) break;
            ((rt.secretsTold ??= {})[userId] ??= []).push(i);
            this.h.journal(p, 'story', `${def.name} confided: ${def.secrets[i]}`);
            // Earning someone's trust is progress in itself.
            this.h.grantXp(userId, 20 + Math.max(...p.party.map((c) => c.level)) * 12);
            notes.push(`${def.name} trusted you with a secret. (Journal)`);
            break;
          }
          case 'share_lead': {
            const lead = (a.lead ?? '').trim();
            if (lead.length < 8 || leads++ > 0) break;
            this.h.journal(p, 'discovery', `${def.name}: ${lead.slice(0, 240)}`);
            notes.push('Noted in your journal.');
            break;
          }
          case 'create_quest': {
            if (!this.h.ctx.r.systems.dynamicQuests || !a.newQuest) break;
            const objs = a.newQuest.objectives.map((o) => this.resolveObjective(o, rt.zoneId, def.id)).filter((o): o is QuestObjective => !!o);
            if (!objs.length) break;
            objs.forEach((o, i) => ((o.id = `o${i}`), (o.hidden = i > 0)));
            if (!(objs[objs.length - 1]!.type === 'talk' && objs[objs.length - 1]!.npcId === def.id)) objs.push({ id: `o${objs.length}`, type: 'talk', npcId: def.id, description: `Return to ${def.name}`, hidden: true });
            const level = Math.max(...p.party.map((c) => c.level));
            const q: QuestDef = {
              id: uid('q_dyn'),
              title: a.newQuest.title.slice(0, 80),
              summary: a.newQuest.summary.slice(0, 300),
              main: false,
              level,
              giverNpcId: def.id,
              turnInNpcId: def.id,
              objectives: objs,
              rewards: { xp: Math.round(40 + level * 30), gold: Math.max(0, Math.min(Math.round(a.newQuest.rewardGold ?? 20 + level * 12), 200 + level * 40)), items: [] },
              prerequisites: [],
              dynamic: true,
            };
            this.h.dynamicQuest(q);
            this.h.quests.start(p, q.id, `${def.name} asked for your help.`);
            notes.push(`New ${this.h.ctx.r.terminology.quest.toLowerCase()}: ${q.title}`);
            break;
          }
        }
      } catch (e) {
        console.warn('[dialogue] action failed', a.type, e);
      }
    }
    if (disp) rt.disposition[userId] = Math.max(-100, Math.min(100, (rt.disposition[userId] ?? 0) + disp));
    return notes;
  }

  /** Map a free-text objective spec to a concrete objective using world data. */
  resolveObjective(spec: NewObjectiveSpec, nearZoneId: string, npcId: string): QuestObjective | null {
    const ctx = this.h.ctx;
    const target = (spec.target ?? spec.description).toLowerCase();
    const findNpc = () => [...ctx.npcs.values()].find((n) => target.includes(n.name.toLowerCase()) || n.name.toLowerCase().includes(target)) ?? ctx.npcs.get(npcId);
    const findFamily = () => ctx.world.families.find((f) => target.includes(f.name.toLowerCase()) || f.members.some((m) => target.includes(m.name.toLowerCase())) || f.name.toLowerCase().includes(target));
    const findZone = () => ctx.world.zones.find((z) => z.kind !== 'interior' && (target.includes(z.name.toLowerCase()) || z.name.toLowerCase().includes(target)));
    const base = { id: 'tmp', description: spec.description.slice(0, 240) };
    switch (spec.type) {
      case 'talk':
      case 'persuade': {
        const n = findNpc();
        return n ? { ...base, type: spec.type, npcId: n.id } : null;
      }
      case 'kill':
      case 'kill_unique': {
        const f = findFamily();
        if (f) return { ...base, type: 'kill', familyId: f.id, count: Math.min(8, spec.count ?? 3) };
        const b = ctx.world.bosses.find((x) => target.includes(x.name.toLowerCase()));
        return b ? { ...base, type: 'kill_unique', targetId: b.id } : null;
      }
      case 'reach':
      case 'interact': {
        const z = findZone();
        return z ? { ...base, type: 'reach', zoneId: z.id } : null;
      }
      case 'collect': {
        const baseItem = ctx.r.items.find((b) => b.category !== 'quest' && b.category !== 'key' && target.includes(b.name.toLowerCase()));
        if (baseItem) return { ...base, type: 'collect', baseId: baseItem.id, count: Math.min(10, spec.count ?? 1) };
        const uidItem = this.h.createDynamicItem((spec.target ?? spec.description).slice(0, 48), spec.description, nearZoneId);
        return { ...base, type: 'collect', itemUniqueId: uidItem, count: 1 };
      }
      case 'deliver': {
        const n = findNpc();
        return n ? { ...base, type: 'talk', npcId: n.id } : null;
      }
      case 'craft':
        return ctx.r.crafting.enabled ? { ...base, type: 'craft', count: spec.count ?? 1 } : null;
      case 'disarm':
        return ctx.r.systems.traps ? { ...base, type: 'disarm', count: spec.count ?? 1 } : null;
    }
  }

  // ------------------------------------------------------------------ procedural brain

  private proceduralDecision(userId: string, p: PlayerState, def: NpcDef, rt: NpcRuntime, input: { text: string; offered?: ItemInstance; gold?: number; skillId?: string; event?: string }): { actions: NpcAction[]; emotion: Emotion; speech: string } {
    const t = input.text.toLowerCase();
    const w = this.h.ctx.world;
    const actions: NpcAction[] = [];
    const say: string[] = [];
    let emotion: Emotion = 'neutral';
    const has = (...words: string[]) => words.some((x) => new RegExp(`\\b${x}`, 'i').test(t));
    const disp = this.disposition(rt, userId);
    const available = this.availableQuests(p, def);
    const involved = this.involvedQuests(p, def.id);
    if (input.event) {
      if (input.event.includes('handed you')) {
        say.push(pickLine(['This is it. You actually did it.', 'Ah — thank you. You have no idea what this means.', 'Good. Very good.'], def.name));
        emotion = 'grateful';
      } else if (input.event.includes('remembered')) {
        const m = rt.memories.filter((x) => x.about === userId && x.fulfilled).slice(-1)[0];
        say.push(`${p.name}! I haven't forgotten${m ? ` — ${m.text.replace(/^the player('s)?/i, 'your').replace(/\.$/, '')}` : ''}. Today's the day!`);
        emotion = 'happy';
      } else if (input.event.includes('first time')) say.push(def.greeting || `Hello there. I'm ${def.name}.`);
      else say.push(pickLine([`So you came. Good — I've been expecting you, ${p.name}.`, 'There you are. We need to talk.', `${p.name}. Sit — what I have to say is important.`], def.name));
      for (const q of involved) {
        const o = q.objectives[q.current];
        const fresh = q.def.giverNpcId === def.id && !q.objectives.some((x) => p.quests[q.def.id]?.objectives[x.id]?.done);
        if ((o && o.npcId === def.id && o.type !== 'persuade') || fresh) say.push(q.def.summary);
      }
    }
    if (input.offered || input.gold) {
      const quest = input.offered && rx(this.h.ctx.r).item.get(input.offered.baseId)?.category === 'quest';
      if (quest && !involved.length) {
        actions.push({ type: 'refuse_gift' });
        say.push("That's not mine to take. Keep it.");
      } else {
        actions.push({ type: 'accept_gift' });
        say.push(pickLine(['For me? That is kind of you.', 'Well! I won\'t say no to that.', 'Thank you — truly.'], def.name));
        emotion = 'grateful';
      }
    }
    if (input.skillId) {
      const sk = rx(this.h.ctx.r).skill.get(input.skillId);
      if (sk?.effects.some((e) => e.kind === 'heal')) {
        say.push('Oh — I feel better already. Thank you.');
        actions.push({ type: 'change_disposition', amount: 8 });
        emotion = 'grateful';
      } else say.push('What... was that supposed to do?');
    }
    if (!input.event && input.text) {
      if (has('bye', 'farewell', 'goodbye', 'leave', 'later')) {
        actions.push({ type: 'end_conversation' });
        say.push(pickLine(['Safe travels.', 'Until next time.', 'Mind how you go.'], def.name));
      } else if (has('fuck', 'idiot', 'stupid', 'ugly', 'hate you', 'shut up', 'die')) {
        actions.push({ type: 'change_disposition', amount: -15 });
        say.push(disp < -40 && def.role === 'guard' ? 'That is enough. You are under arrest!' : pickLine(['How dare you.', 'I don\'t have to listen to this.', 'Charming. Truly.'], def.name));
        if (disp < -40 && def.role === 'guard') actions.push({ type: 'attack' });
        emotion = 'angry';
      } else if (rt.partyOf === userId && has('part ways', 'leave the party', 'go home', 'dismiss', 'parted')) {
        actions.push({ type: 'leave_party' });
        say.push('If that is what you want. You know where to find me.');
      } else if (def.canJoinParty && !rt.partyOf && ASKS_TO_JOIN.test(t)) {
        if (disp >= -5) {
          actions.push({ type: 'join_party' });
          say.push(pickLine(['About time someone asked. Lead the way.', 'Why not? It beats sitting here.', 'Alright. But I take my share of the loot.'], def.name));
          emotion = 'happy';
        } else say.push("I don't know you well enough for that.");
      } else if ((def.role === 'merchant' || def.role === 'crafter' || def.role === 'innkeeper') && has('buy', 'sell', 'wares', 'trade', 'shop', 'goods', 'store', 'merchandise')) {
        actions.push({ type: 'open_trade' });
        say.push(pickLine(['Take a look. Everything is priced fairly.', 'See anything you like?', 'Coin first, questions later.'], def.name));
      } else if (def.role === 'innkeeper' && has('room', 'rest', 'sleep', 'bed', 'night')) {
        const cost = 10 + Math.max(...p.party.map((c) => c.level)) * 2;
        if (p.gold >= cost) {
          p.gold -= cost;
          actions.push({ type: 'heal_player' });
          say.push(`That'll be ${cost} ${this.h.ctx.r.terminology.currency}. Rest well — there's a hot meal in the morning.`);
        } else say.push(`A room is ${cost} ${this.h.ctx.r.terminology.currency}. Come back when you have it.`);
      } else if (this.teachList(def, p).length && has('teach', 'train', 'learn', 'lesson', 'skill')) {
        const want = this.teachList(def, p).find((s) => t.includes(this.h.ctx.skillName(s).toLowerCase()) || t.includes(s.replace(/_/g, ' ')));
        if (want) {
          actions.push({ type: 'teach_skill', skillId: want });
          say.push('Watch closely. Again. Good — you have it.');
        } else say.push(`I can teach ${this.teachList(def, p).slice(0, 5).map((s) => this.h.ctx.skillName(s)).join(', ')}. ${this.teachPrice(p)} ${this.h.ctx.r.terminology.currency} a lesson — just name it.`);
      } else if (available.length && has('work', 'job', 'help', 'quest', 'task', 'errand', 'need', 'anything', 'problem', 'trouble', 'contract')) {
        const q = available[0]!;
        actions.push({ type: 'offer_quest', questId: q.id });
        say.push(`${q.summary} Will you do it?`);
        emotion = 'thoughtful';
      } else if (has('news', 'rumor', 'rumour', 'heard', 'happening', 'gossip', 'know', 'tell me', 'about')) {
        const rumors = rt.memories.filter((m) => m.source === 'rumor' && m.about !== userId).slice(-2);
        const k = [...def.knowledge, ...rumors.map((r) => `I heard ${r.text.replace(/\.$/, '')}.`)];
        say.push(k.length ? k[(this.h.day() + t.length) % k.length]! : pickLine(['Not much happens here. Not usually.', 'Keep your eyes open on the roads, that is all I will say.'], def.name));
        const zones = this.knownZones(def, rt).filter((z) => !p.knownZones.includes(z.id));
        if (zones[0] && has('where', 'way', 'road', 'place', 'find')) {
          actions.push({ type: 'reveal_location', zoneId: zones[0].id });
          say.push(`If you're looking for ${zones[0].name}, I can show you the way.`);
        }
      } else if (has('birthday', 'wedding', 'anniversary', 'tomorrow', 'remember', 'promise', 'my name')) {
        const dueIn = has('tomorrow') ? 1 : has('next week') ? 7 : undefined;
        actions.push({ type: 'remember', memory: `${p.name} told me: "${input.text.slice(0, 160)}"`, dueInDays: dueIn, spread: 'town', gathering: has('birthday', 'wedding') && dueIn !== undefined });
        say.push(dueIn !== undefined ? 'I\'ll remember that. Don\'t think I won\'t!' : 'I\'ll keep that in mind.');
        emotion = 'happy';
      } else {
        // Persuasion: a thoughtful argument that touches the objective's topic.
        const persuade = involved.find((q) => q.objectives[q.current]?.type === 'persuade' && q.objectives[q.current]?.npcId === def.id);
        if (persuade) {
          const o = persuade.objectives[persuade.current]!;
          const keywords = o.description.toLowerCase().split(/\W+/).filter((x) => x.length > 4);
          const overlap = keywords.filter((k) => t.includes(k)).length;
          const persuasive = false;
          if (input.text.length > 40 && (overlap >= 1 || persuasive || disp > 20)) {
            actions.push({ type: 'complete_objective', questId: persuade.def.id, objectiveId: o.id });
            say.push(pickLine(['...You make a fair point. Very well.', 'I hadn\'t thought of it that way. Alright — you have convinced me.', 'Fine. Fine! I will do it.'], def.name));
            emotion = 'thoughtful';
          } else say.push(pickLine(['I am not convinced. Give me a real reason.', 'Words are cheap. Why should I?', 'Hm. You will have to do better than that.'], def.name));
        } else if (has('hello', 'hi', 'greetings', 'hey', 'good morning', 'good evening')) say.push(def.greeting || `Hello, ${p.name}.`);
        else if (has('who are you', 'your name', 'yourself')) say.push(`${def.name}. ${def.title}. ${def.backstory}`);
        else if (has('thank')) {
          say.push('Think nothing of it.');
          actions.push({ type: 'change_disposition', amount: 2 });
        } else say.push(def.barks[(t.length + this.h.day()) % Math.max(1, def.barks.length)] ?? 'Hm.');
      }
    }
    if (!say.length) say.push(def.greeting || '...');
    return { actions, emotion, speech: say.join(' ') };
  }
}

function pickLine(lines: string[], seed: string) {
  return lines[(seed.length + Math.floor(Date.now() / 60000)) % lines.length]!;
}

/** Remove speaker tags and stage-direction noise models sometimes emit. */
export function sanitizeSpeech(s: string, name: string): string {
  let out = (s ?? '').trim();
  const prefix = new RegExp(`^(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|NPC)\\s*:\\s*`, 'i');
  out = out.replace(prefix, '');
  if (out.startsWith('"') && out.endsWith('"') && out.length > 2) out = out.slice(1, -1);
  return out.replace(/<\/?[^>]+>/g, '').trim();
}
