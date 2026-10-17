/** One running save-state of a world: authoritative simulation for every connected player. */
import {
  BitSet, GAME_MINUTES_PER_DAY, ITEM_BASE, MAX_PARTY_SIZE, ORIGINS, RECIPES, REAL_MS_PER_GAME_MINUTE, Rng, SKILLS, STATUS_INFO, TRAP_INFO,
  findPath, getSkill, hashFloat, itemName, itemPrice, killXp, sampleMotion, skillName, tilesInRadius, uid, ARCHETYPES, ORIGIN, ATTRIBUTES,
  type ClientMessage, type DialogState, type EntityView, type FeatureDef, type FeatureState, type FxEvent, type InstanceState, type ItemInstance,
  type JournalEntry, type LootPile, type Memory, type NpcRuntime, type PlayerState, type PlayerView, type QuestDef, type ServerMessage, type Surface,
  type TradeState, type Vec2, type WorldDefinition, type ZoneRuntime, type CharacterState, type AttributeId, type EquipSlot, type MonsterArchetype,
} from '@gd/shared';
import { Actor, CharActor, MonsterActor, NpcActor, WALK_SPEED } from './actors';
import { WorldCtx, type ZoneMap } from './worldctx';
import { Combat, type CombatHost } from './combat';
import { addStatus, checkItemUse, checkSkill, createSurface, dealDamage, executeSkill, healActor, isHostileTo, relation, trapPower, useConsumable, applySurface } from './effects';
import { QuestEngine, objectivesOf, currentObjectiveIndex } from './quests';
import { DialogueEngine } from './dialogue';
import { addToInventory, makeItem, merchantStock, mergeStacks, removeFromInventory, rollLoot, rollRandomItem } from './loot';
import { clampPools, createCharacter, grantXp, restoreFully, statsOf, autoSpend, defaultHotbar, type CharacterSpec } from './characters';

export interface Conn {
  userId: string;
  send(msg: ServerMessage): void;
}

interface LiveZone {
  id: string;
  map: ZoneMap;
  rt: ZoneRuntime;
  actors: Map<string, Actor>;
  surfacesDirty: boolean;
  lootDirty: boolean;
  featuresDirty: Set<string>;
  lastSurfaceDecay: number;
}

interface PendingInteraction {
  targetId: string;
  charId: string;
}

const TICK_MS = 100;
const AGGRO_RADIUS = 6.5;
const JOIN_RADIUS = 13;

export class GameInstance implements CombatHost {
  readonly ctx: WorldCtx;
  readonly world: WorldDefinition;
  readonly rng: Rng;
  readonly quests: QuestEngine;
  readonly dialogue: DialogueEngine;
  private conns = new Map<string, Set<Conn>>();
  private zones = new Map<string, LiveZone>();
  private combats = new Map<string, Combat>();
  private dirtyPlayers = new Set<string>();
  private pending = new Map<string, PendingInteraction>();
  private trades = new Map<string, string>();
  private lootOpen = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  private lastClockSent = 0;
  private lastAggro = 0;
  private lastRegen = 0;
  private dirtySince = 0;
  onSave?: (s: InstanceState) => void;
  /** Called when the instance has no connected players. */
  onEmpty?: () => void;

  constructor(public state: InstanceState, world: WorldDefinition) {
    this.world = world;
    this.ctx = new WorldCtx(world);
    this.rng = new Rng(`${state.id}:${Date.now()}`);
    this.mergeDynamicItems();
    this.quests = new QuestEngine({
      ctx: this.ctx,
      rng: this.rng,
      day: () => this.day(),
      minute: () => this.state.clock,
      questDef: (id) => this.questDef(id),
      journal: (p, kind, text) => this.journal(p, kind, text),
      toast: (p, text, kind) => this.sendTo(p.userId, { t: 'toast', text, kind }),
      narrate: (p, title, text, style) => {
        // Quest flavor goes into an open conversation instead of interrupting it.
        if (style === 'quest' && this.dialogue?.note(p.userId, text)) return;
        this.sendTo(p.userId, { t: 'narration', title, text, style });
      },
      grantXp: (p, amount) => this.grantPartyXp(p, amount),
      grantGold: (p, amount) => {
        p.gold += amount;
        p.stats.goldEarned += amount;
      },
      playerChanged: (p) => this.markPlayer(p.userId),
      questEvent: (p, q, kind) => this.questGossip(p, q, kind),
    });
    this.dialogue = new DialogueEngine(this.dialogueHost());
    for (const n of world.npcs) if (!state.npcs[n.id]) state.npcs[n.id] = this.initNpc(n.id);
  }

  // =================================================================== lifecycle

  start() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  save() {
    this.state.lastActiveAt = Date.now();
    this.onSave?.(this.state);
    this.dirtySince = 0;
  }

  /** Advance the clock for time that passed while nobody was connected (keepRunning instances). */
  catchUp(realMs: number) {
    const minutes = Math.min(3 * GAME_MINUTES_PER_DAY, realMs / REAL_MS_PER_GAME_MINUTE);
    if (minutes > 1) this.state.clock += minutes;
  }

  onlineUsers(): string[] {
    return [...this.conns.keys()];
  }

  isPaused() {
    return this.conns.size === 0 && !this.state.keepRunning;
  }

  day() {
    return Math.floor(this.state.clock / GAME_MINUTES_PER_DAY) + 1;
  }

  hour() {
    return Math.floor((this.state.clock % GAME_MINUTES_PER_DAY) / 60);
  }

  timeOfDay() {
    const h = this.hour();
    return h < 5 ? 'the dead of night' : h < 8 ? 'early morning' : h < 12 ? 'morning' : h < 14 ? 'midday' : h < 18 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  }

  now() {
    return Date.now();
  }

  // =================================================================== players & connections

  hasPlayer(userId: string) {
    return !!this.state.players[userId];
  }

  /** Create a player's party (character creation). */
  addPlayer(userId: string, name: string, specs: CharacterSpec[]): PlayerState {
    const w = this.world;
    const prng = new Rng(`${this.state.id}:${userId}`);
    const maxChars = w.input.combatMode === 'party_manual' ? MAX_PARTY_SIZE : 1;
    const party: CharacterState[] = [];
    const inventory: ItemInstance[] = [];
    for (const spec of specs.slice(0, maxChars)) {
      const { ch, inventory: inv } = createCharacter(w, spec, prng);
      party.push(ch);
      addToInventory(inventory, inv);
    }
    if (!party.length) party.push(createCharacter(w, { name, originId: 'o_warrior' }, prng).ch);
    for (const ch of party) restoreFully(ch, w, party.length <= 1);
    const start = this.ctx.zones.get(w.startZoneId)!;
    const p: PlayerState = {
      userId,
      name: party[0]!.name,
      party,
      leaderId: party[0]!.id,
      gold: 60,
      inventory: mergeStacks(inventory),
      zoneId: start.id,
      x: start.entry.x,
      y: start.entry.y,
      quests: {},
      explored: {},
      visitedZones: [],
      knownZones: [start.id, ...start.links],
      journal: [],
      conversations: {},
      conversationSummaries: {},
      lastTownZoneId: start.id,
      revealedTraps: [],
      revealedArcs: [],
      stats: { kills: 0, deaths: 0, questsCompleted: 0, goldEarned: 0, trapsDisarmed: 0, itemsCrafted: 0 },
      createdAt: Date.now(),
      commandCompanions: false,
    };
    this.state.players[userId] = p;
    return p;
  }

  join(conn: Conn) {
    const p = this.state.players[conn.userId];
    if (!p) {
      conn.send({ t: 'error', message: 'Create a character for this world first.' });
      return;
    }
    let set = this.conns.get(conn.userId);
    const firstConn = !set;
    if (!set) this.conns.set(conn.userId, (set = new Set()));
    set.add(conn);
    conn.send({
      t: 'welcome',
      world: this.clientWorld(),
      instanceId: this.state.id,
      instanceName: this.state.name,
      userId: conn.userId,
      serverTime: Date.now(),
      keepRunning: this.state.keepRunning,
      open: this.state.open,
      isOwner: this.state.ownerId === conn.userId,
    });
    if (firstConn) this.spawnParty(p);
    this.sendZone(conn.userId);
    this.sendPlayer(conn.userId);
    this.sendClock(true);
    const z = this.zones.get(p.zoneId);
    const combat = z && [...z.actors.values()].find((a) => a.combatId)?.combatId;
    if (combat && this.combats.get(combat)) conn.send({ t: 'combat', combat: this.combats.get(combat)!.view() });
    if (!p.visitedZones.length) {
      this.sendTo(p.userId, { t: 'narration', title: this.world.concept.title, text: this.world.concept.intro, style: 'intro' });
      this.enteredZone(p, p.zoneId, true);
      this.quests.autoStart(p);
    }
    this.start();
  }

  leave(conn: Conn) {
    const set = this.conns.get(conn.userId);
    if (!set) return;
    set.delete(conn);
    if (set.size) return;
    this.conns.delete(conn.userId);
    this.dialogue.close(conn.userId);
    const p = this.state.players[conn.userId];
    if (p) this.despawnParty(p);
    this.save();
    if (!this.conns.size) this.onEmpty?.();
  }

  private clientWorld() {
    const w = this.world;
    const { zones, npcs, concept, arcs, quests, ending, generationLog, worldFacts, ...rest } = w;
    void quests, ending, generationLog, worldFacts;
    const { secret, ...publicConcept } = concept;
    void secret;
    return {
      ...rest,
      concept: publicConcept,
      zones: zones.map(({ ground, objects, variation, spawns, lore, ...z }) => (void ground, void objects, void variation, void spawns, void lore, z)),
      npcs: npcs.map((n) => ({ id: n.id, name: n.name, title: n.title, role: n.role, zoneId: n.zoneId, asset: n.asset, colors: n.colors, pronouns: n.pronouns, appearance: n.appearance, archetype: n.archetype })),
      arcs: arcs.map((a) => ({ index: a.index, title: a.title })),
    } as ServerMessage extends never ? never : Extract<ServerMessage, { t: 'welcome' }>['world'];
  }

  sendTo(userId: string, msg: ServerMessage) {
    for (const c of this.conns.get(userId) ?? []) c.send(msg);
  }

  private broadcastZone(zoneId: string, msg: ServerMessage | ((userId: string) => ServerMessage | null)) {
    for (const [userId] of this.conns) {
      const p = this.state.players[userId];
      if (!p || p.zoneId !== zoneId) continue;
      const m = typeof msg === 'function' ? msg(userId) : msg;
      if (m) this.sendTo(userId, m);
    }
  }

  private markPlayer(userId: string) {
    this.dirtyPlayers.add(userId);
    this.markDirty();
  }

  private markDirty() {
    if (!this.dirtySince) this.dirtySince = Date.now();
  }

  // =================================================================== zones

  private initNpc(npcId: string): NpcRuntime {
    const def = this.ctx.npcs.get(npcId)!;
    const s = new NpcActor(def, { npcId, zoneId: def.zoneId, x: def.x, y: def.y, hp: 1, alive: true, hostileTo: [], disposition: {}, memories: [], stock: [], stockDay: -1, inventory: [], gold: 0 }, def.zoneId, this.world).stats();
    const inventory = (def.inventory ?? []).map((u) => ({ id: uid('it'), baseId: this.world.uniqueItems[u]?.baseId ?? 'q_item', level: def.level, rarity: this.world.uniqueItems[u]?.rarity ?? 'rare', affixes: [], qty: 1, uniqueId: u, bound: true }) as ItemInstance);
    return { npcId, zoneId: def.zoneId, x: def.x, y: def.y, hp: s.maxHp, alive: true, hostileTo: [], disposition: {}, memories: [], stock: [], stockDay: -1, inventory, gold: def.role === 'merchant' ? 400 + def.level * 60 : 20 + def.level * 10 };
  }

  private zoneRuntime(zoneId: string): ZoneRuntime {
    let rt = this.state.zones[zoneId];
    if (!rt) {
      const def = this.ctx.zones.get(zoneId)!;
      rt = { zoneId, monsters: {}, features: {}, surfaces: [], loot: [] };
      for (const s of def.spawns) rt.monsters[s.id] = { spawnId: s.id, hp: -1, dead: false, x: s.x, y: s.y };
      this.state.zones[zoneId] = rt;
    }
    return rt;
  }

  private live(zoneId: string): LiveZone {
    let z = this.zones.get(zoneId);
    if (z) return z;
    const map = this.ctx.map(zoneId);
    const rt = this.zoneRuntime(zoneId);
    z = { id: zoneId, map, rt, actors: new Map(), surfacesDirty: false, lootDirty: false, featuresDirty: new Set(), lastSurfaceDecay: Date.now() };
    this.zones.set(zoneId, z);
    // Monsters (respawn the dead after their respawn day).
    for (const s of map.def.spawns) {
      const m = (rt.monsters[s.id] ??= { spawnId: s.id, hp: -1, dead: false, x: s.x, y: s.y });
      if (m.dead && m.respawnDay !== undefined && m.respawnDay <= this.day()) {
        m.dead = false;
        m.hp = -1;
        m.x = s.x;
        m.y = s.y;
        m.looted = false;
      }
      if (m.dead) continue;
      const fam = this.ctx.family(s.familyId) ?? this.world.families[0]!;
      const actor = new MonsterActor(s, m, fam, s.bossId ? this.ctx.bosses.get(s.bossId) : undefined, zoneId);
      z.actors.set(actor.id, actor);
    }
    for (const rtn of Object.values(this.state.npcs)) {
      if (rtn.zoneId !== zoneId || !rtn.alive || rtn.partyOf || rtn.fled) continue;
      const def = this.ctx.npcs.get(rtn.npcId);
      if (!def) continue;
      const a = new NpcActor(def, rtn, zoneId, this.world);
      z.actors.set(a.id, a);
    }
    this.applyGatherings(z);
    return z;
  }

  private maybeUnloadZone(zoneId: string) {
    const z = this.zones.get(zoneId);
    if (!z) return;
    const hasChars = [...z.actors.values()].some((a) => a instanceof CharActor);
    const hasCombat = [...z.actors.values()].some((a) => a.combatId);
    if (hasChars || hasCombat) return;
    // Persist monster positions and reset unengaged monsters.
    for (const a of z.actors.values()) {
      if (a instanceof MonsterActor) {
        a.rt.x = Math.round(a.homeX);
        a.rt.y = Math.round(a.homeY);
        if (a.alive()) a.rt.hp = a.stats().maxHp;
      }
      if (a instanceof NpcActor) {
        a.rt.x = Math.round(a.x);
        a.rt.y = Math.round(a.y);
      }
    }
    this.zones.delete(zoneId);
  }

