/** One running save-state of a world: authoritative simulation for every connected player. */
import {
  BitSet, DIFFICULTIES, GAME_MINUTES_PER_DAY, MAX_PARTY_SIZE, REAL_MS_PER_GAME_MINUTE, RESPAWN_GAME_MINUTES, ROLE_VISUAL, RULESET_VERSION, Rng,
  bagUpgradeCost, canAllocate, fieldRecipe, nearStation, characterStats, curve, enchantCost, findPath, upgradeCost, hashFloat, itemPrice, knownSkills, refMit, rx, sampleMotion, skillAp, skillRange, smoothPath, standPoint, tilesInRadius, uid,
  type CharacterSpec, type ClientMessage, type DialogState, type DifficultyId, type EntityView, type FeatureDef, type FeatureState, type FxEvent, type InstanceState, type ItemInstance,
  type JournalEntry, type LootPile, type Memory, type NpcRuntime, type PlayerState, type PlayerView, type QuestDef, type Ruleset, type ServerMessage, type Surface,
  type TradeState, type MonsterRuntime, type SpawnDef, type Vec2, type WorldDefinition, type ZoneRuntime, type CharacterState, type MonsterArchetype, type SlotKind,
} from '@gd/shared';
import { Actor, CharActor, MonsterActor, NpcActor, WALK_SPEED } from './actors';
import { fitPack } from '../rules/encounters';
import { forgeLegend, isTopRarity } from './legends';
import { withCallContext } from '../genai/context';
import { WorldCtx, type ZoneMap } from './worldctx';
import { Combat, type CombatHost } from './combat';
import { addStatus, checkItemUse, checkSkill, executeSkill, isHarmful, isHostileTo, springTrap, useConsumable, applySurface } from './effects';
import { QuestEngine, objectivesOf, currentObjectiveIndex } from './quests';
import { DialogueEngine } from './dialogue';
import { addToInventory, affixValue, fitsInInventory, inventoryCapacity, normalizeInventory, makeItem, makeUnique, merchantStock, mergeStacks, removeFromInventory, rollLoot, rollRandomItem } from './loot';
import { allocateNode, clampPools, createCharacter, defaultHotbar, grantXp, levelUpTo, regenerate, restoreFully } from './characters';

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
  inspect?: boolean;
}

const TICK_MS = 100;
const AGGRO_RADIUS = 6.5;
const JOIN_RADIUS = 13;

export class GameInstance implements CombatHost {
  readonly ctx: WorldCtx;
  readonly world: WorldDefinition;
  readonly r: Ruleset;
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
    this.r = world.ruleset;
    this.ctx = new WorldCtx(world);
    state.difficulty ??= world.input.difficulty ?? 'normal';
    this.rng = new Rng(`${state.id}:${Date.now()}`);
    this.mergeDynamicItems();
    for (const p of Object.values(state.players)) p.inventory = normalizeInventory(this.r, p.inventory);
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

  onlineUsers(): string[] {
    return [...this.conns.keys()];
  }

  isPaused() {
    return this.conns.size === 0;
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
      const { ch, inventory: inv } = createCharacter(this.r, w, spec, prng);
      party.push(ch);
      addToInventory(this.r, inventory, inv);
    }
    if (!party.length) party.push(createCharacter(this.r, w, { name, classId: this.r.classes[0]!.id, kinId: this.r.kins[0]!.id, presentation: 'androgynous', pronouns: 'they/them' }, prng).ch);
    for (const ch of party) restoreFully(this.r, ch, party.length <= 1);
    const start = this.ctx.zones.get(w.startZoneId)!;
    const p: PlayerState = {
      userId,
      name: party[0]!.name,
      party,
      leaderId: party[0]!.id,
      gold: 60,
      inventory: mergeStacks(this.r, inventory),
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
      inventoryUpgrades: 0,
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
      conn.send({ t: 'error', message: 'Create a character for this daydream first.' });
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
    const { zones, npcs, concept, arcs, quests, ending, generationLog, worldFacts, rulesIntent, ...rest } = w;
    void quests, ending, generationLog, worldFacts, rulesIntent;
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
    const s = new NpcActor(def, { npcId, zoneId: def.zoneId, x: def.x, y: def.y, hp: 1, alive: true, hostileTo: [], disposition: {}, memories: [], stock: [], stockDay: -1, inventory: [], gold: 0 }, def.zoneId, this.r).stats();
    const inventory = (def.inventory ?? []).map((u) => this.ctx.uniqueItems[u]).filter(Boolean).map((u) => makeUnique(this.r, u!, def.level));
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
    // Monsters. A slain pack comes back (for farming) once every member's respawn time has passed; bosses stay dead.
    const due = (m: MonsterRuntime) => {
      const at = m.respawnAt ?? (m.respawnDay !== undefined ? (m.respawnDay - 1) * GAME_MINUTES_PER_DAY : undefined);
      return at !== undefined && at <= this.state.clock;
    };
    const groups = new Map<string, SpawnDef[]>();
    for (const s of map.def.spawns) groups.set(s.groupId, [...(groups.get(s.groupId) ?? []), s]);
    const extrasOf = (members: SpawnDef[]) => Object.values(rt.monsters).filter((m) => m.extraOf && members.some((s) => s.id === m.extraOf));
    for (const members of groups.values()) {
      const rts = members.map((s) => (rt.monsters[s.id] ??= { spawnId: s.id, hp: -1, dead: false, x: s.x, y: s.y }));
      const extras = extrasOf(members);
      const gone = (m: MonsterRuntime) => m.absent || (m.dead && due(m));
      if (rts.some((m) => !m.absent) && rts.every(gone) && extras.every((m) => m.dead)) {
        members.forEach((s, i) => Object.assign(rts[i]!, { dead: false, hp: -1, x: s.x, y: s.y, looted: false, respawnAt: undefined, respawnDay: undefined, diedAt: undefined, absent: undefined, scale: undefined, elite: undefined }));
        for (const e of extras) delete rt.monsters[e.spawnId];
      }
      // Fit untouched packs to the party that will meet them (once per spawn).
      if (rts.every((m) => m.scale === undefined)) {
        if (rts.every((m) => !m.dead && m.hp === -1)) this.fitGroup(map, members, rts);
        else for (const m of rts) m.scale = 1;
      }
    }
    const spawnFor = (m: MonsterRuntime): SpawnDef | undefined => {
      if (!m.extraOf) return map.def.spawns.find((s) => s.id === m.spawnId);
      const base = map.def.spawns.find((s) => s.id === m.extraOf);
      return base && { ...base, id: m.spawnId, x: m.x, y: m.y, bossId: undefined };
    };
    for (const m of Object.values(rt.monsters)) {
      if (m.dead || m.absent) continue;
      const s = spawnFor(m);
      if (!s) continue;
      const fam = this.ctx.family(s.familyId) ?? this.world.families[0]!;
      const actor = new MonsterActor(s, m, fam, s.bossId ? this.ctx.bosses.get(s.bossId) : undefined, zoneId, this.r, () => this.state.difficulty);
      z.actors.set(actor.id, actor);
    }
    for (const rtn of Object.values(this.state.npcs)) {
      if (rtn.zoneId !== zoneId || !rtn.alive || rtn.partyOf || rtn.fled) continue;
      const def = this.ctx.npcs.get(rtn.npcId);
      if (!def) continue;
      const a = new NpcActor(def, rtn, zoneId, this.r);
      z.actors.set(a.id, a);
    }
    this.applyGatherings(z);
    return z;
  }

