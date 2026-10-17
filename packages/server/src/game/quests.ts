/** Quest state machine: start, progress, adaptive edits, completion and story arcs. */
import { Rng, type ItemInstance, type PlayerState, type QuestDef, type QuestObjective, type QuestProgress, type JournalEntry } from '@gd/shared';
import { rewardItems, addToInventory } from './loot';
import type { WorldCtx } from './worldctx';

export interface QuestHost {
  ctx: WorldCtx;
  day(): number;
  minute(): number;
  questDef(id: string): QuestDef | undefined;
  journal(p: PlayerState, kind: JournalEntry['kind'], text: string): void;
  toast(p: PlayerState, text: string, kind?: 'info' | 'good' | 'bad' | 'quest' | 'loot'): void;
  narrate(p: PlayerState, title: string, text: string, style?: 'intro' | 'arc' | 'ending' | 'quest' | 'death'): void;
  grantXp(p: PlayerState, amount: number): void;
  grantGold(p: PlayerState, amount: number): void;
  playerChanged(p: PlayerState): void;
  /** Hook for gossip: quest completed/failed. */
  questEvent(p: PlayerState, q: QuestDef, kind: 'completed' | 'failed'): void;
  rng: Rng;
}

export function objectivesOf(def: QuestDef, prog?: QuestProgress): QuestObjective[] {
  return prog?.overrides ?? def.objectives;
}

/** Index of the first incomplete required objective. */
export function currentObjectiveIndex(def: QuestDef, prog: QuestProgress): number {
  const objs = objectivesOf(def, prog);
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i]!;
    if (!prog.objectives[o.id]?.done && !o.optional) return i;
  }
  return objs.length;
}

export class QuestEngine {
  constructor(private h: QuestHost) {}

  start(p: PlayerState, questId: string, source?: string): boolean {
    const def = this.h.questDef(questId);
    if (!def || p.quests[questId]) return false;
    const prog: QuestProgress = { questId, status: 'active', objectives: {}, log: [{ day: this.h.day(), text: source ? `${source}` : def.summary }], startedDay: this.h.day() };
    for (const o of def.objectives) prog.objectives[o.id] = { progress: 0, done: false };
    p.quests[questId] = prog;
    if (def.grantsOnStart?.length) {
      const items = def.grantsOnStart.map((u) => rewardItems(this.h.ctx.world, this.h.rng, [u], def.level)).flat();
      addToInventory(p.inventory, items);
      for (const it of items) this.h.toast(p, `Received ${this.h.ctx.world.uniqueItems[it.uniqueId ?? '']?.name ?? 'an item'}`, 'loot');
    }
    this.h.journal(p, 'quest', `${def.main ? 'Story' : this.h.ctx.world.terminology.quest} started: ${def.title}`);
    this.h.toast(p, `New ${def.main ? 'story ' : ''}${this.h.ctx.world.terminology.quest.toLowerCase()}: ${def.title}`, 'quest');
    // Objectives may already be satisfied (e.g. already carrying the item, already in the zone).
    this.refreshCollect(p);
    this.h.playerChanged(p);
    return true;
  }

  /** Start main quests whose prerequisites are complete. */
  autoStart(p: PlayerState) {
    for (const def of [...this.h.ctx.world.quests]) {
      if (!def.autoStart || p.quests[def.id]) continue;
      if (def.prerequisites.every((id) => p.quests[id]?.status === 'completed')) this.start(p, def.id);
    }
  }