  zoneMap(zoneId: string): ZoneMap {
    return this.ctx.map(zoneId);
  }

  actorsInZone(zoneId: string): Actor[] {
    return [...(this.zones.get(zoneId)?.actors.values() ?? [])];
  }

  private gateClosed(zoneId: string, x: number, y: number) {
    const map = this.ctx.map(zoneId);
    for (const f of map.def.features) if (f.kind === 'gate' && f.x === x && f.y === y) return !this.zoneRuntime(zoneId).features[f.id]?.toggled;
    return false;
  }

  passable(zoneId: string, x: number, y: number): boolean {
    const map = this.ctx.map(zoneId);
    const W = map.def.width;
    if (x < 0 || y < 0 || x >= W || y >= map.def.height) return false;
    const i = y * W + x;
    if (map.solid[i]) {
      // Gates are solid unless opened.
      const gate = map.def.features.find((f) => f.kind === 'gate' && f.x === x && f.y === y);
      return !!gate && !!this.zoneRuntime(zoneId).features[gate.id]?.toggled;
    }
    return true;
  }

  isFree(zoneId: string, x: number, y: number, ignoreId?: string): boolean {
    if (!this.passable(zoneId, x, y)) return false;
    for (const a of this.actorsInZone(zoneId)) if (a.id !== ignoreId && (a.alive() || (a instanceof CharActor && a.ch.downed)) && Math.round(a.x) === x && Math.round(a.y) === y) return false;
    return true;
  }

  private nearestFree(zoneId: string, p: Vec2, ignoreId?: string): Vec2 {
    for (let r = 0; r < 6; r++)
      for (const t of tilesInRadius(p.x, p.y, r + 0.5, this.ctx.map(zoneId).def.width, this.ctx.map(zoneId).def.height))
        if (this.isFree(zoneId, t.x, t.y, ignoreId)) return t;
    return p;
  }

  surfaces(zoneId: string): Surface[] {
    return this.zoneRuntime(zoneId).surfaces;
  }

  surfacesChanged(zoneId: string) {
    const z = this.zones.get(zoneId);
    if (z) z.surfacesDirty = true;
  }

  // =================================================================== party spawning & zone transfer

  private loneWolf(p: PlayerState) {
    return p.party.length <= 1;
  }

  private charActors(p: PlayerState): CharActor[] {
    const z = this.zones.get(p.zoneId);
    if (!z) return [];
    return p.party.map((c) => z.actors.get(c.id)).filter((a): a is CharActor => a instanceof CharActor);
  }

  private leader(p: PlayerState): CharActor | undefined {
    const all = this.charActors(p);
    return all.find((a) => a.id === p.leaderId && a.alive()) ?? all.find((a) => a.alive()) ?? all[0];
  }

  private spawnParty(p: PlayerState, at?: Vec2) {
    const z = this.live(p.zoneId);
    const base = this.nearestFree(p.zoneId, at ?? { x: Math.round(p.x), y: Math.round(p.y) });
    p.party.forEach((ch, i) => {
      const spot = i === 0 ? base : this.nearestFree(p.zoneId, { x: base.x + ((i % 2) ? 1 : -1), y: base.y + (i > 1 ? 1 : 0) });
      const a = new CharActor(ch, p.userId, p.zoneId, spot.x, spot.y, this.world, () => this.loneWolf(p));
      z.actors.set(a.id, a);
      a.dirty = true;
    });
    p.x = base.x;
    p.y = base.y;
  }

  private despawnParty(p: PlayerState) {
    const z = this.zones.get(p.zoneId);
    if (!z) return;
    const leader = this.leader(p);
    if (leader) {
      p.x = Math.round(leader.x);
      p.y = Math.round(leader.y);
    }
    for (const c of p.party) {
      const a = z.actors.get(c.id);
      if (!a) continue;
      if (a.combatId) this.combats.get(a.combatId)?.remove(a);
      z.actors.delete(c.id);
      this.broadcastZone(p.zoneId, { t: 'entities', upsert: [], remove: [c.id] });
    }
    this.maybeUnloadZone(p.zoneId);
  }

  /** Move a player's party to another zone, arriving next to `targetFeatureId` or at the entry. */
  transfer(p: PlayerState, zoneId: string, targetFeatureId?: string, at?: Vec2) {
    if (!this.ctx.zones.has(zoneId)) return;
    if (this.charActors(p).some((a) => a.combatId)) return this.sendTo(p.userId, { t: 'toast', text: 'You cannot leave during combat.', kind: 'bad' });
    this.dialogue.close(p.userId);
    this.closeTrade(p.userId);
    this.pending.delete(p.userId);
    const fromZone = p.zoneId;
    this.despawnParty(p);
    const def = this.ctx.zones.get(zoneId)!;
    let arrive = at ?? def.entry;
    const tf = targetFeatureId ? def.features.find((f) => f.id === targetFeatureId) : undefined;
    if (tf && !at) {
      // Step off the exit tile toward the interior of the map.
      const cx = def.width / 2, cy = def.height / 2;
      const dx = Math.sign(cx - tf.x), dy = Math.sign(cy - tf.y);
      const cands = [{ x: tf.x + dx * 2, y: tf.y + dy * 2 }, { x: tf.x, y: tf.y + 1 }, { x: tf.x, y: tf.y - 1 }, { x: tf.x + 1, y: tf.y }, { x: tf.x - 1, y: tf.y }, { x: tf.x + dx, y: tf.y }, { x: tf.x, y: tf.y + dy }];
      this.live(zoneId);
      arrive = cands.find((c) => this.passable(zoneId, c.x, c.y)) ?? def.entry;
    }
    p.zoneId = zoneId;
    p.x = arrive.x;
    p.y = arrive.y;
    this.spawnParty(p, arrive);
    this.sendZone(p.userId);
    this.enteredZone(p, zoneId, false);
    this.sendPlayer(p.userId);
    this.maybeUnloadZone(fromZone);
  }

  private enteredZone(p: PlayerState, zoneId: string, silent: boolean) {
    const def = this.ctx.zones.get(zoneId)!;
    const outer = this.ctx.outerZone(zoneId);
    if (!p.visitedZones.includes(zoneId)) {
      p.visitedZones.push(zoneId);
      if (!silent && def.kind !== 'interior') {
        this.journal(p, 'discovery', `Discovered ${def.name}.`);
        this.sendTo(p.userId, { t: 'toast', text: `Discovered: ${def.name}`, kind: 'info' });
        if (def.kind !== 'town') this.grantPartyXp(p, 15 + def.levelRange[0] * 8);
      }
    }
    for (const l of [outer, ...(this.ctx.zones.get(outer)?.links ?? [])]) if (!p.knownZones.includes(l)) p.knownZones.push(l);
    if (def.kind === 'town') p.lastTownZoneId = zoneId;
    this.quests.onEnterZone(p, zoneId);
    // Community gatherings happening today.
    const ev = this.state.events.find((e) => !e.done && e.day === this.day() && this.ctx.outerZone(e.zoneId) === outer && e.about === p.userId);
    if (ev && def.kind === 'town') {
      ev.done = true;
      this.sendTo(p.userId, { t: 'narration', title: def.name, text: `The townsfolk have gathered in the square. As you arrive, faces turn toward you — and someone starts to cheer. They remembered: ${ev.reason}`, style: 'quest' });
      this.journal(p, 'social', `The people of ${def.name} gathered for you: ${ev.reason}`);
    }
    this.markPlayer(p.userId);
  }

  private applyGatherings(z: LiveZone) {
    const today = this.day();
    for (const ev of this.state.events) {
      if (ev.day !== today || ev.zoneId !== z.id) continue;
      ev.npcIds.forEach((id, i) => {
        const rt = this.state.npcs[id];
        if (!rt || !rt.alive || rt.partyOf) return;
        const angle = (i / Math.max(1, ev.npcIds.length)) * Math.PI * 2;
        const spot = this.nearestFree(z.id, { x: Math.round(ev.x + Math.cos(angle) * 3), y: Math.round(ev.y + Math.sin(angle) * 3) });
        const existing = [...this.zones.values()].map((lz) => lz.actors.get(id)).find(Boolean) as NpcActor | undefined;
        if (existing && existing.zoneId !== z.id) this.zones.get(existing.zoneId)?.actors.delete(id);
        rt.zoneId = z.id;
        rt.x = spot.x;
        rt.y = spot.y;
        const def = this.ctx.npcs.get(id)!;
        const a = (z.actors.get(id) as NpcActor) ?? new NpcActor(def, rt, z.id, this.world);
        a.x = spot.x;
        a.y = spot.y;
        a.homeX = spot.x;
        a.homeY = spot.y;
        a.zoneId = z.id;
        z.actors.set(id, a);
      });
    }
  }

  // =================================================================== views

  private featureStates(userId: string, zoneId: string): FeatureState[] {
    const map = this.ctx.map(zoneId);
    const rt = this.zoneRuntime(zoneId);
    const p = this.state.players[userId];
    return map.def.features
      .filter((f) => f.kind !== 'trap' || p?.revealedTraps.includes(f.id) || rt.features[f.id]?.triggered || rt.features[f.id]?.disarmed)
      .map((f) => {
        const r = rt.features[f.id] ?? {};
        return { id: f.id, opened: r.opened, unlocked: r.unlocked, disarmed: r.disarmed, triggered: r.triggered, toggled: r.toggled, revealed: f.kind === 'trap' ? true : undefined, empty: f.kind === 'chest' && r.opened && !(r.loot?.length || r.lootGold) };
      });
  }

  private visibleFeatures(userId: string, zoneId: string): FeatureDef[] {
    const p = this.state.players[userId];
    const rt = this.zoneRuntime(zoneId);
    return this.ctx.map(zoneId).def.features.filter((f) => f.kind !== 'trap' || p?.revealedTraps.includes(f.id) || rt.features[f.id]?.triggered || rt.features[f.id]?.disarmed);
  }

  private entityView(a: Actor): EntityView {
    return a.view(this.world);
  }

  private visibleLoot(userId: string, zoneId: string): LootPile[] {
    return this.zoneRuntime(zoneId).loot.filter((l) => !l.ownerUserId || l.ownerUserId === userId);
  }

  sendZone(userId: string) {
    const p = this.state.players[userId];
    if (!p) return;
    const z = this.live(p.zoneId);
    const def = z.map.def;
    const { spawns, lore, ...zoneView } = def;
    void spawns, lore;
    const explored = p.explored[def.id] ?? new BitSet(def.width * def.height).encode();
    this.sendTo(userId, {
      t: 'zone',
      zone: { ...zoneView, features: this.visibleFeatures(userId, def.id) },
      entities: [...z.actors.values()].map((a) => this.entityView(a)),
      features: this.featureStates(userId, def.id),
      surfaces: z.rt.surfaces,
      loot: this.visibleLoot(userId, def.id),
      explored,
    });
  }

  private playerView(p: PlayerState): PlayerView {
    const questDefs: Record<string, QuestDef> = {};
    for (const id of Object.keys(p.quests)) {
      const d = this.questDef(id);
      if (d) questDefs[id] = d;
    }
    const npcMarkers: PlayerView['npcMarkers'] = {};
    for (const n of this.world.npcs) {
      if (this.dialogue.availableQuests(p, n).length) npcMarkers[n.id] = 'quest';
    }
    for (const [qid, prog] of Object.entries(p.quests)) {
      if (prog.status !== 'active') continue;
      const def = questDefs[qid];
      if (!def) continue;
      const objs = objectivesOf(def, prog);
      const cur = objs[currentObjectiveIndex(def, prog)];
      if (cur?.npcId) npcMarkers[cur.npcId] = currentObjectiveIndex(def, prog) === objs.length - 1 ? 'turnin' : 'progress';
    }
    const dynamicItems: PlayerView['dynamicItems'] = {};
    for (const [k, v] of Object.entries(this.state.dynamicItems ?? {})) dynamicItems[k] = { name: v.name, description: v.description };
    const waypoints = p.visitedZones
      .map((id) => this.ctx.zones.get(id)!)
      .filter((z) => z && z.kind === 'town')
      .map((z) => ({ zoneId: z.id, name: z.name }));
    return { ...p, questDefs, loneWolf: this.loneWolf(p), npcMarkers, dynamicItems, waypoints, isOwner: this.state.ownerId === p.userId };
  }

  sendPlayer(userId: string) {
    const p = this.state.players[userId];
    if (!p) return;
    // Keep the explored map persisted.
    this.sendTo(userId, { t: 'player', player: this.playerView(p) });
  }

  private sendClock(force = false) {
    const now = Date.now();
    if (!force && now - this.lastClockSent < 5000) return;
    this.lastClockSent = now;
    const msg: ServerMessage = { t: 'clock', clock: { minute: this.state.clock, day: this.day(), hour: this.hour(), at: now, paused: this.isPaused() } };
    for (const userId of this.conns.keys()) this.sendTo(userId, msg);
  }

  fx(zoneId: string, events: FxEvent[]) {
    if (events.length) this.broadcastZone(zoneId, { t: 'fx', events });
  }

  log(zoneId: string, text: string, color?: string) {
    this.broadcastZone(zoneId, { t: 'log', text, color });
  }

  private journal(p: PlayerState, kind: JournalEntry['kind'], text: string) {
    const entry: JournalEntry = { day: this.day(), minute: Math.round(this.state.clock), kind, text };
    p.journal.push(entry);
    if (p.journal.length > 300) p.journal.shift();
    this.sendTo(p.userId, { t: 'journal', entry });
  }

  // =================================================================== tick