  /** Fit a fresh pack to the largest party in this journey and roll the difficulty's encounter adjustments. */
  private fitGroup(map: ZoneMap, members: SpawnDef[], rts: MonsterRuntime[]) {
    const partySize = Math.max(1, ...Object.values(this.state.players).map((p) => p.party.length));
    const fit = fitPack(this.r, members.map((s) => ({ id: s.id, role: s.archetype, boss: !!s.bossId, elite: s.elite })), { mode: this.world.input.combatMode, partySize, difficulty: this.state.difficulty, rand: () => this.rng.next() });
    members.forEach((s, i) => {
      const m = rts[i]!;
      m.scale = fit.scale;
      m.absent = fit.absent.includes(s.id) || undefined;
      m.elite = fit.eliteId === s.id || undefined;
    });
    if (fit.extraOf) {
      const base = members.find((s) => s.id === fit.extraOf)!;
      const W = map.def.width;
      const free = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < map.def.height && !map.solid[y * W + x] && !members.some((s) => s.x === x && s.y === y);
      const spot = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].map(([dx, dy]) => ({ x: base.x + dx!, y: base.y + dy! })).find((p) => free(p.x, p.y));
      if (spot) {
        const id = `${base.id}_x`;
        this.zoneRuntime(map.def.id).monsters[id] = { spawnId: id, hp: -1, dead: false, x: spot.x, y: spot.y, extraOf: base.id, scale: fit.scale };
      }
    }
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
    for (const a of this.actorsInZone(zoneId)) if (a.id !== ignoreId && (a.alive() || a.downed()) && Math.round(a.x) === x && Math.round(a.y) === y) return false;
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
      const a = new CharActor(ch, p.userId, p.zoneId, spot.x, spot.y, this.r, () => this.loneWolf(p), this.world);
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
        const a = (z.actors.get(id) as NpcActor) ?? new NpcActor(def, rt, z.id, this.r);
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
    return { ...p, questDefs, loneWolf: this.loneWolf(p), npcMarkers, dynamicItems, waypoints, isOwner: this.state.ownerId === p.userId, difficulty: this.state.difficulty };
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
    for (const [userId, s] of this.steering) {
      const p = this.state.players[userId];
      if (!p || now - s.at > 700) {
        // The controller went quiet (released, disconnected): stop where we are.
        this.steering.delete(userId);
        if (p) this.stopSteering(p);
      } else this.steerStep(p, s, now);
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

  /** Trap sense as a 0..1 skill level relative to the character's level. */
  private senseLevel(a: CharActor): number {
    const s = a.stats().trapSense / Math.max(1, refMit(this.r, a.level));
    return s / (s + 0.5);
  }

  private detectTraps(z: LiveZone, a: CharActor, p: PlayerState) {
    if (!this.r.systems.traps) return;
    const sense = this.senseLevel(a);
    const radius = 2.5 + sense * 6;
    const chance = 0.4 + sense * 0.5;
    for (const f of z.map.def.features) {
      if (f.kind !== 'trap' || p.revealedTraps.includes(f.id)) continue;
      const fr = z.rt.features[f.id];
      if (fr?.disarmed || fr?.triggered) continue;
      const d = Math.hypot(f.x - a.x, f.y - a.y);
      if (d > radius) continue;
      // A fresh roll each time a character gets a tile closer, and the odds improve up close.
      const band = Math.ceil(d);
      const odds = Math.min(0.95, chance + (d <= 1.5 ? 0.25 : 0));
      if (hashFloat(f.id, a.id, band) < odds) {
        p.revealedTraps.push(f.id);
        z.featuresDirty.add(f.id);
        this.sendTo(p.userId, { t: 'toast', text: `${a.name} spots a ${this.trapName(f)}!`, kind: 'info' });
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
        this.after(Combat.instant ? 0 : (i / WALK_SPEED) * 1000, () => this.triggerTrap(z, trap, a));
        return i;
      }
    }
    return -1;
  }

  private trapName(f: FeatureDef): string {
    return rx(this.r).trap.get(f.trapKind ?? '')?.name ?? this.r.traps[0]?.name ?? 'trap';
  }

  private triggerTrap(z: LiveZone, trap: FeatureDef, victim: Actor) {
    const fr = (z.rt.features[trap.id] ??= {});
    if (fr.triggered || fr.disarmed) return;
    fr.triggered = true;
    z.featuresDirty.add(trap.id);
    const def = rx(this.r).trap.get(trap.trapKind ?? '') ?? this.r.traps[0];
    if (!victim.combatId) victim.motion = null;
    victim.x = trap.x;
    victim.y = trap.y;
    victim.dirty = true;
    const radius = def?.radius ?? 0;
    this.fx(z.id, [{ kind: 'trap', x: trap.x, y: trap.y, text: def?.name ?? 'Trap', element: def?.subtypeId ?? def?.typeId, radius }]);
    const targets = radius > 0 ? [...z.actors.values()].filter((a) => a.alive() && Math.hypot(a.x - trap.x, a.y - trap.y) <= radius + 0.01 && a.team() === 'players') : [victim];
    springTrap(this, z.id, def?.id ?? '', trap.trapLevel ?? 1, trap, targets);
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

  /** Out of combat, health and pools always refill (every fight starts fresh). */
  private regen(z: LiveZone) {
    for (const a of z.actors.values()) {
      if (a.combatId || !(a instanceof CharActor)) continue;
      if (a.ch.downed) continue;
      const p = this.state.players[a.userId];
      let changed = regenerate(this.r, a.ch, !!p && this.loneWolf(p), 1);
      for (const k of Object.keys(a.cooldowns)) if (--a.cooldowns[k]! <= 0) delete a.cooldowns[k];
      if (a.statuses.length) {
        a.statuses = a.statuses.map((st) => ({ ...st, turns: st.turns - (rx(this.r).status.get(st.id)?.harmful ? 1 : 0.34) })).filter((st) => st.turns > 0);
        changed = true;
      }
      if (a.barrier > 0) {
        a.barrier = 0;
        changed = true;
      }
      if (changed) {
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
    const seen = new Set<Actor>();
    const addEnemy = (e: Actor) => {
      if (seen.has(e)) return;
      seen.add(e);
      if (e.alive()) enemies.add(e);
      // The whole pack fights together, even if the one that was hit is already dead (one-shot).
      if (e instanceof MonsterActor) {
        for (const o of z.actors.values()) if (o instanceof MonsterActor && o.alive() && o.spawn.groupId === e.spawn.groupId) addEnemy(o);
      }
    };
    addEnemy(enemy);
    // Only stragglers standing right next to the pack join; other packs stay put.
    for (const e of [...enemies]) for (const o of z.actors.values()) if (o.alive() && o instanceof MonsterActor && !o.combatId && !enemies.has(o) && Math.hypot(o.x - e.x, o.y - e.y) < 2.2) addEnemy(o);
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
      // Whoever opened the fight already acted (and pays for it on their first turn); everyone rolls initiative.
      combat.add(a);
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
    for (const a of c.participants()) a.dirty = true;
    if (victory) {
      for (const a of c.participants()) {
        if (a instanceof CharActor) {
          // Downed allies always get up after a won fight (the ruleset's revive mode governs reviving *during* combat).
          if (a.ch.downed) {
            a.ch.downed = false;
            a.ch.hp = 1;
          }
          a.statuses = [];
          a.ch.cooldowns = {};
          a.barrier = 0;
          a.barrierTurns = 0;
        }
      }
      for (const u of users) this.sendTo(u, { t: 'toast', text: 'Victory!', kind: 'good' });
      if (z) {
        z.rt.surfaces = z.rt.surfaces.filter((s) => !rx(this.r).surface.get(s.type)?.dot);
        z.surfacesDirty = true;
      }
    } else {
      for (const u of users) this.defeat(u, c.zoneId);
      // Survivors heal up and return home.
      for (const a of c.participants()) if ((a instanceof MonsterActor || a instanceof NpcActor) && a.alive()) a.resetPools();
    }
    for (const u of users) {
      this.sendTo(u, { t: 'combat', combat: null });
      this.markPlayer(u);
    }
    if (z) this.broadcastZone(z.id, { t: 'combat', combat: null });
    this.markDirty();
  }

  /** Death mode `corpse_run`: wake in the last town; the bag stays on your remains (equipment and quest items come along). */
  private defeat(userId: string, zoneId?: string) {
    const p = this.state.players[userId];
    if (!p) return;
    p.stats.deaths++;
    const leader = this.leader(p);
    const where = { zoneId: zoneId ?? p.zoneId, x: Math.round(leader?.x ?? p.x), y: Math.round(leader?.y ?? p.y) };
    const dropped = p.inventory.filter((i) => !i.bound && rx(this.r).item.get(i.baseId)?.category !== 'quest' && rx(this.r).item.get(i.baseId)?.category !== 'key');
    p.inventory = p.inventory.filter((i) => !dropped.includes(i));
    const gold = this.r.death.keepGold ? 0 : p.gold;
    if (!this.r.death.keepGold) p.gold = 0;
    if (dropped.length || gold) {
      const zr = this.zoneRuntime(where.zoneId);
      zr.loot.push({ id: uid('lp'), x: where.x, y: where.y, items: dropped, gold, label: `${p.name}'s remains`, ownerUserId: userId, createdAt: Date.now(), corpse: true });
      const lz = this.zones.get(where.zoneId);
      if (lz) lz.lootDirty = true;
    }
    for (const ch of p.party) restoreFully(this.r, ch, this.loneWolf(p));
    const town = this.ctx.zones.get(p.lastTownZoneId)?.name ?? 'town';
    const place = this.ctx.zones.get(where.zoneId)?.name ?? 'the wilds';
    this.journal(p, 'combat', `Defeated in ${place}. Woke in ${town}.${dropped.length ? ' Your pack lies where you fell.' : ''}`);
    this.sendTo(userId, { t: 'narration', title: 'Defeat', text: `Darkness takes you... and then, slowly, light. You wake in ${town}, sore but alive.${dropped.length ? ` Your pack — ${dropped.length} item${dropped.length > 1 ? 's' : ''} — still lies where you fell in ${place}. Your gear is still on your back.` : ''}`, style: 'death' });
    const waypoint = this.ctx.zones.get(p.lastTownZoneId)?.features.find((f) => f.kind === 'waypoint');
    this.after(50, () => this.transfer(p, p.lastTownZoneId, undefined, waypoint ? { x: waypoint.x, y: waypoint.y + 1 } : undefined));
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
      target.rt.respawnAt = target.boss ? undefined : this.state.clock + RESPAWN_GAME_MINUTES;
      target.motion = null;
      target.dirty = true;
      this.fx(z.id, [{ kind: 'death', targetId: target.id, x: target.x, y: target.y }]);
      const combat = target.combatId ? this.combats.get(target.combatId) : undefined;
      const killers = new Set<string>();
      const participants = combat ? combat.participants() : source ? [source] : [];
      for (const a of participants) if (a instanceof CharActor) killers.add(a.userId);
      if (source instanceof CharActor) killers.add(source.userId);
      const xp = Math.round(curve(this.r.progression.killXp, target.level) * (target.boss ? 5 : target.elite ? 2 : 1) * ROLE_VISUAL[target.archetype].xp);
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
      const lootFind = Math.max(0, ...[...killers].flatMap((u) => this.state.players[u]?.party.map((c) => characterStats(this.r, c).lootFind) ?? [0]));
      const loot = rollLoot(this.r, this.rng, target.level, { lootFind, boss: !!target.boss, elite: target.elite, mult: this.r.difficulty[this.state.difficulty]?.lootMult ?? 1 });
      for (const u of target.boss?.drops ?? []) {
        const def = this.ctx.uniqueItems[u];
        if (def) loot.items.push(makeUnique(this.r, def, target.level));
      }
      // A boss sometimes leaves a piece of legendary gear behind.
      if (target.boss && !loot.items.some((i) => isTopRarity(this.r, i)) && this.rng.chance(0.35)) loot.items.push(rollRandomItem(this.r, this.rng, target.level, 0, { minRarity: this.r.rarities.length - 1 }));
      this.forgeLegendaries(loot.items, z.id, target.boss ? `${target.boss.name}, ${target.boss.title}` : target.name);
      if (loot.items.length || loot.gold) {
        z.rt.loot.push({ id: uid('lp'), x: Math.round(target.x), y: Math.round(target.y), items: loot.items, gold: loot.gold, label: target.name, createdAt: Date.now() });
        z.lootDirty = true;
      }
      this.after(2500, () => {
        if (z.actors.get(target.id) === target && !target.alive()) {
          z.actors.delete(target.id);
          this.broadcastZone(z.id, { t: 'entities', upsert: [], remove: [target.id] });
        }
      });
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
      this.after(2500, () => {
        if (z.actors.get(target.id) === target) {
          z.actors.delete(target.id);
          this.broadcastZone(z.id, { t: 'entities', upsert: [], remove: [target.id] });
        }
      });
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
          this.after(3000, () => {
            target.ch.downed = false;
            target.ch.hp = 1;
            target.dirty = true;
          });
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
      const gained = grantXp(this.r, ch, amount);
      if (gained > 0) {
        const a = this.zones.get(p.zoneId)?.actors.get(ch.id);
        if (a) {
          a.dirty = true;
          this.fx(p.zoneId, [{ kind: 'levelup', targetId: ch.id, text: `${this.r.terminology.level} ${ch.level}` }]);
        }
        this.journal(p, 'system', `${ch.name} reached ${this.r.terminology.level.toLowerCase()} ${ch.level}.`);
        this.sendTo(p.userId, { t: 'toast', text: `${ch.name} reached ${this.r.terminology.level} ${ch.level}!`, kind: 'good' });
      }
    }
    this.markPlayer(p.userId);
  }

  // =================================================================== message handling

  handle(userId: string, msg: ClientMessage) {
    // Whatever this message sets off (an NPC's reply, a legendary drop) is paid from this player's AI budget.
    return withCallContext({ priority: 'interactive', userId }, () => this.handle_(userId, msg));
  }

  private handle_(userId: string, msg: ClientMessage) {
    const p = this.state.players[userId];
    if (!p) return;
    try {
      switch (msg.t) {
        case 'move': return this.cmdMove(p, msg.x, msg.y, msg.charId);
        case 'steer': return this.cmdSteer(p, msg.dx, msg.dy);
        case 'interact': return this.cmdInteract(p, msg.targetId, msg.charId, msg.inspect);
        case 'request_trade': return void this.dialogue.requestTrade(userId);
        case 'talk': return void this.dialogue.say(userId, msg.text, { giveItemId: msg.giveItemId, giveGold: msg.giveGold, useSkillId: msg.useSkillId });
        case 'end_dialog': return this.endDialog(userId);
        case 'use_skill': return this.cmdSkill(p, msg.charId, msg.skillId, msg.targetId, msg.x, msg.y);
        case 'use_item': return this.cmdItem(p, msg.charId, msg.itemId, msg.targetId, msg.x, msg.y);
        case 'equip': return this.cmdEquip(p, msg.charId, msg.itemId);
        case 'unequip': return this.cmdUnequip(p, msg.charId, msg.slot);
        case 'drop_item': return this.cmdDrop(p, msg.itemId, msg.qty);
        case 'end_turn': return this.cmdEndTurn(p);
        case 'flee': return this.cmdFlee(p);
        case 'buy': return this.cmdBuy(p, msg.npcId, msg.itemId, msg.qty ?? 1);
        case 'sell': return this.cmdSell(p, msg.npcId, msg.itemId, msg.qty ?? 1);
        case 'end_trade': return this.closeTrade(userId);
        case 'craft': return this.cmdCraft(p, msg.recipeId);
        case 'take_loot': return this.cmdTakeLoot(p, msg.sourceId, msg.itemId, msg.all);
        case 'close_loot': this.lootOpen.delete(userId); return this.sendTo(userId, { t: 'loot', loot: null });
        case 'allocate': return this.cmdAllocate(p, msg.charId, msg.nodeId);
        case 'upgrade_item': return this.cmdUpgrade(p, msg.itemId, msg.charId);
        case 'enchant_item': return this.cmdEnchant(p, msg.itemId, msg.affixIndex, msg.charId);
        case 'buy_inventory_upgrade': return this.cmdBuyBagSpace(p, msg.npcId);
        case 'set_difficulty': {
          if (this.state.ownerId !== userId || !DIFFICULTIES.includes(msg.difficulty)) return;
          this.state.difficulty = msg.difficulty;
          for (const z of this.zones.values()) for (const a of z.actors.values()) if (a instanceof MonsterActor) a.dirty = true;
          this.sendTo(userId, { t: 'toast', text: `Difficulty: ${this.r.difficulty[msg.difficulty]?.name ?? msg.difficulty}`, kind: 'info' });
          this.markDirty();
          return this.markPlayer(userId);
        }
        case 'set_hotbar': {
          const ch = p.party.find((c) => c.id === msg.charId);
          const known = ch ? knownSkills(this.r, ch) : [];
          if (ch) ch.hotbar = msg.hotbar.slice(0, 10).map((s) => (s && known.includes(s) ? s : null));
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
          if (msg.open !== undefined && this.state.ownerId === userId) this.state.open = msg.open;
          if (msg.commandCompanions !== undefined) p.commandCompanions = msg.commandCompanions;
          this.markDirty();
          this.sendClock(true);
          return this.markPlayer(userId);
        }
        case 'abandon_quest': return this.quests.abandon(p, msg.questId);
        case 'pin_quest':
          if (msg.questId && p.quests[msg.questId]?.status !== 'active') return;
          p.pinnedQuestId = msg.questId;
          return this.markPlayer(p.userId);
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

  /** CombatHost: run later on a real timer (game time = real time here). */
  after(ms: number, fn: () => void) {
    setTimeout(fn, ms);
  }

  /** AI-driven companions may drink healing potions from their party's bag. */
  aiPotions(a: Actor): { item: ItemInstance; consume: () => void }[] {
    if (!(a instanceof CharActor) || !a.ch.npcId) return [];
    const p = this.state.players[a.userId];
    if (!p) return [];
    return p.inventory
      .filter((i) => rx(this.r).item.get(i.baseId)?.use?.effects.some((e) => e.kind === 'heal'))
      .map((item) => ({ item, consume: () => void removeFromInventory(p.inventory, item.id, 1) }));
  }

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
      const res = c.move(active, { x: tx, y: ty });
      if (res.error) this.sendError(p.userId, res.error);
      return;
    }
    this.pending.delete(p.userId);
    this.pendingSkill.delete(p.userId);
    const leader = this.charFor(p, charId);
    if (!leader || !leader.alive()) return;
    // Outside combat the party walks to the exact point clicked, not just the tile centre.
    this.walkParty(p, leader, { x: tx, y: ty }, 0, Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined);
    this.closeDialogOnMove(p);
  }

  /** Controller walking: direction per player, refreshed by the client while the stick is held. */
  private steering = new Map<string, { dx: number; dy: number; at: number; follow: number; legDir?: { x: number; y: number } }>();

  private cmdSteer(p: PlayerState, dx: number, dy: number) {
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || this.charActors(p).some((a) => a.combatId)) return;
    if (len < 0.2) {
      this.steering.delete(p.userId);
      return this.stopSteering(p);
    }
    const prev = this.steering.get(p.userId);
    this.steering.set(p.userId, { dx: dx / len, dy: dy / len, at: Date.now(), follow: prev?.follow ?? 0, legDir: prev?.legDir });
    this.pending.delete(p.userId);
    this.pendingSkill.delete(p.userId);
    this.closeDialogOnMove(p);
  }

  /** Clear for walking along a straight line (sampled every quarter tile). */
  private lineClear(zoneId: string, a: Vec2, b: Vec2): boolean {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.25);
    for (let i = 1; i <= n; i++) if (!this.passable(zoneId, Math.round(a.x + ((b.x - a.x) * i) / n), Math.round(a.y + ((b.y - a.y) * i) / n))) return false;
    return true;
  }

  /**
   * Keep the leader walking the steered way: a short straight leg ahead, renewed before it runs out or when the
   * direction changes, so motion never restarts from a standstill. Walls are slid along. Companions follow a
   * trail behind the leader instead of being re-planned on every update.
   */
  private steerStep(p: PlayerState, s: { dx: number; dy: number; at: number; follow: number; legDir?: { x: number; y: number } }, now: number) {
    const lead = this.leader(p);
    const z = this.zones.get(p.zoneId);
    if (!lead || !z || lead.combatId) return;
    const m = lead.motion;
    const end = m?.path[m.path.length - 1];
    const left = end ? Math.hypot(end.x - lead.x, end.y - lead.y) : 0;
    // A new leg only when the stick's direction changed (not when a wall slide bent the last one) or the leg is
    // running out: every new leg is a small correction the client has to smooth over.
    const turned = !s.legDir || s.legDir.x * s.dx + s.legDir.y * s.dy < 0.985;
    if (!m || left < 1.6 || turned) {
      s.legDir = { x: s.dx, y: s.dy };
      const from = { x: lead.x, y: lead.y };
      const base = Math.atan2(s.dy, s.dx);
      let target: Vec2 | null = null;
      for (const turn of [0, 0.35, -0.35, 0.75, -0.75, 1.2, -1.2]) {
        const a = base + turn;
        for (const len of [4, 2.5, 1.2, 0.5]) {
          const t = { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
          if (this.lineClear(z.id, from, t)) {
            target = t;
            break;
          }
        }
        if (target) break;
      }
      if (target) {
        lead.motion = { path: [target], from, speed: WALK_SPEED, t0: now };
        lead.dirty = true;
      } else if (m) {
        lead.motion = null;
        lead.dirty = true;
      }
    }
    if (now - s.follow > 300) {
      s.follow = now;
      this.followLeader(p, lead, { x: s.dx, y: s.dy }, now);
    }
  }

  private stopSteering(p: PlayerState) {
    const lead = this.leader(p);
    if (!lead || lead.combatId) return;
    if (lead.motion) {
      lead.motion = null;
      lead.dirty = true;
      p.x = Math.round(lead.x);
      p.y = Math.round(lead.y);
    }
    this.followLeader(p, lead, { x: Math.cos(lead.facing), y: Math.sin(lead.facing) }, Date.now());
  }

  /** Companions walk to their places in a short column behind the leader (only when they have drifted). */
  private followLeader(p: PlayerState, lead: CharActor, dir: Vec2, now: number) {
    const z = this.zones.get(p.zoneId);
    if (!z) return;
    const followers = this.charActors(p).filter((a) => a !== lead && a.alive() && !a.combatId);
    const clear = (x: number, y: number) => this.passable(z.id, x, y);
    followers.forEach((f, i) => {
      const back = 1.2 + 0.9 * Math.floor(i / 2), side = (i % 2 ? 1 : -1) * 0.55;
      let slot = { x: lead.x - dir.x * back - dir.y * side, y: lead.y - dir.y * back + dir.x * side };
      if (!clear(Math.round(slot.x), Math.round(slot.y))) slot = { x: lead.x - dir.x * back, y: lead.y - dir.y * back };
      if (!clear(Math.round(slot.x), Math.round(slot.y))) slot = { x: lead.x, y: lead.y };
      const d = Math.hypot(f.x - slot.x, f.y - slot.y);
      const goal = f.motion?.path[f.motion.path.length - 1];
      if (d < 0.7 || (goal && Math.hypot(goal.x - slot.x, goal.y - slot.y) < 0.6)) return;
      const from = { x: f.x, y: f.y };
      const tiles = findPath(from, { x: Math.round(slot.x), y: Math.round(slot.y) }, { width: z.map.def.width, height: z.map.def.height, passable: clear, stopWithin: 0, allowBlockedGoal: true, maxNodes: 4000 });
      if (!tiles?.length && d > 0.7 && this.lineClear(z.id, from, slot)) {
        f.motion = { path: [slot], from, speed: WALK_SPEED * 1.1, t0: now };
      } else if (tiles?.length) {
        // Catch up a little faster when far behind, so the party keeps together while walking.
        f.motion = { path: smoothPath(from, tiles, clear, standPoint(Math.round(slot.x), Math.round(slot.y), slot, clear)), from, speed: WALK_SPEED * (d > 3 ? 1.35 : 1.1), t0: now };
      } else return;
      f.dirty = true;
    });
  }

  /** Walking away ends a conversation. */
  private closeDialogOnMove(p: PlayerState) {
    if (this.dialogue.session(p.userId)) this.endDialog(p.userId);
  }

  /** Path the leader to a target; followers trail behind. */
  private walkParty(p: PlayerState, leader: CharActor, target: Vec2, stopWithin: number, point?: Vec2): boolean {
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
    // Straight lines may cross only tiles a tile path could use (and never a revealed trap).
    const clear = (x: number, y: number) => opts.passable(x, y) && opts.extraCost(x, y) === 0;
    const from = { x: leader.x, y: leader.y };
    const tilePath = findPath(from, target, opts);
    if (!tilePath) return false;
    const end = point && stopWithin <= 0 && clear(target.x, target.y) ? standPoint(target.x, target.y, point, clear) : undefined;
    const path = smoothPath(from, tilePath, clear, end);
    const now = Date.now();
    leader.motion = path.length ? { path, from, speed: WALK_SPEED, t0: now } : null;
    leader.dirty = true;
    if (!path.length) {
      this.arrived(leader);
      return true;
    }
    const dest = tilePath[tilePath.length - 1] ?? { x: Math.round(from.x), y: Math.round(from.y) };
    const prev = tilePath.length > 1 ? tilePath[tilePath.length - 2]! : { x: Math.round(from.x), y: Math.round(from.y) };
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
      const ff = { x: f.x, y: f.y };
      const fp = findPath(ff, goal, { ...opts, stopWithin: 0, allowBlockedGoal: false }) ?? findPath(ff, dest, { ...opts, stopWithin: 1.5, allowBlockedGoal: true });
      if (fp?.length) {
        // A small per-follower offset inside the goal tile so the party doesn't line up on a grid.
        const j = hashFloat(`${f.id}:${now}`);
        const last = fp[fp.length - 1]!;
        const spot = clear(last.x, last.y) ? standPoint(last.x, last.y, { x: last.x + (j - 0.5) * 0.6, y: last.y + (hashFloat(`${now}:${f.id}`) - 0.5) * 0.6 }, clear) : undefined;
        f.motion = { path: smoothPath(ff, fp, clear, spot), from: ff, speed: WALK_SPEED * 1.05, t0: now + 120 * (i + 1) };
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
      this.cmdSkill(p, a.id, ps.skillId, ps.targetId, undefined, undefined, true);
      return;
    }
    if (pend && pend.charId === a.id) {
      this.pending.delete(p.userId);
      this.performInteraction(p, a, pend.targetId, pend.inspect);
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

  private cmdInteract(p: PlayerState, targetId: string, charId?: string, inspect?: boolean) {
    const leader = this.charFor(p, charId);
    if (!leader || !leader.alive()) return;
    if (leader.combatId) return this.sendError(p.userId, 'Not during combat.');
    const t = this.targetPos(p, targetId);
    if (!t) return;
    const d = Math.hypot(t.x - leader.x, t.y - leader.y);
    const reach = t.kind === 'loot' ? 1.1 : 1.6;
    if (d <= reach + 0.01) return this.performInteraction(p, leader, targetId, inspect);
    this.pending.set(p.userId, { targetId, charId: leader.id, inspect });
    const ok = this.walkParty(p, leader, t, t.kind === 'loot' ? 0.5 : 1.5);
    if (!ok) {
      this.pending.delete(p.userId);
      this.sendError(p.userId, "You can't reach that.");
    }
  }

  private performInteraction(p: PlayerState, a: CharActor, targetId: string, inspect?: boolean) {
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
      return this.cmdSkill(p, a.id, 'attack', actor.id, undefined, undefined, true);
    }
    const loot = z.rt.loot.find((l) => l.id === targetId);
    if (loot) return inspect ? this.openLoot(p, loot.id) : this.lootAll(p, loot.id);
    const f = z.map.features.get(targetId);
    if (f) this.useFeature(p, a, z, f, inspect);
  }

  /** One click takes everything from a pile or chest, plus any other piles lying close by. */
  private lootAll(p: PlayerState, sourceId: string) {
    const z = this.zones.get(p.zoneId);
    if (!z) return;
    const src = z.map.features.get(sourceId) ?? z.rt.loot.find((l) => l.id === sourceId);
    if (!src) return;
    const ids = [sourceId, ...z.rt.loot.filter((l) => l.id !== sourceId && Math.hypot(l.x - src.x, l.y - src.y) <= 2.5).map((l) => l.id)];
    const got: string[] = [];
    let gold = 0;
    for (const id of ids) {
      const r = this.cmdTakeLoot(p, id, undefined, true, true);
      if (r) {
        got.push(...r.names);
        gold += r.gold;
      }
    }
    if (this.lootOpen.get(p.userId) && ids.includes(this.lootOpen.get(p.userId)!)) {
      this.lootOpen.delete(p.userId);
      this.sendTo(p.userId, { t: 'loot', loot: null });
    }
    const parts = [...(gold ? [`${gold} ${this.r.terminology.currency}`] : []), ...got];
    this.sendTo(p.userId, { t: 'toast', text: parts.length ? `Picked up ${parts.length > 4 ? `${parts.slice(0, 4).join(', ')} and ${parts.length - 4} more` : parts.join(', ')}` : 'Nothing left to take.', kind: parts.length ? 'loot' : 'info' });
  }

  /** Lockpicking as a 0..1 skill level relative to the character's level. */
  private lockLevel(a: CharActor): number {
    const s = a.stats().lockpick / Math.max(1, refMit(this.r, a.level));
    return s / (s + 0.5);
  }

  private useFeature(p: PlayerState, a: CharActor, z: LiveZone, f: FeatureDef, inspect?: boolean) {
    const fr = (z.rt.features[f.id] ??= {});
    switch (f.kind) {
      case 'door':
      case 'exit':
        if (f.targetZoneId) this.transfer(p, f.targetZoneId, f.targetFeatureId);
        return;
      case 'chest': {
        if (f.lockLevel && !fr.unlocked && this.r.systems.locks) {
          const keyItem = f.keyUniqueId ? p.inventory.find((i) => i.uniqueId === f.keyUniqueId) : undefined;
          const pick = p.inventory.find((i) => i.baseId === 'tool_unlock');
          const skill = Math.max(...this.charActors(p).map((c) => this.lockLevel(c)));
          if (keyItem) fr.unlocked = true;
          else if (pick || skill > 0.15) {
            const chance = 0.3 + skill * 0.6 + (a.level - f.lockLevel) * 0.05 + (pick ? 0.15 : 0);
            if (pick) removeFromInventory(p.inventory, pick.id, 1);
            if (this.rng.chance(Math.max(0.1, Math.min(0.97, chance)))) {
              fr.unlocked = true;
              this.sendTo(p.userId, { t: 'toast', text: 'The lock clicks open.', kind: 'good' });
              this.grantPartyXp(p, 10 + f.lockLevel * 4);
            } else {
              this.sendTo(p.userId, { t: 'toast', text: pick ? `The ${rx(this.r).item.get('tool_unlock')?.name ?? 'pick'} snaps.` : 'The lock resists. Try again.', kind: 'bad' });
              this.markPlayer(p.userId);
              return;
            }
          } else {
            this.sendTo(p.userId, { t: 'toast', text: `Locked. You need a key or a ${rx(this.r).item.get('tool_unlock')?.name ?? 'lockpick'}.`, kind: 'bad' });
            return;
          }
        }
        if (!fr.opened) {
          fr.opened = true;
          const lootFind = Math.max(...p.party.map((c) => characterStats(this.r, c).lootFind));
          const roll = rollLoot(this.r, new Rng(`${this.state.id}:${f.id}`), f.lootTier ?? 1, { chest: true, lootFind, mult: this.r.difficulty[this.state.difficulty]?.lootMult ?? 1 });
          fr.loot = roll.items;
          fr.lootGold = roll.gold;
          for (const u of f.items ?? []) {
            const def = this.ctx.uniqueItems[u];
            if (def) fr.loot.unshift(makeUnique(this.r, def, f.lootTier ?? 1));
          }
          this.forgeLegendaries(fr.loot, z.id, f.name ?? 'a sealed chest');
          z.featuresDirty.add(f.id);
        }
        return inspect ? this.openLoot(p, f.id) : this.lootAll(p, f.id);
      }
      case 'trap':
        return this.tryDisarm(p, a, z, f, false);
      case 'shrine': {
        this.quests.onInteract(p, f.id);
        if (fr.usedDay === this.day()) return this.sendTo(p.userId, { t: 'toast', text: `${f.name ?? 'The shrine'} is quiet. Return tomorrow.`, kind: 'info' });
        fr.usedDay = this.day();
        const buff = this.r.statuses.find((x) => !x.harmful && x.modifiers?.length);
        for (const c of this.charActors(p)) {
          if (f.shrineEffect === 'empower' && buff) addStatus(this, c, buff.id, 6, c.stats().dpa);
          else restoreFully(this.r, c.ch, this.loneWolf(p));
          c.dirty = true;
        }
        this.fx(z.id, [{ kind: 'skill', x: f.x, y: f.y, tx: f.x, ty: f.y, fx: 'heal', radius: 2 }]);
        this.sendTo(p.userId, { t: 'toast', text: `${f.name ?? 'Shrine'}: ${f.shrineEffect === 'empower' && buff ? `you are ${buff.name.toLowerCase()}` : `your ${this.r.terminology.party.toLowerCase()} is restored`}.`, kind: 'good' });
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
    void viaSkill;
    const fr = (z.rt.features[f.id] ??= {});
    if (fr.disarmed || fr.triggered) return;
    const kit = p.inventory.find((i) => i.baseId === 'tool_disarm');
    const sense = Math.max(...this.charActors(p).map((c) => this.senseLevel(c)));
    if (!kit && sense < 0.15) return this.sendTo(p.userId, { t: 'toast', text: `You need a ${rx(this.r).item.get('tool_disarm')?.name ?? 'trap kit'} (or a keener eye) to disarm that.`, kind: 'bad' });
    const chance = 0.35 + sense * 0.55 + (a.level - (f.trapLevel ?? 1)) * 0.05 + (kit ? 0.2 : 0);
    if (kit) removeFromInventory(p.inventory, kit.id, 1);
    if (this.rng.chance(Math.max(0.15, Math.min(0.97, chance)))) {
      fr.disarmed = true;
      z.featuresDirty.add(f.id);
      p.stats.trapsDisarmed++;
      this.grantPartyXp(p, 12 + (f.trapLevel ?? 1) * 5);
      this.quests.onDisarm(p);
      this.sendTo(p.userId, { t: 'toast', text: `Disarmed the ${this.trapName(f)}.`, kind: 'good' });
      const mat = this.r.items.find((i) => i.category === 'material' && (i.tier ?? 1) === 1);
      if (mat && this.rng.chance(0.5)) addToInventory(this.r, p.inventory, [makeItem(this.r, this.rng, mat.id, f.trapLevel ?? 1, this.r.rarities[0]!.id, 1)]);
    } else {
      this.sendTo(p.userId, { t: 'toast', text: 'You slip — the trap springs!', kind: 'bad' });
      this.triggerTrap(z, f, a);
    }
    this.markPlayer(p.userId);
  }

  private cmdSkill(p: PlayerState, charId: string, skillId: string, targetId?: string, x?: number, y?: number, afterApproach = false) {
    const a = this.charFor(p, charId);
    const z = this.zones.get(p.zoneId);
    if (!a || !z) return;
    const skill = rx(this.r).skill.get(skillId);
    if (!skill || !a.skillIds().includes(skillId)) return this.sendError(p.userId, 'Unknown skill.');
    const target = targetId ? z.actors.get(targetId) : undefined;
    const point = x !== undefined && y !== undefined ? { x: Math.round(x), y: Math.round(y) } : undefined;
    const combat = this.charActors(p).map((c) => this.combatOf(c)).find(Boolean);
    if (combat) {
      const active = combat.active;
      if (!(active instanceof CharActor) || active.userId !== p.userId || !combat.isHumanControlled(active)) return this.sendError(p.userId, 'Not your turn.');
      let err = combat.useSkill(active, skillId, target, point);
      // Out of range on an enemy: walk into range first if there is enough left to act (attack-move).
      if (err && target && skill.targeting === 'enemy' && isHostileTo(active, target) && (err === 'Out of range.' || err === 'No line of sight.')) err = combat.approachAndUse(active, skillId, target);
      if (err) this.sendError(p.userId, err);
      this.markPlayer(p.userId);
      return;
    }
    const use = { user: a, skill, target, point };
    const err = checkSkill(this, use, { inCombat: false });
    if (err) {
      // Out of range on an enemy: walk closer first (attack-move).
      // Only one approach per command: if we already walked and still can't reach, report instead of looping.
      if (!afterApproach && target && isHostileTo(a, target) && (err === 'Out of range.' || err === 'No line of sight.')) {
        this.pending.set(p.userId, { targetId: target.id, charId: a.id });
        this.pendingSkill.set(p.userId, { skillId, targetId: target.id });
        const range = skillRange(skill, a.stats());
        if (!this.walkParty(p, a, { x: Math.round(target.x), y: Math.round(target.y) }, Math.max(1.2, range - 0.6))) {
          this.pending.delete(p.userId);
          this.pendingSkill.delete(p.userId);
          this.sendError(p.userId, "You can't reach that.");
        }
        return;
      }
      return this.sendError(p.userId, err);
    }
    a.motion = null;
    a.x = Math.round(a.x);
    a.y = Math.round(a.y);
    const hostileUse = target && isHostileTo(a, target);
    // An opening shot is part of the attacker's first turn, not a free one: it is paid from that turn's AP.
    // (Otherwise ranged characters get a free hit before initiative that melee ones never do.)
    if (hostileUse || (skill.targeting === 'ground' && isHarmful(this.r, skill.effects))) a.openerAp = skillAp(skill, a.stats());
    executeSkill(this, use, false);
    if (!a.combatId) a.openerAp = 0;
    if (!hostileUse) this.markPlayer(p.userId);
  }

  private pendingSkill = new Map<string, { skillId: string; targetId: string }>();

  private cmdItem(p: PlayerState, charId: string, itemId: string, targetId?: string, x?: number, y?: number) {
    const a = this.charFor(p, charId);
    const z = this.zones.get(p.zoneId);
    if (!a || !z) return;
    const item = p.inventory.find((i) => i.id === itemId);
    if (!item) return;
    const base = rx(this.r).item.get(item.baseId);
    if (!base) return;
    if (base.category === 'equipment') return this.cmdEquip(p, a.id, itemId);
    const tool = base.use?.tool;
    if (tool === 'recall') {
      if (a.combatId) return this.sendError(p.userId, 'Not during combat.');
      removeFromInventory(p.inventory, item.id, 1);
      const wp = this.ctx.zones.get(p.lastTownZoneId)?.features.find((f) => f.kind === 'waypoint');
      this.transfer(p, p.lastTownZoneId, undefined, wp ? { x: wp.x, y: wp.y + 1 } : undefined);
      return;
    }
    if (tool === 'disarm' || tool === 'unlock') {
      const f = targetId ? z.map.features.get(targetId) : undefined;
      if (f) return this.cmdInteract(p, f.id, a.id);
      return this.sendError(p.userId, tool === 'disarm' ? 'Click a spotted trap to disarm it.' : 'Click a locked chest to open it.');
    }
    if (!base.use) return this.sendError(p.userId, 'That cannot be used.');
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

  private slotKindOf(slotId: string): SlotKind | undefined {
    return rx(this.r).slot.get(slotId)?.kind;
  }

  private cmdEquip(p: PlayerState, charId: string, itemId: string) {
    const ch = p.party.find((c) => c.id === charId);
    const item = p.inventory.find((i) => i.id === itemId);
    if (!ch || !item) return;
    const actor = this.zones.get(p.zoneId)?.actors.get(ch.id);
    if (actor?.combatId) {
      const c = this.combatOf(actor)!;
      if (c.active !== actor) return this.sendError(p.userId, 'Not your turn.');
      if (actor.ap < 1) return this.sendError(p.userId, `Not enough ${this.r.terminology.actionPoints}.`);
      actor.ap -= 1;
      this.broadcastCombat(c);
    }
    const base = rx(this.r).item.get(item.baseId);
    if (!base?.slotId) return this.sendError(p.userId, 'That cannot be equipped.');
    // Same-kind slots (two rings): fill an empty one first.
    const sameKind = this.r.slots.filter((s) => s.kind === this.slotKindOf(base.slotId!) && (s.id === base.slotId || this.slotKindOf(base.slotId!) === 'accessory'));
    const slot = sameKind.find((s) => !ch.equipment[s.id])?.id ?? base.slotId;
    removeFromInventory(p.inventory, item.id, item.qty);
    const old = ch.equipment[slot];
    if (old) addToInventory(this.r, p.inventory, [old]);
    ch.equipment[slot] = item;
    const weaponSlot = this.r.slots.find((s) => s.kind === 'weapon')?.id;
    const offSlot = this.r.slots.find((s) => s.kind === 'offhand')?.id;
    if (slot === weaponSlot && base.weapon?.twoHanded && offSlot && ch.equipment[offSlot]) {
      addToInventory(this.r, p.inventory, [ch.equipment[offSlot]!]);
      delete ch.equipment[offSlot];
    }
    if (slot === offSlot && weaponSlot && ch.equipment[weaponSlot] && rx(this.r).item.get(ch.equipment[weaponSlot]!.baseId)?.weapon?.twoHanded) {
      addToInventory(this.r, p.inventory, [ch.equipment[weaponSlot]!]);
      delete ch.equipment[weaponSlot];
    }
    clampPools(this.r, ch, this.loneWolf(p));
    if (actor) actor.dirty = true;
    this.markPlayer(p.userId);
  }

  private cmdUnequip(p: PlayerState, charId: string, slot: string) {
    const ch = p.party.find((c) => c.id === charId);
    if (!ch || !ch.equipment[slot]) return;
    const actor = this.zones.get(p.zoneId)?.actors.get(ch.id);
    if (actor?.combatId) return this.sendError(p.userId, 'Not during combat.');
    if (!fitsInInventory(this.r, p, [ch.equipment[slot]!])) return this.sendError(p.userId, 'Your bag is full.');
    addToInventory(this.r, p.inventory, [ch.equipment[slot]!]);
    delete ch.equipment[slot];
    clampPools(this.r, ch, this.loneWolf(p));
    if (actor) actor.dirty = true;
    this.markPlayer(p.userId);
  }

  private cmdDrop(p: PlayerState, itemId: string, qty?: number) {
    const item = p.inventory.find((i) => i.id === itemId);
    if (!item) return;
    if (item.bound) return this.sendError(p.userId, 'You should hold on to that.');
    const it = removeFromInventory(p.inventory, itemId, qty ?? item.qty);
    void RULESET_VERSION;
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

  private cmdAllocate(p: PlayerState, charId: string, nodeId: string) {
    const ch = p.party.find((c) => c.id === charId);
    if (!ch) return;
    const err = allocateNode(this.r, ch, nodeId);
    if (err) return this.sendError(p.userId, err);
    clampPools(this.r, ch, this.loneWolf(p));
    const a = this.zones.get(p.zoneId)?.actors.get(ch.id);
    if (a) a.dirty = true;
    this.markPlayer(p.userId);
  }

  /** Crafting: raise an item's upgrade level (better base damage/defense). */
  /** The party leader stands at a workbench (crafting gear, improving and enchanting happen there). */
  private atStation(p: PlayerState): boolean {
    const a = this.leader(p);
    const z = this.zones.get(p.zoneId);
    return !!a && !!z && nearStation(this.ctx.zones.get(z.id)?.features ?? [], { x: a.x, y: a.y });
  }

  private cmdUpgrade(p: PlayerState, itemId: string, charId?: string) {
    const up = this.r.crafting.upgrades;
    if (!up.enabled) return this.sendError(p.userId, 'Items cannot be upgraded in this daydream.');
    if (!this.atStation(p)) return this.sendError(p.userId, 'Improving gear needs a workbench.');
    if (this.charActors(p).some((a) => a.combatId)) return this.sendError(p.userId, 'Not during combat.');
    const { item } = this.findOwnedItem(p, itemId, charId);
    if (!item || rx(this.r).item.get(item.baseId)?.category !== 'equipment') return;
    const lvl = item.upgrade ?? 0;
    const cost = upgradeCost(this.r, item);
    if (!cost) return this.sendError(p.userId, 'Already fully upgraded.');
    const { gold, material: mat, qty } = cost;
    if (p.gold < gold) return this.sendError(p.userId, `Needs ${gold} ${this.r.terminology.currency}.`);
    if (mat && !this.consumeMaterials(p, [{ itemId: mat.id, qty }])) return this.sendError(p.userId, `Needs ${qty} ${mat.name}.`);
    p.gold -= gold;
    item.upgrade = lvl + 1;
    this.refreshCharStats(p);
    this.sendTo(p.userId, { t: 'toast', text: `${this.ctx.itemName(item)} improved.`, kind: 'good' });
    this.markPlayer(p.userId);
  }

  /** Crafting: replace one affix with a new random one. */
  private cmdEnchant(p: PlayerState, itemId: string, affixIndex: number, charId?: string) {
    const en = this.r.crafting.enchanting;
    if (!en.enabled) return this.sendError(p.userId, 'Enchanting is not possible in this daydream.');
    if (!this.atStation(p)) return this.sendError(p.userId, 'Enchanting needs a workbench.');
    if (this.charActors(p).some((a) => a.combatId)) return this.sendError(p.userId, 'Not during combat.');
    const { item } = this.findOwnedItem(p, itemId, charId);
    if (!item) return;
    const base = rx(this.r).item.get(item.baseId);
    const kind = base?.slotId ? this.slotKindOf(base.slotId) : undefined;
    const cost = enchantCost(this.r, item);
    if (!kind || !cost) return this.sendError(p.userId, 'That cannot be enchanted.');
    const { gold, material: mat } = cost;
    if (p.gold < gold) return this.sendError(p.userId, `Needs ${gold} ${this.r.terminology.currency}.`);
    if (mat && !this.consumeMaterials(p, [{ itemId: mat.id, qty: 1 }])) return this.sendError(p.userId, `Needs a ${mat.name}.`);
    p.gold -= gold;
    const taken = new Set(item.affixes.map((a) => rx(this.r).affix.get(a.affixId)?.stat));
    const pool = this.r.affixes.filter((a) => a.slotKinds.includes(kind) && !taken.has(a.stat));
    if (!pool.length) return;
    const pick = this.rng.pickWeighted(pool, (a) => a.weight);
    const entry = { affixId: pick.id, value: affixValue(this.r, pick.id, item.level, item.rarityId, this.rng.next()) };
    if (affixIndex >= 0 && affixIndex < item.affixes.length) item.affixes[affixIndex] = entry;
    else if (item.affixes.length < (rx(this.r).rarity.get(item.rarityId)?.affixes[1] ?? 0) + 1) item.affixes.push(entry);
    else item.affixes[item.affixes.length - 1] = entry;
    this.refreshCharStats(p);
    this.sendTo(p.userId, { t: 'toast', text: `${this.ctx.itemName(item)} glows with new power.`, kind: 'good' });
    this.markPlayer(p.userId);
  }

  private findOwnedItem(p: PlayerState, itemId: string, charId?: string): { item?: ItemInstance } {
    const inv = p.inventory.find((i) => i.id === itemId);
    if (inv) return { item: inv };
    for (const c of p.party) if (!charId || c.id === charId) for (const it of Object.values(c.equipment)) if (it?.id === itemId) return { item: it };
    return {};
  }

  private consumeMaterials(p: PlayerState, inputs: { itemId: string; qty: number }[]): boolean {
    for (const inp of inputs) {
      const have = p.inventory.filter((i) => i.baseId === inp.itemId).reduce((s, i) => s + i.qty, 0);
      if (have < inp.qty) return false;
    }
    for (const inp of inputs) {
      let need = inp.qty;
      for (const it of [...p.inventory].filter((i) => i.baseId === inp.itemId)) {
        const take = Math.min(need, it.qty);
        removeFromInventory(p.inventory, it.id, take);
        need -= take;
        if (!need) break;
      }
    }
    return true;
  }

  private refreshCharStats(p: PlayerState) {
    for (const a of this.charActors(p)) a.dirty = true;
    for (const c of p.party) clampPools(this.r, c, this.loneWolf(p));
  }

  /** Merchants sell a limited number of bag upgrades. */
  private cmdBuyBagSpace(p: PlayerState, npcId: string) {
    if (this.trades.get(p.userId) !== npcId) return;
    if (p.inventoryUpgrades >= this.r.inventory.upgrades) return this.sendError(p.userId, 'Your bag cannot get any bigger.');
    const cost = this.bagUpgradeCost(p);
    if (p.gold < cost) return this.sendError(p.userId, `Needs ${cost} ${this.r.terminology.currency}.`);
    p.gold -= cost;
    p.inventoryUpgrades++;
    this.sendTo(p.userId, { t: 'toast', text: `Bag enlarged to ${inventoryCapacity(this.r, p)} slots.`, kind: 'good' });
    this.sendTrade(p.userId);
    this.markPlayer(p.userId);
  }

  private bagUpgradeCost(p: PlayerState) {
    return bagUpgradeCost(this.r, p);
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

  /** Take items from a pile or chest. `quiet` skips per-item toasts and the window refresh (lootAll reports instead). */
  private cmdTakeLoot(p: PlayerState, sourceId: string, itemId?: string, all?: boolean, quiet = false): { names: string[]; gold: number } | undefined {
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
    if (!leader || Math.hypot(pos.x - leader.x, pos.y - leader.y) > (quiet ? 5 : 3)) {
      if (!quiet) this.sendError(p.userId, 'Too far away.');
      return;
    }
    let take = all ? items : items.filter((i) => i.id === itemId);
    // The bag has limited slots: take what fits (quest items always fit).
    const fitting: ItemInstance[] = [];
    for (const it of take) if (fitsInInventory(this.r, { inventory: [...p.inventory, ...fitting], inventoryUpgrades: p.inventoryUpgrades }, [it])) fitting.push(it);
    if (fitting.length < take.length) this.sendTo(p.userId, { t: 'toast', text: 'Your bag is full.', kind: 'bad' });
    take = fitting;
    const names: string[] = [];
    let tookGold = 0;
    if (all || itemId === 'gold') {
      if (gold) {
        p.gold += gold;
        p.stats.goldEarned += gold;
        tookGold = gold;
        if (!quiet) this.sendTo(p.userId, { t: 'toast', text: `+${gold} ${this.r.terminology.currency}`, kind: 'loot' });
      }
      setGold(0);
    }
    if (take.length) {
      addToInventory(this.r, p.inventory, take);
      setItems(items.filter((i) => !take.includes(i)));
      for (const it of take) {
        const name = `${this.ctx.itemName(it)}${it.qty > 1 ? ` ×${it.qty}` : ''}`;
        names.push(name);
        if (!quiet) this.sendTo(p.userId, { t: 'toast', text: `Picked up ${name}`, kind: 'loot' });
        if (it.uniqueId) this.journal(p, 'loot', `Found ${this.ctx.itemName(it)}.`);
      }
      this.quests.refreshCollect(p);
    }
    // Remove empty piles.
    const rest = z.rt.loot.find((x) => x.id === sourceId);
    if (rest && !rest.items.length && !rest.gold) {
      z.rt.loot = z.rt.loot.filter((x) => x !== rest);
      if (this.lootOpen.get(p.userId) === sourceId) {
        this.lootOpen.delete(p.userId);
        this.sendTo(p.userId, { t: 'loot', loot: null });
      }
    } else if (!quiet) this.openLoot(p, sourceId);
    z.lootDirty = true;
    this.markPlayer(p.userId);
    return { names, gold: tookGold };
  }

  // =================================================================== trade & crafting

  private priceMults(p: PlayerState, npcId: string) {
    const rt = this.state.npcs[npcId];
    const disp = rt?.disposition[p.userId] ?? 0;
    const haggle = Math.max(0, ...p.party.map((c) => characterStats(this.r, c).barter)) / 100;
    const sell = this.r.economy.sellRatio;
    return { buy: Math.max(0.7, 1.25 - disp * 0.002 - haggle), sell: Math.min(sell * 2, sell + Math.max(0, disp) * 0.001 + haggle) };
  }

  openTrade(userId: string, npcId: string) {
    const p = this.state.players[userId];
    const def = this.ctx.npcs.get(npcId);
    const rt = this.state.npcs[npcId];
    if (!p || !def || !rt) return;
    if (rt.stockDay !== this.day()) {
      const kind = def.merchantKind ?? (def.role === 'innkeeper' ? 'general' : def.role === 'crafter' ? 'materials' : 'general');
      const level = Math.max(1, this.ctx.zones.get(this.ctx.outerZone(rt.zoneId))?.levelRange[0] ?? def.level);
      rt.stock = merchantStock(this.r, new Rng(`${this.state.id}:${npcId}:${this.day()}`), kind, Math.max(level, ...p.party.map((c) => c.level - 1)));
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
    const view: TradeState = { npcId, npcName: def.name, stock: rt.stock.map((it) => ({ ...it, price: Math.max(1, Math.round(itemPrice(this.r, it) * m.buy)) })), sellMult: m.sell, npcGold: rt.gold, bagUpgrade: p.inventoryUpgrades < this.r.inventory.upgrades ? { cost: this.bagUpgradeCost(p), slots: this.r.inventory.slotsPerUpgrade } : undefined };
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
    const unit = Math.max(1, Math.round(itemPrice(this.r, { ...it, qty: 1 }) * this.priceMults(p, npcId).buy));
    const cost = unit * n;
    if (p.gold < cost) return this.sendError(p.userId, `Not enough ${this.r.terminology.currency}.`);
    if (!fitsInInventory(this.r, p, [{ ...it, qty: n }])) return this.sendError(p.userId, 'Your bag is full.');
    p.gold -= cost;
    rt.gold += cost;
    const bought = removeFromInventory(rt.stock, it.id, n)!;
    addToInventory(this.r, p.inventory, [bought]);
    this.quests.refreshCollect(p);
    this.sendTrade(p.userId);
    this.markPlayer(p.userId);
  }

  private cmdSell(p: PlayerState, npcId: string, itemId: string, qty: number) {
    if (this.trades.get(p.userId) !== npcId) return;
    const rt = this.state.npcs[npcId]!;
    const it = p.inventory.find((i) => i.id === itemId);
    if (!it) return;
    const cat = rx(this.r).item.get(it.baseId)?.category;
    if (it.bound || cat === 'quest' || cat === 'key') return this.sendError(p.userId, 'They will not buy that.');
    const n = Math.max(1, Math.min(qty, it.qty));
    const unit = Math.max(1, Math.round(itemPrice(this.r, { ...it, qty: 1 }) * this.priceMults(p, npcId).sell));
    const value = unit * n;
    if (rt.gold < value) return this.sendError(p.userId, `They cannot afford it.`);
    p.gold += value;
    rt.gold -= value;
    const sold = removeFromInventory(p.inventory, it.id, n)!;
    addToInventory(this.r, rt.stock, [sold]);
    this.sendTrade(p.userId);
    this.markPlayer(p.userId);
  }

  private cmdCraft(p: PlayerState, recipeId: string) {
    if (!this.r.crafting.enabled) return;
    const rec = this.r.recipes.find((x) => x.id === recipeId);
    if (!rec) return;
    if (this.charActors(p).some((a) => a.combatId)) return this.sendError(p.userId, 'Not during combat.');
    if (!fieldRecipe(this.r, rec) && !this.atStation(p)) return this.sendError(p.userId, 'That needs a workbench.');
    if (p.gold < rec.gold) return this.sendError(p.userId, `Needs ${rec.gold} ${this.r.terminology.currency}.`);
    const level = Math.max(...p.party.map((c) => c.level));
    const out = 'itemId' in rec.output ? makeItem(this.r, this.rng, rec.output.itemId, level, this.r.rarities[0]!.id, rec.output.qty) : rollRandomItem(this.r, this.rng, level, 0, { slotKind: rec.output.slotKind, minRarity: Math.max(0, this.r.rarities.findIndex((x) => x.id === (rec.output as { rarityId: string }).rarityId)) });
    if (!fitsInInventory(this.r, p, [out])) return this.sendError(p.userId, 'Your bag is full.');
    if (!this.consumeMaterials(p, rec.inputs)) return this.sendError(p.userId, 'Missing ingredients.');
    p.gold -= rec.gold;
    addToInventory(this.r, p.inventory, [out]);
    p.stats.itemsCrafted++;
    this.quests.onCraft(p, out.baseId);
    this.sendTo(p.userId, { t: 'toast', text: `Crafted ${this.ctx.itemName(out)}${out.qty > 1 ? ` ×${out.qty}` : ''}`, kind: 'loot' });
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
    if (p.party.length >= MAX_PARTY_SIZE) return `Your ${this.r.terminology.party.toLowerCase()} is full.`;
    if (rt.partyOf) return 'They are already travelling with someone.';
    const level = Math.max(1, Math.min(def.level, Math.max(...p.party.map((c) => c.level))));
    const cls = this.r.classes.find((c) => c.aiRole === def.archetype) ?? this.r.classes.find((c) => (def.archetype === 'guardian' || def.archetype === 'brute' ? c.role === 'tank' : def.archetype === 'caster' ? c.role === 'caster' : def.archetype === 'healer' ? c.role === 'support' : def.archetype === 'archer' ? c.role === 'ranged' : c.role === 'melee')) ?? this.r.classes[0]!;
    const rng = new Rng(`${this.state.id}:${npcId}`);
    const { ch } = createCharacter(this.r, this.world, { name: def.name, classId: cls.id, kinId: this.r.kins[0]!.id, presentation: 'androgynous', pronouns: def.pronouns, sprite: def.asset ?? '', colors: def.colors }, rng);
    ch.npcId = npcId;
    ch.aiControlled = true;
    ch.sprite = def.asset ?? '';
    ch.colors = def.colors;
    ch.archetype = def.archetype;
    levelUpTo(this.r, ch, level, rng);
    ch.hotbar = defaultHotbar(this.r, ch);
    restoreFully(this.r, ch);
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
      const a = new CharActor(ch, userId, z.id, spot.x, spot.y, this.r, () => this.loneWolf(p), this.world);
      z.actors.set(a.id, a);
    }
    for (const c of p.party) clampPools(this.r, c, this.loneWolf(p));
    this.journal(p, 'social', `${def.name} joined your ${this.r.terminology.party.toLowerCase()}.`);
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
    if (home && !home.actors.has(npcId)) home.actors.set(npcId, new NpcActor(def, rt, def.zoneId, this.r));
    this.journal(p, 'social', `${def.name} left your ${this.r.terminology.party.toLowerCase()} and went home.`);
    this.markPlayer(userId);
  }

  healParty(userId: string) {
    const p = this.state.players[userId];
    if (!p) return;
    for (const ch of p.party) restoreFully(this.r, ch, this.loneWolf(p));
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
        if (z && leader) this.after(600, () => this.startCombat(z, a, leader, false));
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
        addToInventory(this.r, p.inventory, items);
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
      /** Teachable: skills of the leader's class tree whose tier is unlocked; a lesson replaces the tree point. */
      teachableSkills: (u: string) => {
        const p = this.state.players[u];
        if (!p) return [];
        const lead = p.party.find((c) => c.id === p.leaderId) ?? p.party[0]!;
        const nodes = [...(rx(this.r).nodes.get(lead.classId)?.values() ?? [])].filter((n) => n.kind === 'skill' && n.skillId && !canAllocate(this.r, { ...lead, treePoints: 1 }, n.id));
        return nodes.map((n) => n.skillId!);
      },
      teachSkill: (u: string, skillId: string, price: number) => {
        const p = this.state.players[u];
        if (!p) return 'No one to teach.';
        const leader = p.party.find((c) => c.id === p.leaderId) ?? p.party[0]!;
        if (knownSkills(this.r, leader).includes(skillId)) return `${leader.name} already knows that.`;
        const node = [...(rx(this.r).nodes.get(leader.classId)?.values() ?? [])].find((n) => n.kind === 'skill' && n.skillId === skillId);
        if (!node) return `${leader.name} could never learn that — it is not of their calling.`;
        const why = canAllocate(this.r, { ...leader, treePoints: 1 }, node.id);
        if (why) return `${leader.name} is not ready for that yet (${why.toLowerCase()})`;
        if (p.gold < price) return `You cannot afford the lesson (${price} ${this.r.terminology.currency}).`;
        p.gold -= price;
        leader.tree[node.id] = 1;
        if (leader.hotbar.length < 10) leader.hotbar.push(skillId);
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
      journal: (p: PlayerState, kind: JournalEntry['kind'], text: string) => this.journal(p, kind, text),
      rollGift: (u: string, kind: 'supplies' | 'gear' | 'material' | 'keepsake', generous: boolean) => {
        const p = this.state.players[u];
        if (!p) return null;
        const level = Math.max(...p.party.map((c) => c.level));
        const of = (cat: string, filter: (b: { category: string; use?: unknown }) => boolean = () => true) => this.r.items.filter((b) => b.category === cat && b.price > 0 && filter(b));
        if (kind === 'gear') {
          // Equipment a person could spare: never better than uncommon, or rare from someone who is fond of you.
          for (let i = 0; i < 8; i++) {
            const it = rollRandomItem(this.r, this.rng, level, 0, { minRarity: generous ? 2 : 1 });
            if (rx(this.r).item.get(it.baseId)?.category === 'equipment') return it;
          }
          return null;
        }
        const pool = kind === 'supplies' ? [...of('potion'), ...of('tool')] : kind === 'material' ? of('material') : of('valuable');
        if (!pool.length) return null;
        const base = this.rng.pick(pool);
        return makeItem(this.r, this.rng, base.id, level, this.r.rarities[0]!.id, base.stackable ? (generous ? 3 : this.rng.int(1, 2)) : 1);
      },
      grantXp: (u: string, amount: number) => {
        const p = this.state.players[u];
        if (p) this.grantPartyXp(p, amount);
      },
      partySummary: (u: string) => {
        const p = this.state.players[u];
        if (!p) return '';
        const lead = p.party.find((c) => c.id === p.leaderId) ?? p.party[0]!;
        const look = this.world.origins.find((o) => o.id === lead.classId);
        const kin = rx(this.r).kin.get(lead.kinId)?.name;
        const rest = p.party.filter((c) => c !== lead).map((c) => `${c.name} (${c.npcId ? 'companion' : this.ctx.className(c.classId)})`);
        const fame = p.stats.questsCompleted > 6 ? 'well known in these parts' : p.stats.questsCompleted > 2 ? 'gaining a reputation' : 'a newcomer';
        return `${lead.name} (${lead.pronouns}), a ${this.r.terminology.level.toLowerCase()} ${lead.level} ${kin ? `${kin} ` : ''}${this.ctx.className(lead.classId)}${look?.appearance ? ` (${look.appearance})` : ''}, ${fame}.${rest.length ? ` Travelling with ${rest.join(', ')}.` : ''}`;
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
        if (!knownSkills(this.r, lead).includes(skillId)) return 'You do not know that ability.';
        const s = rx(this.r).skill.get(skillId);
        if (!s) return 'Unknown ability.';
        if (s.cost) {
          if ((lead.pools[s.cost.poolId] ?? 0) < s.cost.amount) return `Not enough ${rx(this.r).pool.get(s.cost.poolId)?.name ?? 'energy'}.`;
          lead.pools[s.cost.poolId] = (lead.pools[s.cost.poolId] ?? 0) - s.cost.amount;
        }
        this.markPlayer(u);
        return null;
      },
      hostileSkill: (u: string, npcId: string, skillId: string) => {
        const p = this.state.players[u];
        const npc = this.npcActor(npcId);
        const leader = p && this.leader(p);
        if (!npc || !leader) return;
        npc.talkingTo = null;
        const skill = rx(this.r).skill.get(skillId);
        if (!skill) return;
        if (!npc.rt.hostileTo.includes(u)) npc.rt.hostileTo.push(u);
        executeSkill(this, { user: leader, skill, target: npc }, false);
      },
    };
  }

  private createDynamicItem(name: string, description: string, nearZoneId: string): string {
    const id = uid('u_dyn');
    this.state.dynamicItems ??= {};
    this.state.dynamicItems[id] = { id, baseId: 'quest_item', name: name.charAt(0).toUpperCase() + name.slice(1), description, rarityId: this.r.rarities[2]!.id, mods: [], questItem: true };
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
          rt.loot.push({ id: uid('lp'), x, y, items: [makeUnique(this.r, this.state.dynamicItems![id]!, 1)], gold: 0, label: name, createdAt: Date.now() });
          const lz = this.zones.get(target.id);
          if (lz) lz.lootDirty = true;
          break;
        }
      }
    }
    return id;
  }

  /**
   * Give each top-rarity piece of gear among these items a name, legend and signature powers (in the background:
   * the item drops at once and becomes named a moment later, wherever it is by then).
   */
  private forgeLegendaries(items: ItemInstance[], zoneId: string, source: string) {
    const zone = this.ctx.zones.get(this.ctx.outerZone(zoneId));
    for (const item of items.filter((i) => isTopRarity(this.r, i))) {
      void forgeLegend(this.r, item, { world: { title: this.world.concept.title, pitch: this.world.concept.pitch, tone: this.world.concept.tone }, place: zone?.name ?? 'the wilds', source }).then((made) => {
        if (!made || item.uniqueId) return;
        this.state.dynamicItems ??= {};
        this.state.dynamicItems[made.def.id] = made.def;
        this.mergeDynamicItems();
        item.uniqueId = made.def.id;
        item.uniqueMods = made.mods;
        for (const p of Object.values(this.state.players)) {
          if (p.zoneId === zoneId || this.ctx.outerZone(p.zoneId) === this.ctx.outerZone(zoneId)) this.sendTo(p.userId, { t: 'toast', text: `Legendary: ${made.def.name}`, kind: 'loot' });
          this.refreshCharStats(p);
          this.markPlayer(p.userId);
        }
        for (const z of this.zones.values()) {
          z.lootDirty = true;
          for (const f of Object.keys(z.rt.features)) if (z.rt.features[f]?.loot?.includes(item)) z.featuresDirty.add(f);
        }
        this.markDirty();
      });
    }
  }

  private mergeDynamicItems() {
    this.ctx.uniqueItems = { ...this.world.uniqueItems, ...(this.state.dynamicItems ?? {}) };
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

export type { MonsterArchetype, CharacterSpec, DifficultyId };
