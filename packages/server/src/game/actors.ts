/**
 * Live actors inside a zone. Characters, NPCs and monsters share the Actor interface used by combat and effects.
 * Stats come from the world's ruleset; the same classes run in the game and in the balance simulator.
 */
import {
  ROLE_VISUAL, characterStats, knownSkills, monsterStats, rx, skillRank,
  type ActiveStatus, type BossDef, type CharacterState, type DifficultyId, type EntityKind, type EntityView, type MonsterArchetype,
  type MonsterFamily, type MonsterRuntime, type Motion, type NpcDef, type NpcRuntime, type Ruleset, type SpawnDef, type StatBlock, type WorldDefinition,
} from '@gd/shared';

export type Team = 'players' | 'enemies' | 'neutral';

export const WALK_SPEED = 4.2; // tiles per second

export abstract class Actor {
  abstract readonly kind: EntityKind;
  zoneId: string;
  x: number;
  y: number;
  motion: Motion | null = null;
  facing = 0;
  combatId: string | null = null;
  /** Combat turn resources. */
  ap = 0;
  movementLeft = 0;
  /** Turns of immunity to control effects (after one ends). */
  controlImmune = 0;
  /** Dirty flag for broadcasting. */
  dirty = true;
  bark?: { text: string; until: number };
  controllerUserId?: string;
  protected statCache: { key: string; stats: StatBlock } | null = null;
  constructor(public readonly id: string, zoneId: string, x: number, y: number, protected readonly r: Ruleset) {
    this.zoneId = zoneId;
    this.x = x;
    this.y = y;
  }
  abstract get name(): string;
  abstract get level(): number;
  abstract get hp(): number;
  abstract set hp(v: number);
  abstract get barrier(): number;
  abstract set barrier(v: number);
  abstract get barrierTurns(): number;
  abstract set barrierTurns(v: number);
  abstract get pools(): Record<string, number>;
  abstract get statuses(): ActiveStatus[];
  abstract set statuses(v: ActiveStatus[]);
  abstract get cooldowns(): Record<string, number>;
  protected abstract computeStats(): StatBlock;
  /** Cache key for stats: anything that changes them. */
  protected abstract statKey(): string;
  stats(): StatBlock {
    const key = this.statKey();
    if (this.statCache?.key === key) return this.statCache.stats;
    const stats = this.computeStats();
    this.statCache = { key, stats };
    return stats;
  }
  abstract team(): Team;
  abstract skillIds(): string[];
  skillRank(skillId: string): number {
    void skillId;
    return 1;
  }
  abstract alive(): boolean;
  /** Downed characters stay on the field and can be revived. */
  downed(): boolean {
    return false;
  }
  abstract view(w: WorldDefinition): EntityView;
  baseView(): Pick<EntityView, 'id' | 'x' | 'y' | 'motion' | 'facing' | 'statuses' | 'inCombat' | 'bark' | 'hp' | 'barrier'> {
    return { id: this.id, x: this.x, y: this.y, motion: this.motion ?? undefined, facing: this.facing, statuses: this.statuses, inCombat: this.combatId ?? undefined, bark: this.bark, hp: Math.round(this.hp), barrier: Math.round(this.barrier) };
  }
  protected statusKey() {
    return this.statuses.map((s) => s.id).join(',');
  }
}