  private tick() {
    const now = Date.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (!this.isPaused()) {
      const before = this.day();
      this.state.clock += dt / REAL_MS_PER_GAME_MINUTE;
      if (this.day() !== before) this.newDay();
    }
    const doAggro = now - this.lastAggro > 250;
    if (doAggro) this.lastAggro = now;
    const doRegen = now - this.lastRegen > 1000;
    if (doRegen) this.lastRegen = now;
    for (const z of this.zones.values()) {
      for (const a of z.actors.values()) {
        if (a.motion && !a.combatId) this.advanceMotion(z, a, now);
        if (!a.combatId) {
          if (a instanceof MonsterActor && a.alive()) this.monsterIdle(z, a, now);
          if (a instanceof NpcActor && a.alive()) this.npcIdle(z, a, now);
        }
        if (a.bark && a.bark.until < now) {
          a.bark = undefined;
          a.dirty = true;
        }
      }
      if (doAggro) this.checkAggro(z);
      if (doRegen) this.regen(z);
      if (now - z.lastSurfaceDecay > 6000) {
        z.lastSurfaceDecay = now;
        const inCombat = [...z.actors.values()].some((a) => a.combatId);
        if (!inCombat && z.rt.surfaces.length) {
          for (const s of z.rt.surfaces) s.turns--;
          z.rt.surfaces = z.rt.surfaces.filter((s) => s.turns > 0);
          z.surfacesDirty = true;
        }
      }
      this.flushZone(z);
    }
    for (const userId of this.dirtyPlayers) this.sendPlayer(userId);
    this.dirtyPlayers.clear();
    this.sendClock();
    if (this.dirtySince && now - this.dirtySince > 30_000) this.save();
  }

  private newDay() {
    this.markDirty();
    for (const z of this.zones.values()) this.applyGatherings(z);
  }

  private flushZone(z: LiveZone) {
    const changed: EntityView[] = [];
    for (const a of z.actors.values())
      if (a.dirty) {
        a.dirty = false;
        changed.push(this.entityView(a));
      }
    if (changed.length) this.broadcastZone(z.id, { t: 'entities', upsert: changed, remove: [] });
    if (z.surfacesDirty) {
      z.surfacesDirty = false;
      this.broadcastZone(z.id, { t: 'surfaces', surfaces: z.rt.surfaces });
    }
    if (z.featuresDirty.size) {
      z.featuresDirty.clear();
      this.broadcastZone(z.id, (userId) => ({ t: 'features', features: this.featureStates(userId, z.id) }));
    }
    if (z.lootDirty) {
      z.lootDirty = false;
      this.broadcastZone(z.id, (userId) => ({ t: 'loot_piles', loot: this.visibleLoot(userId, z.id) }));
    }
  }

  private advanceMotion(z: LiveZone, a: Actor, now: number) {
    const m = a.motion!;
    const s = sampleMotion(m, now);
    const tileBefore = { x: Math.round(a.x), y: Math.round(a.y) };
    a.x = s.x;
    a.y = s.y;
    a.facing = s.facing;
    const tile = { x: Math.round(a.x), y: Math.round(a.y) };
    if (tile.x !== tileBefore.x || tile.y !== tileBefore.y) this.onEnterTile(z, a, tile);
    if (!a.motion) return; // stopped by a trap or transfer
    if (s.done) {
      const last = m.path[m.path.length - 1] ?? m.from;
      a.x = last.x;
      a.y = last.y;
      a.motion = null;
      a.dirty = true;
      if (a instanceof CharActor) this.arrived(a);
    }
  }

  private onEnterTile(z: LiveZone, a: Actor, tile: Vec2) {
    if (!(a instanceof CharActor)) return;
    const p = this.state.players[a.userId];
    if (!p) return;
    // Exploration memory.
    const def = z.map.def;
    const bs = new BitSet(def.width * def.height, p.explored[def.id]);
    let changed = false;
    for (const t of tilesInRadius(tile.x, tile.y, 11, def.width, def.height)) if (bs.set(t.y * def.width + t.x)) changed = true;
    if (changed) p.explored[def.id] = bs.encode();
    // Traps: detection, then triggering.
    this.detectTraps(z, a, p);
    const trap = def.features.find((f) => f.kind === 'trap' && f.x === tile.x && f.y === tile.y);
    if (trap && !z.rt.features[trap.id]?.disarmed && !z.rt.features[trap.id]?.triggered) this.triggerTrap(z, trap, a);
    const surf = z.rt.surfaces.find((s) => s.x === tile.x && s.y === tile.y);
    if (surf && !a.combatId && (surf.type === 'fire' || surf.type === 'poison')) applySurface(this, a, surf);
    // Edge exits trigger when the leader walks onto them.
    if (a.id === p.leaderId || a === this.leader(p)) {
      const exit = def.features.find((f) => f.kind === 'exit' && f.facing && f.x === tile.x && f.y === tile.y);
      if (exit?.targetZoneId) this.transfer(p, exit.targetZoneId, exit.targetFeatureId);
    }
  }

  private detectTraps(z: LiveZone, a: CharActor, p: PlayerState) {
    const stats = a.stats();
    const keen = p.party.some((c) => c.skills.includes('keen_eye'));
    const radius = 2.5 + Math.max(0, stats.attributes.wits - 10) * 0.25 + (keen ? 3 : 0);
    const chance = 0.45 + (stats.attributes.wits - 10) * 0.04 + (keen ? 0.35 : 0);
    for (const f of z.map.def.features) {
      if (f.kind !== 'trap' || p.revealedTraps.includes(f.id)) continue;
      const fr = z.rt.features[f.id];
      if (fr?.disarmed || fr?.triggered) continue;
      if (Math.hypot(f.x - a.x, f.y - a.y) > radius) continue;
      if (hashFloat(f.id, a.id, Math.floor(radius)) < chance) {
        p.revealedTraps.push(f.id);
        z.featuresDirty.add(f.id);
        this.sendTo(p.userId, { t: 'toast', text: `${a.name} spots a ${this.world.trapNames[f.trapKind ?? 'spike'] ?? 'trap'}!`, kind: 'info' });
        this.sendTo(p.userId, { t: 'zone', ...this.zonePayload(p.userId) });
        this.markPlayer(p.userId);
      }
    }
  }

  private zonePayload(userId: string) {
    const p = this.state.players[userId]!;
    const z = this.live(p.zoneId);
    const { spawns, lore, ...zoneView } = z.map.def;
    void spawns, lore;
    return {
      zone: { ...zoneView, features: this.visibleFeatures(userId, z.id) },
      entities: [...z.actors.values()].map((a) => this.entityView(a)),
      features: this.featureStates(userId, z.id),
      surfaces: z.rt.surfaces,
      loot: this.visibleLoot(userId, z.id),
      explored: p.explored[z.id] ?? new BitSet(z.map.def.width * z.map.def.height).encode(),
    };
  }

  /** Combat movement trap check. */
  checkTrapsAlong(a: Actor, path: Vec2[]): number {
    const z = this.zones.get(a.zoneId);
    if (!z || !(a instanceof CharActor)) return -1;
    for (let i = 0; i < path.length; i++) {
      const t = path[i]!;
      const trap = z.map.def.features.find((f) => f.kind === 'trap' && f.x === t.x && f.y === t.y && !z.rt.features[f.id]?.disarmed && !z.rt.features[f.id]?.triggered);
      if (trap) {
        setTimeout(() => this.triggerTrap(z, trap, a), Combat.instant ? 0 : (i / WALK_SPEED) * 1000);
        return i;
      }
    }
    return -1;
  }

  private triggerTrap(z: LiveZone, trap: FeatureDef, victim: Actor) {
    const fr = (z.rt.features[trap.id] ??= {});
    if (fr.triggered || fr.disarmed) return;
    fr.triggered = true;
    z.featuresDirty.add(trap.id);
    const kind = trap.trapKind ?? 'spike';
    const info = TRAP_INFO[kind];
    const power = trapPower(trap.trapLevel ?? 1) * info.mult;
    if (!victim.combatId) victim.motion = null;
    victim.x = trap.x;
    victim.y = trap.y;
    victim.dirty = true;
    this.fx(z.id, [{ kind: 'trap', x: trap.x, y: trap.y, text: this.world.trapNames[kind] ?? info.defaultName, element: info.damage, radius: info.radius }]);
    const targets = info.radius > 0 ? [...z.actors.values()].filter((a) => a.alive() && Math.hypot(a.x - trap.x, a.y - trap.y) <= info.radius + 0.01 && a.team() === 'players') : [victim];
    for (const t of targets) {
      dealDamage(this, null, t, Math.round(power * (0.85 + this.rng.next() * 0.3)), info.damage);
      if (info.status && t.alive()) addStatus(this, t, info.status, 2, power);
    }
    if (info.surface) createSurface(this, z.id, trap, info.surface, info.radius || 1, 3, power);
    if (kind === 'alarm') {
      this.log(z.id, 'An alarm rings out!', '#ff8060');
      const nearby = [...z.actors.values()].filter((a) => a instanceof MonsterActor && a.alive() && !a.combatId && Math.hypot(a.x - trap.x, a.y - trap.y) < 18);
      if (nearby.length) this.startCombat(z, nearby[0]!, victim, false);
    }
  }

  private monsterIdle(z: LiveZone, a: MonsterActor, now: number) {
    if (a.motion || now < a.nextWanderAt) return;
    a.nextWanderAt = now + 3000 + this.rng.next() * 7000;
    if (a.boss || this.rng.chance(0.4)) return;
    const tx = Math.round(a.homeX + this.rng.int(-3, 3)), ty = Math.round(a.homeY + this.rng.int(-3, 3));
    if (!this.passable(z.id, tx, ty)) return;
    const path = findPath(a, { x: tx, y: ty }, { width: z.map.def.width, height: z.map.def.height, passable: (x, y) => this.passable(z.id, x, y), maxNodes: 400 });
    if (path?.length) {
      a.motion = { path, from: { x: Math.round(a.x), y: Math.round(a.y) }, speed: 1.6, t0: now };
      a.x = Math.round(a.x);
      a.y = Math.round(a.y);
      a.dirty = true;
    }
  }

  private npcIdle(z: LiveZone, a: NpcActor, now: number) {
    // Barks near players.
    if (now > a.nextBarkAt && !a.talkingTo) {
      const near = [...z.actors.values()].find((x) => x instanceof CharActor && Math.hypot(x.x - a.x, x.y - a.y) < 5.5) as CharActor | undefined;
      if (near) {
        a.nextBarkAt = now + 25000 + this.rng.next() * 40000;
        const due = a.rt.memories.find((m) => m.about === near.userId && m.dueDay !== undefined && m.dueDay <= this.day() && !m.fulfilled);
        const p = this.state.players[near.userId];
        const text = due && p ? `${p.name}! Come here — I remembered!` : a.def.barks.length ? this.rng.pick(a.def.barks) : '';
        if (text) {
          a.bark = { text, until: now + 4500 };
          a.dirty = true;
        }
      } else a.nextBarkAt = now + 3000;
    }
    if (!a.def.wanders || a.motion || a.talkingTo || now < a.nextWanderAt) return;
    a.nextWanderAt = now + 5000 + this.rng.next() * 9000;
    if (this.rng.chance(0.45)) return;
    const tx = Math.round(a.homeX + this.rng.int(-4, 4)), ty = Math.round(a.homeY + this.rng.int(-4, 4));
    if (!this.passable(z.id, tx, ty)) return;
    const path = findPath(a, { x: tx, y: ty }, { width: z.map.def.width, height: z.map.def.height, passable: (x, y) => this.passable(z.id, x, y), maxNodes: 500 });
    if (path?.length) {
      a.motion = { path, from: { x: Math.round(a.x), y: Math.round(a.y) }, speed: 1.3, t0: now };
      a.x = Math.round(a.x);
      a.y = Math.round(a.y);
      a.dirty = true;
    }
  }

  private regen(z: LiveZone) {
    for (const a of z.actors.values()) {
      if (a.combatId || !(a instanceof CharActor)) continue;
      if (a.ch.downed) continue;
      const s = a.stats();
      const before = [a.hp, a.physArmor, a.magArmor, a.stamina, a.focus];
      a.hp = Math.min(s.maxHp, a.hp + Math.max(1, s.maxHp * 0.02));
      a.physArmor = Math.min(s.maxPhys, a.physArmor + Math.max(1, s.maxPhys * 0.15));
      a.magArmor = Math.min(s.maxMag, a.magArmor + Math.max(1, s.maxMag * 0.15));
      a.stamina = Math.min(s.maxStamina, a.stamina + Math.max(1, s.maxStamina * 0.08));
      a.focus = Math.min(s.maxFocus, a.focus + Math.max(1, s.maxFocus * 0.08));
      // Real-time skill cooldowns tick down each second out of combat.
      for (const k of Object.keys(a.cooldowns)) if (--a.cooldowns[k]! <= 0) delete a.cooldowns[k];
      if (a.statuses.length) a.statuses = a.statuses.filter((st) => !STATUS_INFO[st.id].harmful || this.rng.chance(0.85)).map((st) => ({ ...st, turns: st.turns - (this.rng.chance(0.3) ? 1 : 0) })).filter((st) => st.turns > 0);
      const after = [a.hp, a.physArmor, a.magArmor, a.stamina, a.focus];
      if (after.some((v, i) => Math.round(v) !== Math.round(before[i]!))) {
        a.dirty = true;
        this.markPlayer(a.userId);
      }
    }
  }

  // =================================================================== aggro & combat

  private checkAggro(z: LiveZone) {
    const chars = [...z.actors.values()].filter((a): a is CharActor => a instanceof CharActor && a.alive() && !a.combatId);
    if (!chars.length) return;
    const W = z.map.def.width;
    for (const a of z.actors.values()) {
      if (a.combatId || !a.alive()) continue;
      const hostile = a instanceof MonsterActor || (a instanceof NpcActor && a.rt.hostileTo.length > 0);
      if (!hostile) continue;
      const radius = a instanceof MonsterActor && a.boss ? AGGRO_RADIUS + 2 : AGGRO_RADIUS;
      for (const c of chars) {
        if (!isHostileTo(a, c)) continue;
        const d = Math.hypot(a.x - c.x, a.y - c.y);
        if (d > radius) continue;
        let los = true;
        const ax = Math.round(a.x), ay = Math.round(a.y), cx = Math.round(c.x), cy = Math.round(c.y);
        const steps = Math.max(Math.abs(ax - cx), Math.abs(ay - cy));
        for (let i = 1; i < steps; i++) {
          const x = Math.round(ax + ((cx - ax) * i) / steps), y = Math.round(ay + ((cy - ay) * i) / steps);
          if (z.map.opaque[y * W + x]) {
            los = false;
            break;
          }
        }
        if (!los) continue;
        this.startCombat(z, a, c, false);
        return;
      }
    }
  }