  private advanceObjective(p: PlayerState, questId: string, pred: (o: QuestObjective) => boolean, amount = 1): boolean {
    const def = this.h.questDef(questId);
    const prog = p.quests[questId];
    if (!def || !prog || prog.status !== 'active') return false;
    const objs = objectivesOf(def, prog);
    const cur = currentObjectiveIndex(def, prog);
    let changed = false;
    // The current objective, plus optional objectives, may progress.
    objs.forEach((o, i) => {
      if (i !== cur && !o.optional) return;
      if (!pred(o)) return;
      const st = (prog.objectives[o.id] ??= { progress: 0, done: false });
      if (st.done) return;
      st.progress += amount;
      const need = o.count ?? 1;
      if (st.progress >= need) {
        st.progress = need;
        st.done = true;
        prog.log.push({ day: this.h.day(), text: `Done: ${o.description}` });
        this.h.toast(p, `✔ ${o.description}`, 'quest');
      } else this.h.toast(p, `${o.description} (${st.progress}/${need})`, 'quest');
      changed = true;
    });
    if (changed) this.checkComplete(p, questId);
    return changed;
  }

  private forActive(p: PlayerState, fn: (questId: string) => boolean): boolean {
    let any = false;
    for (const id of Object.keys(p.quests)) if (p.quests[id]!.status === 'active' && fn(id)) any = true;
    if (any) {
      this.refreshCollect(p);
      this.h.playerChanged(p);
    }
    return any;
  }

  onTalk(p: PlayerState, npcId: string) {
    return this.forActive(p, (q) => this.advanceObjective(p, q, (o) => o.type === 'talk' && o.npcId === npcId));
  }

  onKill(p: PlayerState, info: { familyId?: string; archetype?: string; bossId?: string; npcId?: string; zoneId: string }) {
    const outer = this.h.ctx.outerZone(info.zoneId);
    return this.forActive(p, (q) =>
      this.advanceObjective(p, q, (o) =>
        (o.type === 'kill' && !!info.familyId && o.familyId === info.familyId && (!o.zoneId || o.zoneId === info.zoneId || o.zoneId === outer) && (!o.archetype || o.archetype === info.archetype)) ||
        (o.type === 'kill_unique' && (o.targetId === info.bossId || o.targetId === info.npcId)),
      ),
    );
  }

  onEnterZone(p: PlayerState, zoneId: string) {
    const outer = this.h.ctx.outerZone(zoneId);
    return this.forActive(p, (q) => this.advanceObjective(p, q, (o) => o.type === 'reach' && (o.zoneId === zoneId || o.zoneId === outer)));
  }

  onInteract(p: PlayerState, featureId: string) {
    return this.forActive(p, (q) => this.advanceObjective(p, q, (o) => o.type === 'interact' && o.featureId === featureId));
  }

  onDisarm(p: PlayerState) {
    return this.forActive(p, (q) => this.advanceObjective(p, q, (o) => o.type === 'disarm'));
  }

  onCraft(p: PlayerState, baseId: string) {
    return this.forActive(p, (q) => this.advanceObjective(p, q, (o) => o.type === 'craft' && (!o.baseId || o.baseId === baseId)));
  }

  /** Mark collect objectives done when the player holds the items (re-checked after inventory changes). */
  refreshCollect(p: PlayerState) {
    for (const [qid, prog] of Object.entries(p.quests)) {
      if (prog.status !== 'active') continue;
      const def = this.h.questDef(qid);
      if (!def) continue;
      const objs = objectivesOf(def, prog);
      const cur = currentObjectiveIndex(def, prog);
      const o = objs[cur];
      if (!o) continue;
      if (o.type === 'collect' || (o.type === 'reach' && o.zoneId && this.h.ctx.outerZone(p.zoneId) === o.zoneId)) {
        if (o.type === 'reach') {
          this.advanceObjective(p, qid, (x) => x === o);
          continue;
        }
        const have = countItems(p.inventory, o);
        const st = prog.objectives[o.id] ?? { progress: 0, done: false };
        if (have >= (o.count ?? 1) && !st.done) this.advanceObjective(p, qid, (x) => x === o, (o.count ?? 1) - st.progress);
      }
    }
  }