export class CharActor extends Actor {
  readonly kind = 'character' as const;
  constructor(public ch: CharacterState, public readonly userId: string, zoneId: string, x: number, y: number, r: Ruleset, public solo: () => boolean, private world?: WorldDefinition) {
    super(ch.id, zoneId, x, y, r);
    this.controllerUserId = userId;
  }
  get name() { return this.ch.name; }
  get level() { return this.ch.level; }
  get hp() { return this.ch.hp; }
  set hp(v) { this.ch.hp = v; }
  get barrier() { return this.ch.barrier ?? 0; }
  set barrier(v) { this.ch.barrier = v; }
  get barrierTurns() { return this.ch.barrierTurns ?? 0; }
  set barrierTurns(v) { this.ch.barrierTurns = v; }
  get pools() { return this.ch.pools; }
  get statuses() { return this.ch.statuses; }
  set statuses(v) { this.ch.statuses = v; }
  get cooldowns() { return this.ch.cooldowns; }
  protected statKey() {
    const eq = Object.values(this.ch.equipment).map((i) => (i ? `${i.id}:${i.upgrade ?? 0}` : '')).join(',');
    return `${this.ch.level}|${eq}|${Object.entries(this.ch.tree).map(([k, v]) => `${k}${v}`).join(',')}|${this.statusKey()}|${this.solo() ? 1 : 0}`;
  }
  protected computeStats() {
    return characterStats(this.r, this.ch, { solo: this.solo() });
  }
  team(): Team { return 'players'; }
  skillIds() { return knownSkills(this.r, this.ch); }
  override skillRank(skillId: string) { return skillId === this.r.basicAttackId ? 1 : Math.max(1, skillRank(this.r, this.ch, skillId)); }
  alive() { return !this.ch.downed && this.ch.hp > 0; }
  override downed() { return this.ch.downed; }
  /** Companions run on AI unless the owning player commands them. */
  aiDriven(commandCompanions: boolean) { return !!this.ch.npcId && !commandCompanions; }
  view(w: WorldDefinition): EntityView {
    const s = this.stats();
    const wSlot = this.r.slots.find((x) => x.kind === 'weapon');
    const weapon = wSlot && this.ch.equipment[wSlot.id] ? rx(this.r).item.get(this.ch.equipment[wSlot.id]!.baseId)?.icon : undefined;
    const npc = this.ch.npcId ? w.npcs.find((n) => n.id === this.ch.npcId) : undefined;
    return {
      ...this.baseView(),
      kind: 'character',
      name: this.ch.name,
      title: npc ? npc.title : rx(this.r).cls.get(this.ch.classId)?.name,
      sprite: this.ch.sprite,
      colors: this.ch.colors.length ? this.ch.colors : npc?.colors ?? [],
      shape: 'humanoid',
      scale: 1,
      level: this.ch.level,
      maxHp: s.maxHp,
      hostile: false,
      ownerUserId: this.userId,
      downed: this.ch.downed,
      weapon,
      archetype: this.ch.archetype ?? rx(this.r).cls.get(this.ch.classId)?.aiRole,
    };
    void this.world;
  }
}