  /** Start (or join) combat between `enemy` (and its group) and `trigger`'s side. */
  startCombat(z: LiveZone, enemy: Actor, trigger: Actor, playersFirst: boolean): Combat | null {
    const existingId = enemy.combatId ?? trigger.combatId;
    const existing = existingId ? this.combats.get(existingId) : undefined;
    const combat = existing ?? new Combat(uid('cb'), z.id, this);
    const enemies = new Set<Actor>();
    const addEnemy = (e: Actor) => {
      if (enemies.has(e) || !e.alive()) return;
      enemies.add(e);
      if (e instanceof MonsterActor) {
        for (const o of z.actors.values()) if (o instanceof MonsterActor && o.alive() && o.spawn.groupId === e.spawn.groupId) addEnemy(o);
      }
    };
    addEnemy(enemy);
    // Nearby hostile monsters join too.
    for (const e of [...enemies]) for (const o of z.actors.values()) if (o.alive() && (o instanceof MonsterActor) && !o.combatId && Math.hypot(o.x - e.x, o.y - e.y) < 5) addEnemy(o);
    const players = new Set<Actor>();
    for (const o of z.actors.values()) {
      if (!(o instanceof CharActor) || !o.alive() || o.combatId) continue;
      if ([...enemies].some((e) => Math.hypot(e.x - o.x, e.y - o.y) < JOIN_RADIUS) || o === trigger) players.add(o);
    }
    if (trigger instanceof CharActor) {
      const p = this.state.players[trigger.userId];
      if (p) for (const c of this.charActors(p)) if (c.alive() && !c.combatId && Math.hypot(c.x - trigger.x, c.y - trigger.y) < JOIN_RADIUS + 6) players.add(c);
    }
    if (!players.size || !enemies.size) return null;
    const isNew = !existing;
    if (isNew) this.combats.set(combat.id, combat);
    for (const a of [...players, ...enemies]) {
      if (a.combatId === combat.id) continue;
      a.motion = null;
      const spot = this.nearestFree(z.id, { x: Math.round(a.x), y: Math.round(a.y) }, a.id);
      a.x = spot.x;
      a.y = spot.y;
      combat.add(a, playersFirst && a.team() === 'players' ? 100 : 0);
      if (a instanceof CharActor) {
        this.dialogue.close(a.userId);
        this.closeTrade(a.userId);
        this.pending.delete(a.userId);
      }
    }
    if (isNew) {
      const boss = [...enemies].find((e) => e instanceof MonsterActor && e.boss) as MonsterActor | undefined;
      if (boss?.boss?.taunt) {
        boss.bark = { text: boss.boss.taunt, until: Date.now() + 5000 };
        boss.dirty = true;
      }
      this.log(z.id, 'Combat begins!', '#ff8060');
      combat.start();
    } else this.broadcastCombat(combat);
    return combat;
  }

  broadcastCombat(c: Combat) {
    const view = c.view();
    for (const userId of this.playersInCombat(c)) this.sendTo(userId, { t: 'combat', combat: view });
    // Others in the zone see the combat too (spectators).
    this.broadcastZone(c.zoneId, (u) => (this.playersInCombat(c).includes(u) ? null : { t: 'combat', combat: view }));
    for (const a of c.participants()) if (a instanceof CharActor) this.markPlayer(a.userId);
  }

  playersInCombat(c: Combat): string[] {
    return [...new Set(c.participants().filter((a): a is CharActor => a instanceof CharActor).map((a) => a.userId))];
  }

  isMultiplayer(c: Combat): boolean {
    return this.playersInCombat(c).length > 1;
  }

  commandCompanions(userId: string): boolean {
    return !!this.state.players[userId]?.commandCompanions;
  }

  sendError(userId: string, msg: string) {
    this.sendTo(userId, { t: 'toast', text: msg, kind: 'bad' });
  }

  combatEnded(c: Combat, victory: boolean) {
    this.combats.delete(c.id);
    const z = this.zones.get(c.zoneId);
    const users = this.playersInCombat(c);
    for (const a of c.participants()) {
      a.dirty = true;
      if (a instanceof MonsterActor && a.alive()) a.restoreArmor();
    }
    if (victory) {
      for (const a of c.participants()) {
        if (a instanceof CharActor) {
          if (a.ch.downed) {
            a.ch.downed = false;
            a.ch.hp = Math.max(1, Math.round(a.stats().maxHp * 0.2));
          }
          a.statuses = a.statuses.filter((s) => !STATUS_INFO[s.id].harmful);
          a.ch.cooldowns = {};
        }
      }
      for (const u of users) this.sendTo(u, { t: 'toast', text: 'Victory!', kind: 'good' });
      if (z) z.rt.surfaces = z.rt.surfaces.filter((s) => s.type === 'water' || s.type === 'ice'), (z.surfacesDirty = true);
    } else {
      for (const u of users) this.defeat(u);
      // Survivors heal up and return home.
      for (const a of c.participants()) if (a instanceof MonsterActor && a.alive()) a.resetPools();
    }
    for (const u of users) {
      this.sendTo(u, { t: 'combat', combat: null });
      this.markPlayer(u);
    }
    if (z) this.broadcastZone(z.id, { t: 'combat', combat: null });
    this.markDirty();
  }

  private defeat(userId: string) {
    const p = this.state.players[userId];
    if (!p) return;
    p.stats.deaths++;
    const lost = Math.floor(p.gold * 0.1);
    p.gold -= lost;
    for (const ch of p.party) {
      restoreFully(ch, this.world, this.loneWolf(p));
      ch.hp = Math.round(ch.hp * 0.5);
    }
    this.journal(p, 'combat', `Defeated. You wake in ${this.ctx.zones.get(p.lastTownZoneId)?.name}${lost ? `, ${lost} ${this.world.terminology.gold} lighter` : ''}.`);
    this.sendTo(userId, { t: 'narration', title: 'Defeat', text: `Darkness takes you... and then, slowly, light. You wake in ${this.ctx.zones.get(p.lastTownZoneId)?.name}, sore but alive.${lost ? ` Your purse feels ${lost} ${this.world.terminology.gold} lighter.` : ''}`, style: 'death' });
    const waypoint = this.ctx.zones.get(p.lastTownZoneId)?.features.find((f) => f.kind === 'waypoint');
    setTimeout(() => this.transfer(p, p.lastTownZoneId, undefined, waypoint ? { x: waypoint.x, y: waypoint.y + 1 } : undefined), 50);
  }

  // =================================================================== damage hooks

  onDamaged(target: Actor, source: Actor | null) {
    if (!source) return;
    // Hurting a neutral NPC makes them hostile.
    if (target instanceof NpcActor && source instanceof CharActor && !target.rt.hostileTo.includes(source.userId)) {
      target.rt.hostileTo.push(source.userId);
      target.rt.disposition[source.userId] = -100;
      target.dirty = true;
      this.npcGossip(target.def.id, `${this.state.players[source.userId]?.name ?? 'A stranger'} attacked ${target.def.name}!`, source.userId, 'town');
    }
    // Real-time damage pulls the victim's side into combat.
    if (!target.combatId || !source.combatId) {
      const z = this.zones.get(target.zoneId);
      if (z && isHostileTo(source, target) && target.alive()) {
        const enemy = source.team() === 'players' ? target : source;
        const trig = source.team() === 'players' ? source : target;
        this.startCombat(z, enemy, trig, source.team() === 'players');
      }
    }
  }

  onDowned(target: Actor, source: Actor | null) {
    const z = this.zones.get(target.zoneId);
    if (!z) return;
    if (target instanceof MonsterActor) {
      target.rt.dead = true;
      target.rt.diedAt = Date.now();
      target.rt.respawnDay = target.boss ? undefined : this.day() + 3;
      target.motion = null;
      target.dirty = true;
      this.fx(z.id, [{ kind: 'death', targetId: target.id, x: target.x, y: target.y }]);
      const combat = target.combatId ? this.combats.get(target.combatId) : undefined;
      const killers = new Set<string>();
      const participants = combat ? combat.participants() : source ? [source] : [];
      for (const a of participants) if (a instanceof CharActor) killers.add(a.userId);
      if (source instanceof CharActor) killers.add(source.userId);
      const xp = killXp(target.level, (target.boss ? 5 : target.spawn.elite ? 2 : 1) * ARCHETYPES[target.archetype].xp);
      for (const u of killers) {
        const p = this.state.players[u];
        if (!p) continue;
        p.stats.kills++;
        this.grantPartyXp(p, xp);
        this.quests.onKill(p, { familyId: target.family.id, archetype: target.archetype, bossId: target.boss?.id, zoneId: z.id });
        if (target.boss) {
          this.journal(p, 'combat', `Defeated ${target.boss.name}, ${target.boss.title}.`);
          this.npcGossip(null, `${p.name} defeated ${target.boss.name}, ${target.boss.title}.`, u, 'world');
        }
      }
      // Loot
      const lootFind = Math.max(0, ...[...killers].flatMap((u) => this.state.players[u]?.party.map((c) => statsOf(c, this.world, false).lootFind + (c.skills.includes('treasure_hunter') ? 30 : 0)) ?? [0]));
      const loot = rollLoot(this.world, this.rng, target.level, { lootFind, boss: !!target.boss, elite: target.spawn.elite });
      for (const u of target.boss?.drops ?? []) {
        const def = this.world.uniqueItems[u];
        if (def) loot.items.push({ id: uid('it'), baseId: def.baseId, level: target.level, rarity: def.rarity, affixes: def.affixes ?? [], qty: 1, uniqueId: u, bound: !!def.questItem, element: def.element });
      }
      if (loot.items.length || loot.gold) {
        z.rt.loot.push({ id: uid('lp'), x: Math.round(target.x), y: Math.round(target.y), items: loot.items, gold: loot.gold, label: target.name, createdAt: Date.now() });
        z.lootDirty = true;
      }
      setTimeout(() => {
        if (z.actors.get(target.id) === target && !target.alive()) {
          z.actors.delete(target.id);
          this.broadcastZone(z.id, { t: 'entities', upsert: [], remove: [target.id] });
        }
      }, 2500);
      this.markDirty();
    } else if (target instanceof NpcActor) {
      const killer = source instanceof CharActor ? source.userId : undefined;
      if (target.def.essential) {
        target.rt.hp = 1;
        target.rt.hostileTo = [];
        target.dirty = true;
        target.combatId && this.combats.get(target.combatId)?.remove(target);
        target.bark = { text: 'Enough! I yield!', until: Date.now() + 4000 };
        if (killer) {
          const p = this.state.players[killer];
          if (p) this.journal(p, 'social', `${target.def.name} yielded to you.`);
        }
        return;
      }
      target.rt.alive = false;
      target.dirty = true;
      this.fx(z.id, [{ kind: 'death', targetId: target.id, x: target.x, y: target.y }]);
      const items = [...target.rt.inventory];
      z.rt.loot.push({ id: uid('lp'), x: Math.round(target.x), y: Math.round(target.y), items, gold: target.rt.gold, label: target.def.name, createdAt: Date.now() });
      target.rt.inventory = [];
      target.rt.gold = 0;
      z.lootDirty = true;
      if (killer) {
        const p = this.state.players[killer];
        if (p) {
          this.quests.onKill(p, { npcId: target.def.id, zoneId: z.id });
          for (const [qid, prog] of Object.entries(p.quests)) {
            const q = this.questDef(qid);
            if (prog.status === 'active' && q && (q.giverNpcId === target.def.id || q.turnInNpcId === target.def.id) && !objectivesOf(q, prog).some((o) => o.type === 'kill_unique' && o.targetId === target.def.id))
              this.quests.fail(p, qid, `${target.def.name} is dead.`);
          }
          this.npcGossip(target.def.id, `${p.name} killed ${target.def.name}.`, killer, 'world');
        }
      }
      setTimeout(() => {
        if (z.actors.get(target.id) === target) {
          z.actors.delete(target.id);
          this.broadcastZone(z.id, { t: 'entities', upsert: [], remove: [target.id] });
        }
      }, 2500);
    } else if (target instanceof CharActor) {
      target.ch.downed = true;
      target.motion = null;
      target.dirty = true;
      this.fx(z.id, [{ kind: 'death', targetId: target.id, x: target.x, y: target.y }]);
      const p = this.state.players[target.userId];
      if (p && !target.combatId) {
        // Downed outside combat (traps): everyone else carries them; if all are down it's a defeat.
        if (this.charActors(p).every((a) => !a.alive())) this.defeat(p.userId);
        else
          setTimeout(() => {
            target.ch.downed = false;
            target.ch.hp = 1;
            target.dirty = true;
          }, 3000);
      }
      if (p && p.leaderId === target.id) {
        const next = this.charActors(p).find((a) => a.alive());
        if (next && !target.combatId) p.leaderId = next.id;
      }
      if (p) this.markPlayer(p.userId);
    }
  }

  actorMoved(a: Actor) {
    if (a instanceof CharActor) {
      const z = this.zones.get(a.zoneId);
      if (z) this.onEnterTile(z, a, { x: Math.round(a.x), y: Math.round(a.y) });
    }
  }

  private grantPartyXp(p: PlayerState, amount: number) {
    for (const ch of p.party) {
      const gained = grantXp(ch, amount, this.world);
      if (gained > 0) {
        const a = this.zones.get(p.zoneId)?.actors.get(ch.id);
        if (a) {
          a.dirty = true;
          this.fx(p.zoneId, [{ kind: 'levelup', targetId: ch.id, text: `${this.world.terminology.level} ${ch.level}` }]);
        }
        this.journal(p, 'system', `${ch.name} reached ${this.world.terminology.level.toLowerCase()} ${ch.level}.`);
        this.sendTo(p.userId, { t: 'toast', text: `${ch.name} reached ${this.world.terminology.level} ${ch.level}!`, kind: 'good' });
      }
    }
    this.markPlayer(p.userId);
  }

  // =================================================================== message handling