  /** Deliver objectives targeting this NPC that the player can satisfy right now. Removes the items. */
  tryDeliver(p: PlayerState, npcId: string): { questId: string; items: ItemInstance[] }[] {
    const out: { questId: string; items: ItemInstance[] }[] = [];
    for (const [qid, prog] of Object.entries(p.quests)) {
      if (prog.status !== 'active') continue;
      const def = this.h.questDef(qid);
      if (!def) continue;
      const objs = objectivesOf(def, prog);
      const o = objs[currentObjectiveIndex(def, prog)];
      if (!o || o.type !== 'deliver' || o.npcId !== npcId) continue;
      if (countItems(p.inventory, o) < (o.count ?? 1)) continue;
      const taken = takeItems(p.inventory, o, o.count ?? 1);
      out.push({ questId: qid, items: taken });
      this.advanceObjective(p, qid, (x) => x === o, o.count ?? 1);
    }
    if (out.length) this.h.playerChanged(p);
    return out;
  }

  /** NPC-driven objective completion (persuasion etc.). */
  completeObjective(p: PlayerState, questId: string, objectiveId: string): boolean {
    const def = this.h.questDef(questId);
    const prog = p.quests[questId];
    if (!def || !prog || prog.status !== 'active') return false;
    const o = objectivesOf(def, prog).find((x) => x.id === objectiveId);
    if (!o) return false;
    const st = (prog.objectives[o.id] ??= { progress: 0, done: false });
    if (st.done) return false;
    st.done = true;
    st.progress = o.count ?? 1;
    prog.log.push({ day: this.h.day(), text: `Done: ${o.description}` });
    this.h.toast(p, `✔ ${o.description}`, 'quest');
    this.checkComplete(p, questId);
    this.h.playerChanged(p);
    return true;
  }

  /** Replace an objective (adaptive quests). */
  modifyObjective(p: PlayerState, questId: string, objectiveId: string, replacement: QuestObjective, reason: string): boolean {
    const def = this.h.questDef(questId);
    const prog = p.quests[questId];
    if (!def || !prog || prog.status !== 'active') return false;
    const objs = [...objectivesOf(def, prog)];
    const i = objs.findIndex((o) => o.id === objectiveId);
    if (i < 0) return false;
    if (prog.objectives[objectiveId]?.done) return false;
    const id = `${objectiveId}_m${Math.floor(this.h.rng.next() * 1e4)}`;
    objs[i] = { ...replacement, id, hidden: false };
    prog.overrides = objs;
    prog.objectives[id] = { progress: 0, done: false };
    prog.log.push({ day: this.h.day(), text: `Changed: ${replacement.description}${reason ? ` — ${reason}` : ''}` });
    this.h.toast(p, `Objective changed: ${replacement.description}`, 'quest');
    this.refreshCollect(p);
    this.h.playerChanged(p);
    return true;
  }

  addObjective(p: PlayerState, questId: string, obj: QuestObjective): boolean {
    const def = this.h.questDef(questId);
    const prog = p.quests[questId];
    if (!def || !prog || prog.status !== 'active') return false;
    const objs = [...objectivesOf(def, prog)];
    const id = `x${objs.length}_${Math.floor(this.h.rng.next() * 1e4)}`;
    // Insert before the final turn-in conversation.
    const last = objs[objs.length - 1];
    const insertAt = last && last.type === 'talk' ? objs.length - 1 : objs.length;
    objs.splice(insertAt, 0, { ...obj, id, hidden: false });
    prog.overrides = objs;
    prog.objectives[id] = { progress: 0, done: false };
    prog.log.push({ day: this.h.day(), text: `New objective: ${obj.description}` });
    this.h.toast(p, `New objective: ${obj.description}`, 'quest');
    this.refreshCollect(p);
    this.h.playerChanged(p);
    return true;
  }

  private checkComplete(p: PlayerState, questId: string) {
    const def = this.h.questDef(questId);
    const prog = p.quests[questId];
    if (!def || !prog || prog.status !== 'active') return;
    if (currentObjectiveIndex(def, prog) >= objectivesOf(def, prog).length) this.complete(p, questId);
  }

