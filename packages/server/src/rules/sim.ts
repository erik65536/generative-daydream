/**
 * Headless combat simulator: the real Combat / AI / effects code on a small arena with a virtual clock.
 * Used by the balance loop and by tests. Synchronous and deterministic for a given seed.
 */
import {
  Nav, Rng, makeNav, rx,
  type BossDef, type CharacterState, type CombatMode, type DifficultyId, type FxEvent, type ItemInstance, type MonsterFamily, type MonsterRole,
  type MonsterRuntime, type Ruleset, type SkillDef, type SpawnDef, type Surface, type ZoneDef,
} from '@gd/shared';
import { Actor, CharActor, MonsterActor } from '../game/actors';
import { Combat, type CombatHost } from '../game/combat';
import { createCharacter, levelUpTo, restoreFully } from '../game/characters';
import { makeItem } from '../game/loot';
import type { ZoneMap } from '../game/worldctx';
import { isFree, nearestFree } from '../game/space';
import { partySizeFor, type PackMember } from './encounters';

const ARENA_W = 22;
const ARENA_H = 18;

/** A walled arena (metres) with four square pillars to fight around. */
function arena(seed: string): ZoneMap {
  const rng = new Rng(`arena:${seed}`);
  const pillars = Array.from({ length: 4 }, () => ({ x: rng.int(8, 13) + 0.5, y: rng.int(3, ARENA_H - 4) + 0.5 }));
  // Walls and pillars are a metre thick; a person's centre keeps a body's width from them.
  const near = (x: number, y: number, by: number) => pillars.some((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < 0.5 + by);
  const inside = (x: number, y: number, by: number) => x > 1 + by && y > 1 + by && x < ARENA_W - 1 - by && y < ARENA_H - 1 - by;
  const nav = makeNav(ARENA_W, ARENA_H, (x, y) => inside(x, y, 0.35) && !near(x, y, 0.35), (x, y) => inside(x, y, 0) && !near(x, y, 0));
  const def = { id: 'arena', name: 'Arena', kind: 'dungeon', width: ARENA_W, height: ARENA_H, features: [], spawns: [], nav } as unknown as ZoneDef;
  return { def, nav: new Nav(nav), features: new Map() };
}

export interface FightTelemetry {
  /** classId|role -> skillId -> uses */
  uses: Map<string, Map<string, number>>;
}

class SimHost implements CombatHost {
  rng: Rng;
  private clock = 0;
  private seq = 0;
  private queue: { t: number; seq: number; fn: () => void }[] = [];
  actors: Actor[] = [];
  private surfaceList: Surface[] = [];
  readonly map: ZoneMap;
  ended: { victory: boolean } | null = null;
  potions: ItemInstance[] = [];
  potionsUsed = 0;
  constructor(public r: Ruleset, seed: string, public telemetry?: FightTelemetry) {
    this.rng = new Rng(seed);
    this.map = arena(seed);
  }
  now() { return this.clock; }
  after(ms: number, fn: () => void) { this.queue.push({ t: this.clock + Math.max(0, ms), seq: this.seq++, fn }); }
  /** Run queued work in time order until the fight ends or the step budget runs out. */
  run(maxSteps: number) {
    for (let i = 0; i < maxSteps && this.queue.length && !this.ended; i++) {
      let bi = 0;
      for (let j = 1; j < this.queue.length; j++) {
        const a = this.queue[j]!, b = this.queue[bi]!;
        if (a.t < b.t || (a.t === b.t && a.seq < b.seq)) bi = j;
      }
      const job = this.queue.splice(bi, 1)[0]!;
      this.clock = Math.max(this.clock, job.t);
      job.fn();
    }
  }
  actorsInZone() { return this.actors; }
  zoneMap() { return this.map; }
  isFree(_z: string, x: number, y: number, ignoreId?: string) {
    return isFree(this.map.nav, this.actors, { x, y }, ignoreId);
  }
  fx(_z: string, _e: FxEvent[]) {}
  surfaces() { return this.surfaceList; }
  surfacesChanged() {}
  onDamaged() {}
  onDowned(target: Actor) {
    if (target instanceof MonsterActor) target.rt.dead = true;
    else if (target instanceof CharActor) target.ch.downed = true;
  }
  log() {}
  actorMoved() {}
  broadcastCombat() {}
  combatEnded(_c: Combat, victory: boolean) { this.ended = { victory }; }
  checkTrapsAlong() { return null; }
  commandCompanions() { return false; }
  sendError() {}
  playersInCombat() { return []; }
  isMultiplayer() { return false; }
  onSkillUsed(a: Actor, skill: SkillDef) {
    if (!this.telemetry) return;
    const key = a instanceof CharActor ? a.ch.classId : a instanceof MonsterActor ? `m:${a.archetype}` : 'other';
    let m = this.telemetry.uses.get(key);
    if (!m) this.telemetry.uses.set(key, (m = new Map()));
    m.set(skill.id, (m.get(skill.id) ?? 0) + 1);
  }
  aiPotions(a: Actor) {
    if (!(a instanceof CharActor)) return [];
    return this.potions.slice(0, 1).map((item) => ({ item, consume: () => { this.potions.shift(); this.potionsUsed++; } }));
  }
}

// ------------------------------------------------------------------------------------ parties

function armorWeight(r: Ruleset, classId: string): string {
  const role = rx(r).cls.get(classId)?.role;
  return role === 'tank' || role === 'support' ? 'heavy' : role === 'caster' ? 'light' : 'medium';
}

/** Equip level-typical gear: the class's weapon kind at `level`, armor of its weight in every armor slot, accessories. */
export function equipTypical(r: Ruleset, ch: CharacterState, level: number, rng: Rng, rarityIndex: number) {
  const ix = rx(r);
  const cls = ix.cls.get(ch.classId)!;
  const rarity = r.rarities[Math.min(4, Math.max(0, rarityIndex))]!.id;
  const weight = armorWeight(r, ch.classId);
  const upgrade = r.crafting.upgrades.enabled ? Math.min(r.crafting.upgrades.maxLevel, Math.floor((level / Math.max(2, r.progression.maxLevel)) * r.crafting.upgrades.maxLevel * 0.6)) : 0;
  for (const slot of r.slots) {
    let baseId = cls.startingGear[slot.id];
    if (!baseId) {
      const cands = r.items.filter((i) => i.slotId === slot.id && (slot.kind !== 'armor' || i.tags.includes(weight)));
      const weaponId = cls.startingGear[r.slots.find((s) => s.kind === 'weapon')?.id ?? ''];
      if (slot.kind === 'offhand' && weaponId && ix.item.get(weaponId)?.weapon?.twoHanded) continue;
      if (!cands.length) continue;
      baseId = rng.pick(cands).id;
    }
    const it = makeItem(r, rng, baseId, level, rarity);
    it.upgrade = upgrade || undefined;
    ch.equipment[slot.id] = it;
  }
}

export interface PartyOptions {
  classes: string[];
  level: number;
  rng: Rng;
  style?: 'typical' | 'random';
  rarityIndex?: number;
  /** Override tree allocation (build search). */
  tree?: Record<string, number>;
}

export function makeParty(r: Ruleset, o: PartyOptions): CharacterState[] {
  return o.classes.map((classId, i) => {
    const { ch } = createCharacter(r, null, { name: `Sim${i}`, classId, kinId: r.kins[i % r.kins.length]!.id }, o.rng);
    ch.npcId = 'sim';
    if (o.tree) {
      ch.level = o.level;
      ch.tree = { ...o.tree };
      ch.treePoints = 0;
    } else levelUpTo(r, ch, o.level, o.rng, o.style ?? 'typical');
    equipTypical(r, ch, o.level, o.rng, o.rarityIndex ?? (o.level >= 4 ? 1 : 0));
    restoreFully(r, ch, o.classes.length === 1);
    return ch;
  });
}

/** Class line-ups for a mode, rotating so every class is exercised. */
export function partyLineups(r: Ruleset, mode: CombatMode, count: number): string[][] {
  const size = partySizeFor(mode);
  const ids = r.classes.map((c) => c.id);
  return Array.from({ length: count }, (_, i) => Array.from({ length: size }, (_, j) => ids[(i + j) % ids.length]!));
}

// ------------------------------------------------------------------------------------ fights

export interface FightSpec {
  party: CharacterState[];
  pack: PackMember[];
  /** Family subtype for the pack (resolves monster `$family` skills). */
  subtypeId?: string;
  potions: number;
  difficulty: DifficultyId;
  seed: string;
  telemetry?: FightTelemetry;
}

export interface FightResult {
  win: boolean;
  rounds: number;
  /** Fraction of the party's total health lost (downed counts as all of it). */
  hpLost: number;
  downed: number;
  potionsUsed: number;
}

const fakeFamily = (subtypeId: string | undefined, roles: MonsterRole[]): MonsterFamily => ({ id: 'simfam', name: 'Sim', description: '', element: subtypeId ?? '', habitat: '', members: roles.map((archetype) => ({ archetype, name: archetype, description: '', appearance: '' })) });

export function runFight(r: Ruleset, spec: FightSpec): FightResult {
  const host = new SimHost(r, spec.seed, spec.telemetry);
  const solo = spec.party.length === 1;
  // Deterministic ids: the AI's tie-breaks hash actor and combat ids.
  const party = spec.party.map((ch, i) => ({ ...(JSON.parse(JSON.stringify(ch)) as CharacterState), id: `c${i}` }));
  const heal = r.items.find((i) => i.category === 'potion' && i.use?.effects.some((e) => e.kind === 'heal'));
  if (heal) for (let i = 0; i < spec.potions; i++) host.potions.push(makeItem(r, host.rng, heal.id, party[0]?.level ?? 1, r.rarities[0]!.id));
  const chars = party.map((ch, i) => new CharActor(ch, 'sim', 'arena', 3 + (i % 2), 7 + i, r, () => solo));
  const family = fakeFamily(spec.subtypeId, spec.pack.map((m) => m.role));
  const monsters = spec.pack.map((m, i) => {
    const spawn: SpawnDef = { id: `m${i}`, kind: 'monster', familyId: family.id, archetype: m.role, level: m.level, x: 0, y: 0, groupId: 'g', elite: m.elite };
    const rt: MonsterRuntime = { spawnId: spawn.id, hp: -1, dead: false, x: 11 + (i % 3), y: 6 + Math.floor(i / 3) * 2 + (i % 2), scale: m.scale };
    const boss: BossDef | undefined = m.boss ? { id: 'b', name: 'Boss', title: '', description: '', familyId: family.id, archetype: m.role, level: m.level, zoneId: 'arena', appearance: '', drops: [] } : undefined;
    return new MonsterActor(spawn, rt, family, boss, 'arena', r, () => spec.difficulty);
  });
  host.actors = [...chars, ...monsters];
  // Everyone starts on open ground, a body's width apart.
  for (const a of host.actors) {
    const p = nearestFree(host.map.nav, host.actors, a, a);
    if (p) [a.x, a.y] = [p.x, p.y];
  }
  const maxHp = chars.reduce((s, c) => s + c.stats().maxHp, 0);
  const combat = new Combat(`sim_${spec.seed}`, 'arena', host);
  for (const a of host.actors) combat.add(a);
  combat.start();
  host.run(20000);
  const rounds = combat.round;
  const win = !!host.ended?.victory && monsters.every((m) => !m.alive());
  const hpLeft = chars.reduce((s, c) => s + (c.alive() ? c.hp : 0), 0);
  return { win, rounds, hpLost: Math.max(0, Math.min(1, 1 - hpLeft / Math.max(1, maxHp))), downed: chars.filter((c) => !c.alive()).length, potionsUsed: host.potionsUsed };
}

export function newTelemetry(): FightTelemetry {
  return { uses: new Map() };
}