  handle(userId: string, msg: ClientMessage) {
    const p = this.state.players[userId];
    if (!p) return;
    try {
      switch (msg.t) {
        case 'move': return this.cmdMove(p, msg.x, msg.y, msg.charId);
        case 'interact': return this.cmdInteract(p, msg.targetId, msg.charId);
        case 'talk': return void this.dialogue.say(userId, msg.text, { giveItemId: msg.giveItemId, giveGold: msg.giveGold, useSkillId: msg.useSkillId });
        case 'end_dialog': return this.endDialog(userId);
        case 'use_skill': return this.cmdSkill(p, msg.charId, msg.skillId, msg.targetId, msg.x, msg.y);
        case 'use_item': return this.cmdItem(p, msg.charId, msg.itemId, msg.targetId, msg.x, msg.y);
        case 'equip': return this.cmdEquip(p, msg.charId, msg.itemId);
        case 'unequip': return this.cmdUnequip(p, msg.charId, msg.slot as EquipSlot);
        case 'drop_item': return this.cmdDrop(p, msg.itemId, msg.qty);
        case 'end_turn': return this.cmdEndTurn(p);
        case 'flee': return this.cmdFlee(p);
        case 'buy': return this.cmdBuy(p, msg.npcId, msg.itemId, msg.qty ?? 1);
        case 'sell': return this.cmdSell(p, msg.npcId, msg.itemId, msg.qty ?? 1);
        case 'end_trade': return this.closeTrade(userId);
        case 'craft': return this.cmdCraft(p, msg.recipeId);
        case 'take_loot': return this.cmdTakeLoot(p, msg.sourceId, msg.itemId, msg.all);
        case 'close_loot': this.lootOpen.delete(userId); return this.sendTo(userId, { t: 'loot', loot: null });
        case 'allocate': return this.cmdAllocate(p, msg.charId, msg.attribute);
        case 'learn_skill': return this.cmdLearn(p, msg.charId, msg.skillId);
        case 'set_hotbar': {
          const ch = p.party.find((c) => c.id === msg.charId);
          if (ch) ch.hotbar = msg.hotbar.slice(0, 10).map((s) => (s && (s === 'attack' || ch.skills.includes(s)) ? s : null));
          return this.markPlayer(userId);
        }
        case 'set_leader': {
          if (p.party.some((c) => c.id === msg.charId)) p.leaderId = msg.charId;
          return this.markPlayer(userId);
        }
        case 'rest': return this.cmdRest(p, false);
        case 'fast_travel': return this.cmdFastTravel(p, msg.zoneId);
        case 'hard_save': return this.hardSave?.(p, msg.name);
        case 'set_options': {
          if (msg.keepRunning !== undefined && this.state.ownerId === userId) this.state.keepRunning = msg.keepRunning;
          if (msg.open !== undefined && this.state.ownerId === userId) this.state.open = msg.open;
          if (msg.commandCompanions !== undefined) p.commandCompanions = msg.commandCompanions;
          this.markDirty();
          this.sendClock(true);
          return this.markPlayer(userId);
        }
        case 'abandon_quest': return this.quests.abandon(p, msg.questId);
        case 'dismiss_companion': {
          const ch = p.party.find((c) => c.id === msg.charId);
          if (ch?.npcId) this.leaveParty(userId, ch.npcId);
          return;
        }
        case 'chat': {
          const text = msg.text.slice(0, 300);
          for (const u of this.conns.keys()) this.sendTo(u, { t: 'chat', from: p.name, text });
          return;
        }
        default:
          return;
      }
    } catch (e) {
      console.error('[instance] handler error', msg.t, e);
      this.sendError(userId, 'Something went wrong.');
    }
  }

  hardSave?: (p: PlayerState, name: string) => void;

  private charFor(p: PlayerState, charId?: string): CharActor | undefined {
    const all = this.charActors(p);
    return (charId ? all.find((a) => a.id === charId) : undefined) ?? this.leader(p);
  }

  private combatOf(a: Actor): Combat | undefined {
    return a.combatId ? this.combats.get(a.combatId) : undefined;
  }

  private cmdMove(p: PlayerState, x: number, y: number, charId?: string) {
    const z = this.zones.get(p.zoneId);
    if (!z) return;
    const tx = Math.round(x), ty = Math.round(y);
    // Combat movement: the active character only.
    const inCombat = this.charActors(p).find((a) => a.combatId);
    if (inCombat) {
      const c = this.combatOf(inCombat)!;
      const active = c.active;
      if (!(active instanceof CharActor) || active.userId !== p.userId || !c.isHumanControlled(active)) return this.sendError(p.userId, 'Not your turn.');
      void c.move(active, { x: tx, y: ty }).then((err) => err && this.sendError(p.userId, err));
      return;
    }
    this.pending.delete(p.userId);
    this.pendingSkill.delete(p.userId);
    const leader = this.charFor(p, charId);
    if (!leader || !leader.alive()) return;
    this.walkParty(p, leader, { x: tx, y: ty }, 0);
  }

  /** Path the leader to a target; followers trail behind. */
  private walkParty(p: PlayerState, leader: CharActor, target: Vec2, stopWithin: number): boolean {
    const z = this.zones.get(p.zoneId)!;
    const W = z.map.def.width;
    const opts = {
      width: W,
      height: z.map.def.height,
      passable: (x: number, y: number) => this.passable(z.id, x, y),
      extraCost: (x: number, y: number) => (z.map.def.features.some((f) => f.kind === 'trap' && f.x === x && f.y === y && p.revealedTraps.includes(f.id) && !z.rt.features[f.id]?.disarmed && !z.rt.features[f.id]?.triggered) ? 40 : 0),
      stopWithin,
      allowBlockedGoal: stopWithin > 0,
      maxNodes: 30000,
    };
    const from = { x: Math.round(leader.x), y: Math.round(leader.y) };
    const path = findPath(from, target, opts);
    if (!path) return false;
    const now = Date.now();
    leader.motion = path.length ? { path, from, speed: WALK_SPEED, t0: now } : null;
    leader.x = from.x;
    leader.y = from.y;
    leader.dirty = true;
    if (!path.length) {
      this.arrived(leader);
      return true;
    }
    const dest = path[path.length - 1]!;
    const prev = path.length > 1 ? path[path.length - 2]! : from;
    const dir = { x: Math.sign(prev.x - dest.x) || 0, y: Math.sign(prev.y - dest.y) || 0 };
    const followers = this.charActors(p).filter((a) => a !== leader && a.alive());
    followers.forEach((f, i) => {
      const off = [
        { x: dir.x - dir.y, y: dir.y + dir.x },
        { x: dir.x + dir.y, y: dir.y - dir.x },
        { x: dir.x * 2, y: dir.y * 2 },
      ][i % 3]!;
      let goal = { x: dest.x + off.x, y: dest.y + off.y };
      if (!this.passable(z.id, goal.x, goal.y)) goal = prev;
      const ff = { x: Math.round(f.x), y: Math.round(f.y) };
      const fp = findPath(ff, goal, { ...opts, stopWithin: 0, allowBlockedGoal: false }) ?? findPath(ff, dest, { ...opts, stopWithin: 1.5, allowBlockedGoal: true });
      if (fp?.length) {
        f.motion = { path: fp, from: ff, speed: WALK_SPEED * 1.05, t0: now + 120 * (i + 1) };
        f.x = ff.x;
        f.y = ff.y;
        f.dirty = true;
      }
    });
    return true;
  }

  private arrived(a: CharActor) {
    const p = this.state.players[a.userId];
    if (!p) return;
    p.x = Math.round(a.x);
    p.y = Math.round(a.y);
    const pend = this.pending.get(p.userId);
    const ps = this.pendingSkill.get(p.userId);
    if (pend && pend.charId === a.id && ps && ps.targetId === pend.targetId) {
      this.pending.delete(p.userId);
      this.pendingSkill.delete(p.userId);
      this.cmdSkill(p, a.id, ps.skillId, ps.targetId);
      return;
    }
    if (pend && pend.charId === a.id) {
      this.pending.delete(p.userId);
      this.performInteraction(p, a, pend.targetId);
    }
  }

  private targetPos(p: PlayerState, targetId: string): { x: number; y: number; kind: 'actor' | 'feature' | 'loot' } | null {
    const z = this.zones.get(p.zoneId);
    if (!z) return null;
    const actor = z.actors.get(targetId);
    if (actor) return { x: Math.round(actor.x), y: Math.round(actor.y), kind: 'actor' };
    const f = z.map.features.get(targetId);
    if (f) return { x: f.x, y: f.y, kind: 'feature' };
    const l = z.rt.loot.find((x) => x.id === targetId);
    if (l) return { x: l.x, y: l.y, kind: 'loot' };
    return null;
  }

  private cmdInteract(p: PlayerState, targetId: string, charId?: string) {
    const leader = this.charFor(p, charId);
    if (!leader || !leader.alive()) return;
    if (leader.combatId) return this.sendError(p.userId, 'Not during combat.');
    const t = this.targetPos(p, targetId);
    if (!t) return;
    const d = Math.hypot(t.x - leader.x, t.y - leader.y);
    const reach = t.kind === 'loot' ? 1.1 : 1.6;
    if (d <= reach + 0.01) return this.performInteraction(p, leader, targetId);
    this.pending.set(p.userId, { targetId, charId: leader.id });
    const ok = this.walkParty(p, leader, t, t.kind === 'loot' ? 0.5 : 1.5);
    if (!ok) {
      this.pending.delete(p.userId);
      this.sendError(p.userId, "You can't reach that.");
    }
  }

  private performInteraction(p: PlayerState, a: CharActor, targetId: string) {
    const z = this.zones.get(p.zoneId);
    if (!z) return;
    const actor = z.actors.get(targetId);
    if (actor instanceof NpcActor) {
      if (!actor.alive()) return;
      if (actor.rt.hostileTo.includes(p.userId)) return void this.startCombat(z, actor, a, false);
      actor.talkingTo = p.userId;
      actor.motion = null;
      actor.facing = Math.atan2(a.y - actor.y, a.x - actor.x);
      actor.dirty = true;
      a.facing = Math.atan2(actor.y - a.y, actor.x - a.x);
      void this.dialogue.open(p.userId, actor.def.id);
      return;
    }
    if (actor instanceof MonsterActor && actor.alive()) {
      // Clicking an enemy attacks it.
      return this.cmdSkill(p, a.id, 'attack', actor.id);
    }
    const loot = z.rt.loot.find((l) => l.id === targetId);
    if (loot) return this.openLoot(p, loot.id);
    const f = z.map.features.get(targetId);
    if (f) this.useFeature(p, a, z, f);
  }

  private useFeature(p: PlayerState, a: CharActor, z: LiveZone, f: FeatureDef) {
    const fr = (z.rt.features[f.id] ??= {});
    const t = this.world.terminology;
    switch (f.kind) {
      case 'door':
      case 'exit':
        if (f.targetZoneId) this.transfer(p, f.targetZoneId, f.targetFeatureId);
        return;
      case 'chest': {
        if (f.lockLevel && !fr.unlocked) {
          const keyItem = f.keyUniqueId ? p.inventory.find((i) => i.uniqueId === f.keyUniqueId) : undefined;
          const canPick = p.party.some((c) => c.skills.includes('pick_lock'));
          const pick = p.inventory.find((i) => i.baseId === 'tool_lockpick');
          if (keyItem) fr.unlocked = true;
          else if (canPick || pick) {
            const wits = a.stats().attributes.wits;
            const chance = 0.35 + (wits - 10) * 0.04 + (a.level - f.lockLevel) * 0.06 + (canPick ? 0.3 : 0) + (pick ? 0.15 : 0);
            if (pick && !canPick) removeFromInventory(p.inventory, pick.id, 1);
            if (this.rng.chance(Math.max(0.1, Math.min(0.97, chance)))) {
              fr.unlocked = true;
              this.sendTo(p.userId, { t: 'toast', text: 'The lock clicks open.', kind: 'good' });
              this.grantPartyXp(p, 10 + f.lockLevel * 4);
            } else {
              this.sendTo(p.userId, { t: 'toast', text: pick && !canPick ? 'The lockpick snaps.' : 'The lock resists. Try again.', kind: 'bad' });
              this.markPlayer(p.userId);
              return;
            }
          } else {
            this.sendTo(p.userId, { t: 'toast', text: `Locked. You need a key, a ${this.world.itemNames.tool_lockpick?.names[0] ?? 'lockpick'}, or the ${skillName(this.ctx.naming, 'pick_lock')} skill.`, kind: 'bad' });
            return;
          }
        }
        if (!fr.opened) {
          fr.opened = true;
          const lootFind = Math.max(...p.party.map((c) => statsOf(c, this.world, false).lootFind + (c.skills.includes('treasure_hunter') ? 30 : 0)));
          const roll = rollLoot(this.world, new Rng(`${this.state.id}:${f.id}`), f.lootTier ?? 1, { chest: true, lootFind });
          fr.loot = roll.items;
          fr.lootGold = roll.gold;
          for (const u of f.items ?? []) {
            const def = this.world.uniqueItems[u];
            if (def) fr.loot.unshift({ id: uid('it'), baseId: def.baseId, level: f.lootTier ?? 1, rarity: def.rarity, affixes: def.affixes ?? [], qty: 1, uniqueId: u, bound: !!def.questItem, element: def.element });
          }
          z.featuresDirty.add(f.id);
        }
        return this.openLoot(p, f.id);
      }
      case 'trap':
        return this.tryDisarm(p, a, z, f, false);
      case 'shrine': {
        this.quests.onInteract(p, f.id);
        if (fr.usedDay === this.day()) return this.sendTo(p.userId, { t: 'toast', text: `${f.name ?? 'The shrine'} is quiet. Return tomorrow.`, kind: 'info' });
        fr.usedDay = this.day();
        for (const c of this.charActors(p)) {
          if (f.shrineEffect === 'empower') addStatus(this, c, 'empowered', 3, 0);
          else {
            const s = c.stats();
            if (c.ch.downed) c.ch.downed = false;
            c.hp = s.maxHp;
            c.stamina = s.maxStamina;
            c.focus = s.maxFocus;
          }
          c.dirty = true;
        }
        this.fx(z.id, [{ kind: 'skill', x: f.x, y: f.y, tx: f.x, ty: f.y, fx: 'heal', radius: 2 }]);
        this.sendTo(p.userId, { t: 'toast', text: `${f.name ?? 'Shrine'}: ${f.shrineEffect === 'empower' ? `you feel ${t.statuses.empowered.toLowerCase()}` : 'your party is restored'}.`, kind: 'good' });
        this.markPlayer(p.userId);
        return;
      }
      case 'sign':
        return this.sendTo(p.userId, { t: 'narration', title: f.name ?? 'Sign', text: f.text ?? '', style: 'quest' });
      case 'lore': {
        const note = this.world.lore.find((l) => l.id === f.loreId);
        if (!note) return;
        this.sendTo(p.userId, { t: 'narration', title: note.title, text: note.text, style: 'quest' });
        if (!fr.opened) {
          fr.opened = true;
          this.journal(p, 'story', `Read "${note.title}": ${note.text.slice(0, 220)}${note.text.length > 220 ? '…' : ''}`);
          this.grantPartyXp(p, 10 + a.level * 3);
          z.featuresDirty.add(f.id);
        }
        this.quests.onInteract(p, f.id);
        return;
      }
      case 'lever': {
        fr.toggled = !fr.toggled;
        z.featuresDirty.add(f.id);
        for (const gid of f.gateIds ?? []) {
          const g = (z.rt.features[gid] ??= {});
          g.toggled = fr.toggled;
          z.featuresDirty.add(gid);
        }
        this.fx(z.id, [{ kind: 'text', x: f.x, y: f.y, text: fr.toggled ? 'Clunk!' : 'Clank.', color: '#e0d0a0' }]);
        this.sendTo(p.userId, { t: 'toast', text: fr.toggled ? 'Somewhere, a gate grinds open.' : 'A gate slams shut.', kind: 'info' });
        this.quests.onInteract(p, f.id);
        return;
      }
      case 'gate':
        return this.sendTo(p.userId, { t: 'toast', text: z.rt.features[f.id]?.toggled ? 'The gate is open.' : 'The gate is sealed. Perhaps a mechanism opens it.', kind: 'info' });
      case 'bed':
        return this.cmdRest(p, true);
      case 'waypoint':
        this.sendTo(p.userId, { t: 'toast', text: 'Open your map (M) to travel between waypoints you have visited.', kind: 'info' });
        this.sendTo(p.userId, { t: 'narration', title: f.name ?? 'Waypoint', text: '__waypoint__', style: 'quest' });
        return;
      case 'craft_station':
        this.sendTo(p.userId, { t: 'narration', title: f.name ?? 'Workbench', text: '__craft__', style: 'quest' });
        return;
    }
  }