  complete(p: PlayerState, questId: string, note?: string) {
    const def = this.h.questDef(questId);
    const prog = p.quests[questId];
    if (!def || !prog || prog.status !== 'active') return;
    prog.status = 'completed';
    prog.log.push({ day: this.h.day(), text: note ?? 'Completed.' });
    p.stats.questsCompleted++;
    const items = rewardItems(this.h.ctx.world, this.h.rng, def.rewards.items, def.level);
    addToInventory(p.inventory, items);
    this.h.grantGold(p, def.rewards.gold);
    this.h.grantXp(p, def.rewards.xp);
    this.h.journal(p, 'quest', `Completed: ${def.title}`);
    this.h.toast(p, `${this.h.ctx.world.terminology.quest} complete: ${def.title} (+${def.rewards.xp} ${this.h.ctx.world.terminology.xp}, +${def.rewards.gold} ${this.h.ctx.world.terminology.gold})`, 'good');
    if (def.completionText) this.h.narrate(p, def.title, def.completionText, 'quest');
    this.h.questEvent(p, def, 'completed');
    // Arc revelations and ending.
    if (def.main && def.arcIndex !== undefined) {
      const arc = this.h.ctx.world.arcs[def.arcIndex];
      if (arc && arc.questIds.every((id) => p.quests[id]?.status === 'completed') && !p.revealedArcs.includes(arc.index)) {
        p.revealedArcs.push(arc.index);
        this.h.narrate(p, arc.title, arc.revelation, 'arc');
        this.h.journal(p, 'story', `${arc.title}: ${arc.revelation}`);
      }
    }
    if (questId === this.h.ctx.world.finalQuestId) {
      p.completedGame = true;
      this.h.narrate(p, 'The End', this.h.ctx.world.ending, 'ending');
      this.h.journal(p, 'story', 'The main story is complete. The world remains open to explore.');
    }
    this.autoStart(p);
    this.h.playerChanged(p);
  }

  fail(p: PlayerState, questId: string, reason: string) {
    const def = this.h.questDef(questId);
    const prog = p.quests[questId];
    if (!def || !prog || prog.status !== 'active') return;
    if (def.main) {
      // Main quests never hard-fail; they adapt instead.
      prog.log.push({ day: this.h.day(), text: `Setback: ${reason}` });
      this.h.toast(p, `Setback: ${reason}`, 'bad');
      return;
    }
    prog.status = 'failed';
    prog.log.push({ day: this.h.day(), text: `Failed: ${reason}` });
    this.h.journal(p, 'quest', `Failed: ${def.title} — ${reason}`);
    this.h.toast(p, `${this.h.ctx.world.terminology.quest} failed: ${def.title}`, 'bad');
    this.h.questEvent(p, def, 'failed');
    this.h.playerChanged(p);
  }

  abandon(p: PlayerState, questId: string) {
    const def = this.h.questDef(questId);
    if (!def || def.main) return;
    delete p.quests[questId];
    this.h.playerChanged(p);
  }
}

export function countItems(inv: ItemInstance[], o: QuestObjective): number {
  return inv.filter((i) => (o.itemUniqueId ? i.uniqueId === o.itemUniqueId : o.baseId ? i.baseId === o.baseId : false)).reduce((s, i) => s + i.qty, 0);
}

function takeItems(inv: ItemInstance[], o: QuestObjective, n: number): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (let i = inv.length - 1; i >= 0 && n > 0; i--) {
    const it = inv[i]!;
    if (o.itemUniqueId ? it.uniqueId !== o.itemUniqueId : it.baseId !== o.baseId) continue;
    if (it.qty > n) {
      it.qty -= n;
      out.push({ ...it, qty: n });
      n = 0;
    } else {
      inv.splice(i, 1);
      out.push(it);
      n -= it.qty;
    }
  }
  return out;
}