export class MonsterActor extends Actor {
  readonly kind = 'monster' as const;
  private _statuses: ActiveStatus[] = [];
  private _cool: Record<string, number> = {};
  private _barrier = 0;
  private _barrierTurns = 0;
  private _pools: Record<string, number> = {};
  /** Wander anchor. */
  homeX: number;
  homeY: number;
  nextWanderAt = 0;
  constructor(public spawn: SpawnDef, public rt: MonsterRuntime, public family: MonsterFamily, public boss: BossDef | undefined, zoneId: string, r: Ruleset, public difficulty: () => DifficultyId = () => 'normal') {
    super(spawn.id, zoneId, rt.x, rt.y, r);
    this.homeX = spawn.x;
    this.homeY = spawn.y;
    if (rt.hp <= 0 && !rt.dead) rt.hp = this.stats().maxHp;
  }
  get archetype(): MonsterArchetype { return this.spawn.archetype; }
  get elite(): boolean { return this.rt.elite ?? !!this.spawn.elite; }
  get member() { return this.family.members.find((m) => m.archetype === this.spawn.archetype) ?? this.family.members[0]!; }
  get name() { return this.boss?.name ?? this.member.name; }
  get level() { return this.spawn.level; }
  get hp() { return this.rt.hp; }
  set hp(v) { this.rt.hp = v; }
  get barrier() { return this._barrier; }
  set barrier(v) { this._barrier = v; }
  get barrierTurns() { return this._barrierTurns; }
  set barrierTurns(v) { this._barrierTurns = v; }
  get pools() { return this._pools; }
  get statuses() { return this._statuses; }
  set statuses(v) { this._statuses = v; }
  get cooldowns() { return this._cool; }
  protected statKey() { return `${this.statusKey()}|${this.difficulty()}`; }
  protected computeStats() {
    return monsterStats(this.r, { level: this.spawn.level, role: this.spawn.archetype, boss: !!this.boss, elite: this.elite, subtypeId: this.family.element, statuses: this._statuses, difficulty: this.difficulty(), scale: this.rt.scale });
  }
  team(): Team { return 'enemies'; }
  skillIds() { return [this.r.basicAttackId, ...(this.r.monsters[this.spawn.archetype]?.skills ?? [])]; }
  alive() { return !this.rt.dead && this.rt.hp > 0; }
  resetPools() {
    this.rt.hp = this.stats().maxHp;
    this._barrier = 0;
    this._statuses = [];
    this._cool = {};
  }
  view(): EntityView {
    const s = this.stats();
    const v = ROLE_VISUAL[this.spawn.archetype];
    return {
      ...this.baseView(),
      kind: 'monster',
      name: this.name,
      title: this.boss?.title,
      sprite: this.boss?.asset ?? this.member.asset,
      colors: this.family.colors,
      shape: v.shape,
      scale: v.scale * (this.boss ? 1.45 : this.elite ? 1.15 : 1),
      level: this.spawn.level,
      maxHp: s.maxHp,
      hostile: true,
      archetype: this.spawn.archetype,
      dead: this.rt.dead,
      boss: !!this.boss,
      elite: this.elite,
      element: this.family.element,
    };
  }
}

export class NpcActor extends Actor {
  readonly kind = 'npc' as const;
  private _statuses: ActiveStatus[] = [];
  private _cool: Record<string, number> = {};
  private _barrier = 0;
  private _barrierTurns = 0;
  private _pools: Record<string, number> = {};
  homeX: number;
  homeY: number;
  nextWanderAt = 0;
  nextBarkAt = 0;
  /** Player currently in conversation with this NPC. */
  talkingTo: string | null = null;
  constructor(public def: NpcDef, public rt: NpcRuntime, zoneId: string, r: Ruleset) {
    super(def.id, zoneId, rt.x, rt.y, r);
    this.homeX = def.x;
    this.homeY = def.y;
  }
  get name() { return this.def.name; }
  get level() { return this.def.level; }
  get hp() { return this.rt.hp; }
  set hp(v) { this.rt.hp = v; }
  get barrier() { return this._barrier; }
  set barrier(v) { this._barrier = v; }
  get barrierTurns() { return this._barrierTurns; }
  set barrierTurns(v) { this._barrierTurns = v; }
  get pools() { return this._pools; }
  get statuses() { return this._statuses; }
  set statuses(v) { this._statuses = v; }
  get cooldowns() { return this._cool; }
  protected statKey() { return this.statusKey(); }
  protected computeStats() {
    return monsterStats(this.r, { level: this.def.level, role: this.def.archetype, statuses: this._statuses, elite: this.def.role === 'guard', npc: true });
  }
  team(): Team { return this.rt.hostileTo.length ? 'enemies' : 'neutral'; }
  skillIds() { return [this.r.basicAttackId, ...(this.r.monsters[this.def.archetype]?.skills ?? [])]; }
  alive() { return this.rt.alive && this.rt.hp > 0; }
  resetPools() {
    this.rt.hp = this.stats().maxHp;
    this._barrier = 0;
    this._statuses = [];
  }
  view(): EntityView {
    const s = this.stats();
    return {
      ...this.baseView(),
      kind: 'npc',
      name: this.def.name,
      title: this.def.title,
      sprite: this.def.asset,
      colors: this.def.colors,
      shape: 'humanoid',
      scale: 1,
      level: this.def.level,
      maxHp: s.maxHp,
      hostile: this.rt.hostileTo.length > 0,
      role: this.def.role,
      archetype: this.def.archetype,
      dead: !this.rt.alive,
    };
  }
}