  private tryDisarm(p: PlayerState, a: CharActor, z: LiveZone, f: FeatureDef, viaSkill: boolean) {
    const fr = (z.rt.features[f.id] ??= {});
    if (fr.disarmed || fr.triggered) return;
    const hasSkill = p.party.some((c) => c.skills.includes('disarm_trap')) || viaSkill;
    const kit = p.inventory.find((i) => i.baseId === 'tool_trapkit');
    if (!hasSkill && !kit) return this.sendTo(p.userId, { t: 'toast', text: `You need a ${this.world.itemNames.tool_trapkit?.names[0] ?? 'trap kit'} or the ${skillName(this.ctx.naming, 'disarm_trap')} skill.`, kind: 'bad' });
    const wits = a.stats().attributes.wits;
    const chance = 0.4 + (wits - 10) * 0.03 + (a.level - (f.trapLevel ?? 1)) * 0.05 + (hasSkill ? 0.3 : 0) + (kit ? 0.2 : 0);
    if (kit && !hasSkill) removeFromInventory(p.inventory, kit.id, 1);
    if (this.rng.chance(Math.max(0.15, Math.min(0.97, chance)))) {
      fr.disarmed = true;
      z.featuresDirty.add(f.id);
      p.stats.trapsDisarmed++;
      this.grantPartyXp(p, 12 + (f.trapLevel ?? 1) * 5);
      this.quests.onDisarm(p);
      this.sendTo(p.userId, { t: 'toast', text: `Disarmed the ${this.world.trapNames[f.trapKind ?? 'spike']}.`, kind: 'good' });
      if (this.world.systems.crafting && this.rng.chance(0.5)) addToInventory(p.inventory, [makeItem(this.world, this.rng, 'm_ore', f.trapLevel ?? 1, 'common', 1)]);
    } else {
      this.sendTo(p.userId, { t: 'toast', text: 'You slip — the trap springs!', kind: 'bad' });
      this.triggerTrap(z, f, a);
    }
    this.markPlayer(p.userId);
  }

  private cmdSkill(p: PlayerState, charId: string, skillId: string, targetId?: string, x?: number, y?: number) {
    const a = this.charFor(p, charId);
    const z = this.zones.get(p.zoneId);
    if (!a || !z) return;
    const skill = getSkill(skillId);
    if (!skill || !a.skillIds().includes(skillId)) return this.sendError(p.userId, 'Unknown skill.');
    const target = targetId ? z.actors.get(targetId) : undefined;
    const point = x !== undefined && y !== undefined ? { x: Math.round(x), y: Math.round(y) } : undefined;
    const combat = this.charActors(p).map((c) => this.combatOf(c)).find(Boolean);
    if (combat) {
      const active = combat.active;
      if (!(active instanceof CharActor) || active.userId !== p.userId || !combat.isHumanControlled(active)) return this.sendError(p.userId, 'Not your turn.');
      const err = combat.useSkill(active, skillId, target, point);
      if (err) this.sendError(p.userId, err);
      this.markPlayer(p.userId);
      return;
    }
    // Utility skills on features.
    if (skill.utility === 'disarm_trap' || skill.utility === 'pick_lock') {
      const f = targetId ? z.map.features.get(targetId) : point ? z.map.def.features.find((ff) => ff.x === point.x && ff.y === point.y) : undefined;
      if (!f) return this.sendError(p.userId, 'Choose a trap or lock.');
      if (Math.hypot(f.x - a.x, f.y - a.y) > 1.7) {
        this.pending.set(p.userId, { targetId: f.id, charId: a.id });
        this.walkParty(p, a, f, 1.5);
        return;
      }
      if (f.kind === 'trap') return this.tryDisarm(p, a, z, f, true);
      return this.useFeature(p, a, z, f);
    }
    const use = { user: a, skill, target, point };
    const err = checkSkill(this, use, { inCombat: false });
    if (err) {
      // Out of range on an enemy: walk closer first (attack-move).
      if (target && isHostileTo(a, target) && (err === 'Out of range.' || err === 'No line of sight.')) {
        this.pending.set(p.userId, { targetId: target.id, charId: a.id });
        const range = skill.range === 'weapon' ? a.stats().weaponRange : skill.range;
        this.walkParty(p, a, { x: Math.round(target.x), y: Math.round(target.y) }, Math.max(1.4, range - 0.5));
        this.pendingSkill.set(p.userId, { skillId, targetId: target.id });
        return;
      }
      return this.sendError(p.userId, err);
    }
    a.motion = null;
    a.x = Math.round(a.x);
    a.y = Math.round(a.y);
    const hostileUse = target && isHostileTo(a, target);
    executeSkill(this, use, false);
    if (!hostileUse) this.markPlayer(p.userId);
    // Damage on an enemy started combat via onDamaged; give the attacker's side the first turn.
  }

  private pendingSkill = new Map<string, { skillId: string; targetId: string }>();

  private cmdItem(p: PlayerState, charId: string, itemId: string, targetId?: string, x?: number, y?: number) {
    const a = this.charFor(p, charId);
    const z = this.zones.get(p.zoneId);
    if (!a || !z) return;
    const item = p.inventory.find((i) => i.id === itemId);
    if (!item) return;
    const base = ITEM_BASE[item.baseId];
    if (!base) return;
    if (base.slot) return this.cmdEquip(p, a.id, itemId);
    if (base.consumable?.kind === 'skillbook') {
      if (!item.skillId) return;
      if (a.ch.skills.includes(item.skillId)) return this.sendError(p.userId, 'Already known.');
      a.ch.skills.push(item.skillId);
      if (a.ch.hotbar.length < 10) a.ch.hotbar.push(item.skillId);
      removeFromInventory(p.inventory, item.id, 1);
      this.sendTo(p.userId, { t: 'toast', text: `${a.name} learned ${skillName(this.ctx.naming, item.skillId)}.`, kind: 'good' });
      return this.markPlayer(p.userId);
    }
    if (base.consumable?.kind === 'recall') {
      if (a.combatId) return this.sendError(p.userId, 'Not during combat.');
      removeFromInventory(p.inventory, item.id, 1);
      const wp = this.ctx.zones.get(p.lastTownZoneId)?.features.find((f) => f.kind === 'waypoint');
      this.transfer(p, p.lastTownZoneId, undefined, wp ? { x: wp.x, y: wp.y + 1 } : undefined);
      return;
    }
    if (base.consumable?.kind === 'disarm' || base.consumable?.kind === 'unlock') {
      const f = targetId ? z.map.features.get(targetId) : undefined;
      if (f) return this.cmdInteract(p, f.id, a.id);
      return this.sendError(p.userId, base.consumable.kind === 'disarm' ? 'Click a detected trap to disarm it.' : 'Click a locked chest to pick it.');
    }
    const target = targetId ? z.actors.get(targetId) : undefined;
    const point = x !== undefined && y !== undefined ? { x, y } : undefined;
    const consume = () => removeFromInventory(p.inventory, item.id, 1);
    const combat = this.combatOf(a) ?? this.charActors(p).map((c) => this.combatOf(c)).find(Boolean);
    if (combat) {
      const active = combat.active;
      if (!(active instanceof CharActor) || active.userId !== p.userId) return this.sendError(p.userId, 'Not your turn.');
      const err = combat.useItem(active, item, target, point, consume);
      if (err) this.sendError(p.userId, err);
      return this.markPlayer(p.userId);
    }
    const err = checkItemUse(this, a, item, false, target, point);
    if (err) return this.sendError(p.userId, err);
    consume();
    useConsumable(this, a, item, false, target, point);
    this.markPlayer(p.userId);
  }

  private cmdEquip(p: PlayerState, charId: string, itemId: string) {
    const ch = p.party.find((c) => c.id === charId);
    const item = p.inventory.find((i) => i.id === itemId);
    if (!ch || !item) return;
    const actor = this.zones.get(p.zoneId)?.actors.get(ch.id);
    if (actor?.combatId) {
      const c = this.combatOf(actor)!;
      if (c.active !== actor) return this.sendError(p.userId, 'Not your turn.');
      if (actor.ap < 1) return this.sendError(p.userId, 'Not enough action points.');
      actor.ap -= 1;
      this.broadcastCombat(c);
    }
    const base = ITEM_BASE[item.baseId];
    if (!base?.slot) return this.sendError(p.userId, 'That cannot be equipped.');
    let slot: EquipSlot = base.slot;
    removeFromInventory(p.inventory, item.id, item.qty);
    const old = ch.equipment[slot];
    if (old) addToInventory(p.inventory, [old]);
    ch.equipment[slot] = item;
    if (slot === 'mainhand' && base.twoHanded && ch.equipment.offhand) {
      addToInventory(p.inventory, [ch.equipment.offhand]);
      delete ch.equipment.offhand;
    }
    if (slot === 'offhand' && ch.equipment.mainhand && ITEM_BASE[ch.equipment.mainhand.baseId]?.twoHanded) {
      addToInventory(p.inventory, [ch.equipment.mainhand]);
      delete ch.equipment.mainhand;
    }
    void slot;
    clampPools(ch, this.world, this.loneWolf(p));
    if (actor) actor.dirty = true;
    this.markPlayer(p.userId);
  }

  private cmdUnequip(p: PlayerState, charId: string, slot: EquipSlot) {
    const ch = p.party.find((c) => c.id === charId);
    if (!ch || !ch.equipment[slot]) return;
    const actor = this.zones.get(p.zoneId)?.actors.get(ch.id);
    if (actor?.combatId) return this.sendError(p.userId, 'Not during combat.');
    addToInventory(p.inventory, [ch.equipment[slot]!]);
    delete ch.equipment[slot];
    clampPools(ch, this.world, this.loneWolf(p));
    if (actor) actor.dirty = true;
    this.markPlayer(p.userId);
  }

  private cmdDrop(p: PlayerState, itemId: string, qty?: number) {
    const item = p.inventory.find((i) => i.id === itemId);
    if (!item) return;
    if (item.bound) return this.sendError(p.userId, 'You should hold on to that.');
    const it = removeFromInventory(p.inventory, itemId, qty ?? item.qty);
    const z = this.zones.get(p.zoneId);
    const leader = this.leader(p);
    if (it && z && leader) {
      z.rt.loot.push({ id: uid('lp'), x: Math.round(leader.x), y: Math.round(leader.y), items: [it], gold: 0, label: 'Dropped', ownerUserId: p.userId, createdAt: Date.now() });
      z.lootDirty = true;
    }
    this.markPlayer(p.userId);
  }

  private cmdEndTurn(p: PlayerState) {
    const combat = this.charActors(p).map((c) => this.combatOf(c)).find(Boolean);
    if (!combat) return;
    const active = combat.active;
    if (!(active instanceof CharActor) || active.userId !== p.userId) return this.sendError(p.userId, 'Not your turn.');
    const err = combat.endTurn(active);
    if (err) this.sendError(p.userId, err);
  }

  private cmdFlee(p: PlayerState) {
    const combat = this.charActors(p).map((c) => this.combatOf(c)).find(Boolean);
    if (!combat) return;
    const active = combat.active;
    if (!(active instanceof CharActor) || active.userId !== p.userId) return this.sendError(p.userId, 'Not your turn.');
    const enemiesNear = combat.participants().some((e) => e.alive() && isHostileTo(active, e) && Math.hypot(e.x - active.x, e.y - active.y) < 7);
    if (enemiesNear) return this.sendError(p.userId, 'Enemies are too close to flee.');
    for (const c of this.charActors(p)) if (c.combatId === combat.id) combat.remove(c);
    this.sendTo(p.userId, { t: 'combat', combat: null });
    this.sendTo(p.userId, { t: 'toast', text: 'You escaped.', kind: 'info' });
  }

  private cmdRest(p: PlayerState, bed: boolean) {
    if (this.charActors(p).some((a) => a.combatId)) return;
    const z = this.zones.get(p.zoneId);
    const hostilesNear = z && [...z.actors.values()].some((a) => a instanceof MonsterActor && a.alive() && Math.hypot(a.x - p.x, a.y - p.y) < 20);
    if (hostilesNear) return this.sendError(p.userId, 'You cannot rest with enemies nearby.');
    this.healParty(p.userId);
    if (bed) {
      const hour = this.hour();
      const toMorning = ((24 - hour + 7) % 24 || 24) * 60 - (this.state.clock % 60);
      const before = this.day();
      this.state.clock += toMorning;
      if (this.day() !== before) this.newDay();
      this.sendTo(p.userId, { t: 'narration', title: 'Rest', text: 'You sleep soundly and wake at dawn, restored.', style: 'quest' });
      this.sendClock(true);
    }
  }

  private cmdFastTravel(p: PlayerState, zoneId: string) {
    const z = this.ctx.zones.get(zoneId);
    if (!z || z.kind !== 'town' || !p.visitedZones.includes(zoneId)) return this.sendError(p.userId, 'You have not found that waypoint.');
    const here = this.zones.get(p.zoneId);
    const leader = this.leader(p);
    const nearWaypoint = here?.map.def.features.some((f) => f.kind === 'waypoint' && leader && Math.hypot(f.x - leader.x, f.y - leader.y) < 3);
    if (!nearWaypoint) return this.sendError(p.userId, 'Stand next to a waypoint to travel.');
    const wp = z.features.find((f) => f.kind === 'waypoint');
    this.transfer(p, zoneId, undefined, wp ? { x: wp.x, y: wp.y + 1 } : undefined);
  }

  private cmdAllocate(p: PlayerState, charId: string, attr: string) {
    const ch = p.party.find((c) => c.id === charId);
    if (!ch || ch.unspentAttributes <= 0 || !ATTRIBUTES.includes(attr as AttributeId)) return;
    ch.attributes[attr as AttributeId]++;
    ch.unspentAttributes--;
    const a = this.zones.get(p.zoneId)?.actors.get(ch.id);
    if (a) a.dirty = true;
    this.markPlayer(p.userId);
  }

  private cmdLearn(p: PlayerState, charId: string, skillId: string) {
    const ch = p.party.find((c) => c.id === charId);
    const s = SKILLS[skillId];
    if (!ch || !s || !this.world.skills[skillId]) return;
    if (ch.unspentSkillPoints <= 0) return this.sendError(p.userId, 'No skill points.');
    if (s.minLevel > ch.level) return this.sendError(p.userId, `Requires ${this.world.terminology.level} ${s.minLevel}.`);
    if (ch.skills.includes(skillId)) return;
    ch.skills.push(skillId);
    ch.unspentSkillPoints--;
    if (!s.passive && ch.hotbar.filter(Boolean).length < 10) {
      const i = ch.hotbar.indexOf(null);
      if (i >= 0) ch.hotbar[i] = skillId;
      else ch.hotbar.push(skillId);
    }
    this.markPlayer(p.userId);
  }

  // =================================================================== loot

  private openLoot(p: PlayerState, sourceId: string) {
    const z = this.zones.get(p.zoneId);
    if (!z) return;
    this.lootOpen.set(p.userId, sourceId);
    const f = z.map.features.get(sourceId);
    if (f) {
      const fr = z.rt.features[f.id] ?? {};
      return this.sendTo(p.userId, { t: 'loot', loot: { id: f.id, label: f.name ?? 'Chest', items: fr.loot ?? [], gold: fr.lootGold ?? 0, sourceKind: 'chest' } });
    }
    const l = z.rt.loot.find((x) => x.id === sourceId);
    if (l) this.sendTo(p.userId, { t: 'loot', loot: { id: l.id, label: l.label, items: l.items, gold: l.gold, sourceKind: 'pile' } });
  }

  private cmdTakeLoot(p: PlayerState, sourceId: string, itemId?: string, all?: boolean) {
    const z = this.zones.get(p.zoneId);
    if (!z) return;
    const leader = this.leader(p);
    let items: ItemInstance[];
    let gold: number;
    let setItems: (v: ItemInstance[]) => void;
    let setGold: (v: number) => void;
    let pos: Vec2;
    const f = z.map.features.get(sourceId);
    if (f) {
      const fr = (z.rt.features[f.id] ??= {});
      items = fr.loot ?? [];
      gold = fr.lootGold ?? 0;
      setItems = (v) => (fr.loot = v);
      setGold = (v) => (fr.lootGold = v);
      pos = f;
      z.featuresDirty.add(f.id);
    } else {
      const l = z.rt.loot.find((x) => x.id === sourceId);
      if (!l) return;
      items = l.items;
      gold = l.gold;
      setItems = (v) => (l.items = v);
      setGold = (v) => (l.gold = v);
      pos = l;
    }
    if (!leader || Math.hypot(pos.x - leader.x, pos.y - leader.y) > 3) return this.sendError(p.userId, 'Too far away.');
    const take = all ? items : items.filter((i) => i.id === itemId);
    if (all || itemId === 'gold') {
      if (gold) {
        p.gold += gold;
        p.stats.goldEarned += gold;
        this.sendTo(p.userId, { t: 'toast', text: `+${gold} ${this.world.terminology.gold}`, kind: 'loot' });
      }
      setGold(0);
    }
    if (take.length) {
      addToInventory(p.inventory, take);
      setItems(items.filter((i) => !take.includes(i)));
      for (const it of take) {
        const name = itemName(this.ctx.naming, it);
        this.sendTo(p.userId, { t: 'toast', text: `Picked up ${name}${it.qty > 1 ? ` ×${it.qty}` : ''}`, kind: 'loot' });
        if (it.uniqueId) this.journal(p, 'loot', `Found ${name}.`);
      }
      this.quests.refreshCollect(p);
    }
    // Remove empty piles.
    const rest = z.rt.loot.find((x) => x.id === sourceId);
    if (rest && !rest.items.length && !rest.gold) {
      z.rt.loot = z.rt.loot.filter((x) => x !== rest);
      this.lootOpen.delete(p.userId);
      this.sendTo(p.userId, { t: 'loot', loot: null });
    } else this.openLoot(p, sourceId);
    z.lootDirty = true;
    this.markPlayer(p.userId);
  }

  // =================================================================== trade & crafting

  private priceMults(p: PlayerState, npcId: string) {
    const rt = this.state.npcs[npcId];
    const disp = rt?.disposition[p.userId] ?? 0;
    const haggle = p.party.some((c) => c.skills.includes('haggler')) ? 0.15 : 0;
    return { buy: Math.max(0.7, 1.25 - disp * 0.002 - haggle), sell: Math.min(0.6, 0.3 + Math.max(0, disp) * 0.001 + haggle) };
  }

  openTrade(userId: string, npcId: string) {
    const p = this.state.players[userId];
    const def = this.ctx.npcs.get(npcId);
    const rt = this.state.npcs[npcId];
    if (!p || !def || !rt) return;
    if (rt.stockDay !== this.day()) {
      const kind = def.merchantKind ?? (def.role === 'innkeeper' ? 'general' : def.role === 'crafter' ? 'materials' : 'general');
      const level = Math.max(1, this.ctx.zones.get(this.ctx.outerZone(rt.zoneId))?.levelRange[0] ?? def.level);
      rt.stock = merchantStock(this.world, new Rng(`${this.state.id}:${npcId}:${this.day()}`), kind, Math.max(level, ...p.party.map((c) => c.level - 1)));
      rt.stockDay = this.day();
      rt.gold = Math.max(rt.gold, 300 + def.level * 60);
    }
    this.trades.set(userId, npcId);
    this.sendTrade(userId);
  }

  private sendTrade(userId: string) {
    const npcId = this.trades.get(userId);
    const p = this.state.players[userId];
    if (!npcId || !p) return;
    const rt = this.state.npcs[npcId]!;
    const def = this.ctx.npcs.get(npcId)!;
    const m = this.priceMults(p, npcId);
    const view: TradeState = { npcId, npcName: def.name, stock: rt.stock.map((it) => ({ ...it, price: Math.max(1, Math.round(itemPrice(it) * m.buy)) })), sellMult: m.sell, npcGold: rt.gold };
    this.sendTo(userId, { t: 'trade', trade: view });
  }

  closeTrade(userId: string) {
    if (this.trades.delete(userId)) this.sendTo(userId, { t: 'trade', trade: null });
  }

  private cmdBuy(p: PlayerState, npcId: string, itemId: string, qty: number) {
    if (this.trades.get(p.userId) !== npcId) return;
    const rt = this.state.npcs[npcId]!;
    const it = rt.stock.find((i) => i.id === itemId);
    if (!it) return;
    const n = Math.max(1, Math.min(qty, it.qty));
    const unit = Math.max(1, Math.round(itemPrice({ ...it, qty: 1 }) * this.priceMults(p, npcId).buy));
    const cost = unit * n;
    if (p.gold < cost) return this.sendError(p.userId, `Not enough ${this.world.terminology.gold}.`);
    p.gold -= cost;
    rt.gold += cost;
    const bought = removeFromInventory(rt.stock, it.id, n)!;
    addToInventory(p.inventory, [bought]);
    this.quests.refreshCollect(p);
    this.sendTrade(p.userId);
    this.markPlayer(p.userId);
  }

  private cmdSell(p: PlayerState, npcId: string, itemId: string, qty: number) {
    if (this.trades.get(p.userId) !== npcId) return;
    const rt = this.state.npcs[npcId]!;
    const it = p.inventory.find((i) => i.id === itemId);
    if (!it) return;
    if (it.bound || ITEM_BASE[it.baseId]?.category === 'quest') return this.sendError(p.userId, 'They will not buy that.');
    const n = Math.max(1, Math.min(qty, it.qty));
    const unit = Math.max(1, Math.round(itemPrice({ ...it, qty: 1 }) * this.priceMults(p, npcId).sell));
    const value = unit * n;
    if (rt.gold < value) return this.sendError(p.userId, `They cannot afford it.`);
    p.gold += value;
    rt.gold -= value;
    const sold = removeFromInventory(p.inventory, it.id, n)!;
    addToInventory(rt.stock, [sold]);
    this.sendTrade(p.userId);
    this.markPlayer(p.userId);
  }

  private cmdCraft(p: PlayerState, recipeId: string) {
    if (!this.world.systems.crafting) return;
    const r = RECIPES.find((x) => x.id === recipeId);
    if (!r) return;
    for (const inp of r.inputs) {
      const have = p.inventory.filter((i) => i.baseId === inp.baseId).reduce((s, i) => s + i.qty, 0);
      if (have < inp.qty) return this.sendError(p.userId, 'Missing ingredients.');
    }
    for (const inp of r.inputs) {
      let need = inp.qty;
      for (const it of [...p.inventory].filter((i) => i.baseId === inp.baseId)) {
        const take = Math.min(need, it.qty);
        removeFromInventory(p.inventory, it.id, take);
        need -= take;
        if (!need) break;
      }
    }
    const level = Math.max(...p.party.map((c) => c.level));
    const out = 'baseId' in r.output ? makeItem(this.world, this.rng, r.output.baseId, level, 'common', r.output.qty) : rollRandomItem(this.world, this.rng, level, 0, { category: r.output.category, minRarity: r.output.rarity });
    addToInventory(p.inventory, [out]);
    p.stats.itemsCrafted++;
    this.quests.onCraft(p, out.baseId);
    this.sendTo(p.userId, { t: 'toast', text: `Crafted ${itemName(this.ctx.naming, out)}${out.qty > 1 ? ` ×${out.qty}` : ''}`, kind: 'loot' });
    this.markPlayer(p.userId);
  }

  // =================================================================== dialogue host

  private endDialog(userId: string) {
    const s = this.dialogue.session(userId);
    if (s) {
      for (const z of this.zones.values()) {
        const a = z.actors.get(s.npcId);
        if (a instanceof NpcActor) a.talkingTo = null;
      }
    }
    this.dialogue.close(userId);
    this.closeTrade(userId);
  }

  private npcActor(npcId: string): NpcActor | undefined {
    for (const z of this.zones.values()) {
      const a = z.actors.get(npcId);
      if (a instanceof NpcActor) return a;
    }
    return undefined;
  }

  joinParty(userId: string, npcId: string): string | null {
    const p = this.state.players[userId];
    const def = this.ctx.npcs.get(npcId);
    const rt = this.state.npcs[npcId];
    if (!p || !def || !rt) return 'They cannot join.';
    if (this.world.input.combatMode !== 'party_npc') return `${def.name} wishes you well, but prefers to stay.`;
    if (p.party.length >= MAX_PARTY_SIZE) return `Your ${this.world.terminology.party.toLowerCase()} is full.`;
    if (rt.partyOf) return 'They are already travelling with someone.';
    const level = Math.max(1, Math.min(def.level, Math.max(...p.party.map((c) => c.level))));
    const originId = ORIGINS.find((o) => o.archetype === def.archetype)?.id ?? 'o_warrior';
    const { ch } = createCharacter(this.world, { name: def.name, originId, sprite: def.asset ?? '', colors: def.colors }, new Rng(`${this.state.id}:${npcId}`));
    ch.npcId = npcId;
    ch.aiControlled = true;
    ch.pronouns = def.pronouns;
    ch.sprite = def.asset ?? '';
    ch.colors = def.colors;
    if (level > 1) grantXp(ch, (ch.xp = 0, require_xp(level)), this.world);
    autoSpend(ch, this.world);
    ch.hotbar = defaultHotbar(ch);
    restoreFully(ch, this.world);
    p.party.push(ch);
    rt.partyOf = userId;
    const actor = this.npcActor(npcId);
    if (actor) {
      this.zones.get(actor.zoneId)?.actors.delete(npcId);
      this.broadcastZone(actor.zoneId, { t: 'entities', upsert: [], remove: [npcId] });
    }
    const z = this.zones.get(p.zoneId);
    const leader = this.leader(p);
    if (z && leader) {
      const spot = this.nearestFree(z.id, { x: Math.round(leader.x) + 1, y: Math.round(leader.y) });
      const a = new CharActor(ch, userId, z.id, spot.x, spot.y, this.world, () => this.loneWolf(p));
      z.actors.set(a.id, a);
    }
    for (const c of p.party) clampPools(c, this.world, this.loneWolf(p));
    this.journal(p, 'social', `${def.name} joined your ${this.world.terminology.party.toLowerCase()}.`);
    this.markPlayer(userId);
    return null;
  }

  leaveParty(userId: string, npcId: string) {
    const p = this.state.players[userId];
    const rt = this.state.npcs[npcId];
    if (!p || !rt) return;
    const ch = p.party.find((c) => c.npcId === npcId);
    if (!ch) return;
    p.party = p.party.filter((c) => c !== ch);
    if (p.leaderId === ch.id) p.leaderId = p.party[0]!.id;
    rt.partyOf = undefined;
    const def = this.ctx.npcs.get(npcId)!;
    rt.zoneId = def.zoneId;
    rt.x = def.x;
    rt.y = def.y;
    const z = this.zones.get(p.zoneId);
    if (z) {
      z.actors.delete(ch.id);
      this.broadcastZone(z.id, { t: 'entities', upsert: [], remove: [ch.id] });
    }
    const home = this.zones.get(def.zoneId);
    if (home && !home.actors.has(npcId)) home.actors.set(npcId, new NpcActor(def, rt, def.zoneId, this.world));
    this.journal(p, 'social', `${def.name} left your ${this.world.terminology.party.toLowerCase()} and went home.`);
    this.markPlayer(userId);
  }

  healParty(userId: string) {
    const p = this.state.players[userId];
    if (!p) return;
    for (const ch of p.party) restoreFully(ch, this.world, this.loneWolf(p));
    for (const a of this.charActors(p)) a.dirty = true;
    this.markPlayer(userId);
  }

  private remember(npcId: string, mem: Memory) {
    const rt = this.state.npcs[npcId];
    if (!rt) return;
    rt.memories.push(mem);
    if (rt.memories.length > 40) rt.memories.splice(0, rt.memories.length - 40);
    const spread = mem.spread ?? 'none';
    if (spread !== 'none') this.spreadMemory(npcId, mem, spread);
    this.markDirty();
  }

  /** Propagate a memory as rumor according to the world's communication level. */
  private spreadMemory(fromNpcId: string, mem: Memory, spread: 'household' | 'town' | 'world') {
    const from = this.ctx.npcs.get(fromNpcId);
    const fromRt = this.state.npcs[fromNpcId];
    if (!from || !fromRt) return;
    const comm = this.world.input.communication;
    const allowed = ['none', 'household', 'town', 'world'] as const;
    const level = Math.min(allowed.indexOf(spread), comm);
    if (level <= 0) return;
    const town = this.ctx.townOf(fromRt.zoneId) ?? this.ctx.outerZone(fromRt.zoneId);
    for (const [id, rt] of Object.entries(this.state.npcs)) {
      if (id === fromNpcId || !rt.alive) continue;
      const def = this.ctx.npcs.get(id)!;
      const sameBuilding = rt.zoneId === fromRt.zoneId;
      const related = from.relations?.includes(id) || def.relations?.includes(fromNpcId);
      const sameTown = (this.ctx.townOf(rt.zoneId) ?? this.ctx.outerZone(rt.zoneId)) === town;
      const ok = level >= 3 || (level >= 2 && sameTown) || (level >= 1 && (sameBuilding || related));
      if (!ok) continue;
      if (rt.memories.some((m) => m.text === mem.text)) continue;
      rt.memories.push({ ...mem, id: uid('m'), source: 'rumor', fromNpcId, spread: 'none', fulfilled: false });
      if (rt.memories.length > 40) rt.memories.shift();
    }
  }

  private npcGossip(npcId: string | null, text: string, about: string, spread: 'household' | 'town' | 'world') {
    const mem: Memory = { id: uid('m'), text, about, aboutName: this.state.players[about]?.name, importance: 4, day: this.day(), source: 'witnessed', spread };
    if (npcId) this.remember(npcId, mem);
    else if (this.world.input.communication >= 3) {
      for (const rt of Object.values(this.state.npcs)) if (rt.alive) rt.memories.push({ ...mem, id: uid('m'), source: 'rumor' });
    }
  }

  private questGossip(p: PlayerState, q: QuestDef, kind: 'completed' | 'failed') {
    if (!q.giverNpcId) return;
    const giver = this.ctx.npcs.get(q.giverNpcId);
    this.npcGossip(q.giverNpcId, `${p.name} ${kind === 'completed' ? 'helped' : 'let down'} ${giver?.name ?? 'someone'} with "${q.title}".`, p.userId, q.main ? 'world' : 'town');
    const rt = this.state.npcs[q.giverNpcId];
    if (rt) rt.disposition[p.userId] = Math.max(-100, Math.min(100, (rt.disposition[p.userId] ?? 0) + (kind === 'completed' ? 20 : -20)));
  }

  private dialogueHost() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      ctx: this.ctx,
      get quests() {
        return self.quests;
      },
      day: () => this.day(),
      timeOfDay: () => this.timeOfDay(),
      player: (u: string) => this.state.players[u],
      npcRt: (id: string) => this.state.npcs[id],
      sendDialog: (u: string, d: DialogState | null) => {
        this.sendTo(u, { t: 'dialog', dialog: d });
        if (!d) for (const z of this.zones.values()) for (const a of z.actors.values()) if (a instanceof NpcActor && a.talkingTo === u) a.talkingTo = null;
      },
      openTrade: (u: string, npcId: string) => this.openTrade(u, npcId),
      npcAttack: (npcId: string, u: string) => {
        const rt = this.state.npcs[npcId];
        const a = this.npcActor(npcId);
        if (!rt || !a) return;
        if (!rt.hostileTo.includes(u)) rt.hostileTo.push(u);
        a.dirty = true;
        const p = this.state.players[u];
        const z = this.zones.get(a.zoneId);
        const leader = p && this.leader(p);
        if (z && leader) setTimeout(() => this.startCombat(z, a, leader, false), 600);
      },
      callGuards: (npcId: string, u: string) => {
        const rt = this.state.npcs[npcId];
        if (!rt) return;
        const town = this.ctx.townOf(rt.zoneId);
        for (const [id, r] of Object.entries(this.state.npcs)) {
          const d = this.ctx.npcs.get(id);
          if (d?.role === 'guard' && r.alive && this.ctx.townOf(r.zoneId) === town && !r.hostileTo.includes(u)) r.hostileTo.push(u);
        }
        for (const z of this.zones.values()) for (const a of z.actors.values()) if (a instanceof NpcActor) a.dirty = true;
      },
      npcFlee: (npcId: string) => {
        const a = this.npcActor(npcId);
        if (!a) return;
        const z = this.zones.get(a.zoneId)!;
        const far = { x: Math.round(a.homeX + (this.rng.chance(0.5) ? 8 : -8)), y: Math.round(a.homeY) };
        const path = findPath(a, this.nearestFree(z.id, far), { width: z.map.def.width, height: z.map.def.height, passable: (x, y) => this.passable(z.id, x, y), maxNodes: 2000 });
        if (path?.length) {
          a.motion = { path, from: { x: Math.round(a.x), y: Math.round(a.y) }, speed: 5, t0: Date.now() };
          a.dirty = true;
        }
      },
      joinParty: (u: string, id: string) => this.joinParty(u, id),
      leaveParty: (u: string, id: string) => this.leaveParty(u, id),
      healParty: (u: string) => this.healParty(u),
      giveItemsToPlayer: (u: string, items: ItemInstance[]) => {
        const p = this.state.players[u];
        if (!p) return;
        addToInventory(p.inventory, items);
        this.quests.refreshCollect(p);
        this.markPlayer(u);
      },
      takeItemFromPlayer: (u: string, itemId: string) => {
        const p = this.state.players[u];
        if (!p) return null;
        const it = removeFromInventory(p.inventory, itemId, 1);
        this.markPlayer(u);
        return it;
      },
      revealZone: (u: string, zoneId: string) => {
        const p = this.state.players[u];
        if (!p || p.knownZones.includes(zoneId)) return false;
        p.knownZones.push(zoneId);
        this.markPlayer(u);
        return true;
      },
      teachSkill: (u: string, skillId: string, price: number) => {
        const p = this.state.players[u];
        if (!p) return 'No one to teach.';
        const leader = p.party.find((c) => c.id === p.leaderId) ?? p.party[0]!;
        if (leader.skills.includes(skillId)) return `${leader.name} already knows that.`;
        const s = SKILLS[skillId];
        if (s && s.minLevel > leader.level) return `${leader.name} needs more experience first (${this.world.terminology.level} ${s.minLevel}).`;
        if (p.gold < price) return `You cannot afford the lesson (${price} ${this.world.terminology.gold}).`;
        p.gold -= price;
        leader.skills.push(skillId);
        if (!s?.passive && leader.hotbar.length < 10) leader.hotbar.push(skillId);
        this.markPlayer(u);
        return null;
      },
      remember: (npcId: string, mem: Memory) => this.remember(npcId, mem),
      scheduleGathering: (npcId: string, about: string, day: number, reason: string) => {
        const rt = this.state.npcs[npcId];
        if (!rt) return;
        const town = this.ctx.townOf(rt.zoneId);
        if (!town) return;
        const tz = this.ctx.zones.get(town)!;
        const wp = tz.features.find((f) => f.kind === 'waypoint') ?? { x: tz.entry.x, y: tz.entry.y };
        const npcIds = Object.entries(this.state.npcs).filter(([id, r]) => r.alive && !r.partyOf && this.ctx.townOf(r.zoneId) === town && this.ctx.npcs.get(id)?.role !== 'merchant').map(([id]) => id).slice(0, 10);
        if (this.state.events.some((e) => e.day === day && e.zoneId === town && e.about === about)) return;
        this.state.events.push({ id: uid('ev'), day, kind: 'gathering', zoneId: town, x: wp.x - 2, y: wp.y + 2, about, reason, npcIds });
      },
      playerChanged: (p: PlayerState) => this.markPlayer(p.userId),
      journal: (p: PlayerState, kind: 'social' | 'quest', text: string) => this.journal(p, kind, text),
      partySummary: (u: string) => {
        const p = this.state.players[u];
        if (!p) return '';
        const lead = p.party.find((c) => c.id === p.leaderId) ?? p.party[0]!;
        const origin = this.world.origins.find((o) => o.id === lead.originId);
        const rest = p.party.filter((c) => c !== lead).map((c) => `${c.name} (${c.npcId ? 'companion' : this.world.origins.find((o) => o.id === c.originId)?.name})`);
        const fame = p.stats.questsCompleted > 6 ? 'well known in these parts' : p.stats.questsCompleted > 2 ? 'gaining a reputation' : 'a newcomer';
        return `${lead.name}, a ${this.world.terminology.level.toLowerCase()} ${lead.level} ${origin?.name ?? 'adventurer'} (${origin?.appearance ?? ''}), ${fame}.${rest.length ? ` Travelling with ${rest.join(', ')}.` : ''}${lead.skills.includes('silver_tongue') ? ' They are unusually persuasive.' : ''}`;
      },
      communication: () => this.world.input.communication,
      dynamicQuest: (def: QuestDef) => {
        this.state.dynamicQuests.push(def);
        this.markDirty();
      },
      questDef: (id: string) => this.questDef(id),
      createDynamicItem: (name: string, description: string, nearZoneId: string) => this.createDynamicItem(name, description, nearZoneId),
      spendLeaderResource: (u: string, skillId: string) => {
        const p = this.state.players[u];
        if (!p) return 'No party.';
        const lead = p.party.find((c) => c.id === p.leaderId) ?? p.party[0]!;
        if (!lead.skills.includes(skillId)) return 'You do not know that ability.';
        const s = SKILLS[skillId];
        if (!s) return 'Unknown ability.';
        const pool = this.world.systems.dualEnergy ? s.pool ?? (s.school === 'elemental' || s.school === 'occult' || s.school === 'restoration' ? 'focus' : 'stamina') : 'stamina';
        if ((pool === 'focus' ? lead.focus : lead.stamina) < s.cost) return `Not enough ${this.world.terminology[pool]}.`;
        if (pool === 'focus') lead.focus -= s.cost;
        else lead.stamina -= s.cost;
        this.markPlayer(u);
        return null;
      },
      hostileSkill: (u: string, npcId: string, skillId: string) => {
        const p = this.state.players[u];
        const npc = this.npcActor(npcId);
        const leader = p && this.leader(p);
        if (!npc || !leader) return;
        npc.talkingTo = null;
        const skill = getSkill(skillId);
        if (!skill) return;
        if (!npc.rt.hostileTo.includes(u)) npc.rt.hostileTo.push(u);
        executeSkill(this, { user: leader, skill, target: npc }, false);
      },
    };
  }

  private createDynamicItem(name: string, description: string, nearZoneId: string): string {
    const id = uid('u_dyn');
    this.state.dynamicItems ??= {};
    this.state.dynamicItems[id] = { id, baseId: 'q_item', name: name.charAt(0).toUpperCase() + name.slice(1), description, rarity: 'rare', questItem: true };
    this.mergeDynamicItems();
    // Hide it in a nearby non-town zone.
    const outer = this.ctx.zones.get(this.ctx.outerZone(nearZoneId));
    const target = outer?.links.map((l) => this.ctx.zones.get(l)!).find((z) => z && z.kind !== 'town' && z.kind !== 'interior') ?? outer;
    if (target) {
      const rt = this.zoneRuntime(target.id);
      const map = this.ctx.map(target.id);
      const r = new Rng(id);
      for (let i = 0; i < 300; i++) {
        const x = r.int(2, map.def.width - 3), y = r.int(2, map.def.height - 3);
        if (!map.solid[y * map.def.width + x] && Math.hypot(x - map.def.entry.x, y - map.def.entry.y) > 10) {
          rt.loot.push({ id: uid('lp'), x, y, items: [{ id: uid('it'), baseId: 'q_item', level: 1, rarity: 'rare', affixes: [], qty: 1, uniqueId: id, bound: true }], gold: 0, label: name, createdAt: Date.now() });
          const lz = this.zones.get(target.id);
          if (lz) lz.lootDirty = true;
          break;
        }
      }
    }
    return id;
  }

  private mergeDynamicItems() {
    const merged = { ...this.world.uniqueItems, ...(this.state.dynamicItems ?? {}) };
    (this.ctx.naming as unknown as { uniqueItems: typeof merged }).uniqueItems = merged;
  }

  questDef(id: string): QuestDef | undefined {
    return this.ctx.quests.get(id) ?? this.state.dynamicQuests.find((q) => q.id === id);
  }

  // =================================================================== test helpers

  /** Direct access for tests and tools. */
  _live(zoneId: string) {
    return this.live(zoneId);
  }
  _charActors(userId: string) {
    const p = this.state.players[userId];
    return p ? this.charActors(p) : [];
  }
  _combats() {
    return [...this.combats.values()];
  }
}

function require_xp(level: number) {
  let xp = 0;
  for (let l = 2; l <= level; l++) {
    const n = l - 1;
    xp = Math.round(100 * n + 60 * n * n + 6 * n * n * n);
  }
  return xp;
}

export type { MonsterArchetype, CharacterSpec, ORIGIN };
