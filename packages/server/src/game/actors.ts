/** Live actors inside a zone. Characters, NPCs and monsters share the Actor interface used by combat. */
import {
  ARCHETYPES, ITEM_BASE, computeMonsterStats,
  type ActiveStatus, type BossDef, type CharacterState, type DamageType, type DerivedStats, type EntityKind, type EntityView, type MonsterArchetype,
  type MonsterFamily, type MonsterRuntime, type Motion, type NpcDef, type NpcRuntime, type SpawnDef, type WorldDefinition,
} from '@gd/shared';
import { statsOf } from './characters';

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
  /** Dirty flag for broadcasting. */
  dirty = true;
  bark?: { text: string; until: number };
  constructor(public readonly id: string, zoneId: string, x: number, y: number) {
    this.zoneId = zoneId;
    this.x = x;
    this.y = y;
  }
  abstract get name(): string;
  abstract get level(): number;
  abstract get hp(): number;
  abstract set hp(v: number);
  abstract get physArmor(): number;
  abstract set physArmor(v: number);
  abstract get magArmor(): number;
  abstract set magArmor(v: number);
  abstract get statuses(): ActiveStatus[];
  abstract set statuses(v: ActiveStatus[]);
  abstract get cooldowns(): Record<string, number>;
  abstract stats(): DerivedStats;
  abstract team(): Team;
  abstract skillIds(): string[];
  abstract alive(): boolean;
  protected _stamina = 100;
  protected _focus = 100;
  get stamina() { return this._stamina; }
  set stamina(v: number) { this._stamina = v; }
  get focus() { return this._focus; }
  set focus(v: number) { this._focus = v; }
  controllerUserId?: string;
  abstract view(w: WorldDefinition): EntityView;
  baseView(): Pick<EntityView, 'id' | 'x' | 'y' | 'motion' | 'facing' | 'statuses' | 'inCombat' | 'bark'> & { hp: number; physArmor: number; magArmor: number } {
    return { id: this.id, x: this.x, y: this.y, motion: this.motion ?? undefined, facing: this.facing, statuses: this.statuses, inCombat: this.combatId ?? undefined, bark: this.bark, hp: Math.round(this.hp), physArmor: Math.round(this.physArmor), magArmor: Math.round(this.magArmor) };
  }
}

export class CharActor extends Actor {
  readonly kind = 'character' as const;
  constructor(public ch: CharacterState, public readonly userId: string, zoneId: string, x: number, y: number, private world: WorldDefinition, public loneWolf: () => boolean) {
    super(ch.id, zoneId, x, y);
    this.controllerUserId = userId;
  }
  get name() { return this.ch.name; }
  get level() { return this.ch.level; }
  get hp() { return this.ch.hp; }
  set hp(v) { this.ch.hp = v; }
  get physArmor() { return this.ch.physArmor; }
  set physArmor(v) { this.ch.physArmor = v; }
  get magArmor() { return this.ch.magArmor; }
  set magArmor(v) { this.ch.magArmor = v; }
  get statuses() { return this.ch.statuses; }
  set statuses(v) { this.ch.statuses = v; }
  get cooldowns() { return this.ch.cooldowns; }
  override get stamina() { return this.ch?.stamina ?? 0; }
  override set stamina(v) { if (this.ch) this.ch.stamina = v; }
  override get focus() { return this.ch?.focus ?? 0; }
  override set focus(v) { if (this.ch) this.ch.focus = v; }
  stats() { return statsOf(this.ch, this.world, this.loneWolf()); }
  team(): Team { return 'players'; }
  skillIds() { return ['attack', ...this.ch.skills]; }
  alive() { return !this.ch.downed && this.ch.hp > 0; }
  /** Companions run on AI unless the owning player commands them. */
  aiDriven(commandCompanions: boolean) { return !!this.ch.npcId && !commandCompanions; }
  view(w: WorldDefinition): EntityView {
    const s = this.stats();
    const weapon = this.ch.equipment.mainhand ? ITEM_BASE[this.ch.equipment.mainhand.baseId]?.icon : undefined;
    const npc = this.ch.npcId ? w.npcs.find((n) => n.id === this.ch.npcId) : undefined;
    return {
      ...this.baseView(),
      kind: 'character',
      name: this.ch.name,
      title: npc ? npc.title : w.origins.find((o) => o.id === this.ch.originId)?.name,
      sprite: this.ch.sprite,
      colors: this.ch.colors.length ? this.ch.colors : npc?.colors ?? [],
      shape: 'humanoid',
      scale: 1,
      level: this.ch.level,
      maxHp: s.maxHp,
      maxPhys: s.maxPhys,
      maxMag: s.maxMag,
      hostile: false,
      ownerUserId: this.userId,
      downed: this.ch.downed,
      weapon,
      archetype: this.ch.archetype,
    };
  }
}

export class MonsterActor extends Actor {
  readonly kind = 'monster' as const;
  private _statuses: ActiveStatus[] = [];
  private _cool: Record<string, number> = {};
  private _phys: number;
  private _mag: number;
  private cached: DerivedStats | null = null;
  /** Wander anchor. */
  homeX: number;
  homeY: number;
  nextWanderAt = 0;
  constructor(public spawn: SpawnDef, public rt: MonsterRuntime, public family: MonsterFamily, public boss: BossDef | undefined, zoneId: string) {
    super(spawn.id, zoneId, rt.x, rt.y);
    this.homeX = spawn.x;
    this.homeY = spawn.y;
    const s = this.stats();
    this._phys = s.maxPhys;
    this._mag = s.maxMag;
    if (rt.hp <= 0 && !rt.dead) rt.hp = s.maxHp;
  }
  get archetype(): MonsterArchetype { return this.spawn.archetype; }
  get member() { return this.family.members.find((m) => m.archetype === this.spawn.archetype) ?? this.family.members[0]!; }
  get name() { return this.boss?.name ?? this.member.name; }
  get level() { return this.spawn.level; }
  get hp() { return this.rt.hp; }
  set hp(v) { this.rt.hp = v; }
  get physArmor() { return this._phys; }
  set physArmor(v) { this._phys = v; }
  get magArmor() { return this._mag; }
  set magArmor(v) { this._mag = v; }
  get statuses() { return this._statuses; }
  set statuses(v) { this._statuses = v; this.cached = null; }
  get cooldowns() { return this._cool; }
  stats() {
    return computeMonsterStats({ level: this.spawn.level, archetype: this.spawn.archetype, element: this.family.element, boss: !!this.boss, elite: this.spawn.elite, statuses: this._statuses });
  }
  team(): Team { return 'enemies'; }
  skillIds() { return ['attack', ...ARCHETYPES[this.spawn.archetype].skills]; }
  alive() { return !this.rt.dead && this.rt.hp > 0; }
  resetPools() {
    const s = this.stats();
    this.rt.hp = s.maxHp;
    this._phys = s.maxPhys;
    this._mag = s.maxMag;
    this._statuses = [];
    this._cool = {};
  }
  restoreArmor() {
    const s = this.stats();
    this._phys = s.maxPhys;
    this._mag = s.maxMag;
  }
  view(): EntityView {
    const s = this.stats();
    const a = ARCHETYPES[this.spawn.archetype];
    return {
      ...this.baseView(),
      kind: 'monster',
      name: this.name,
      title: this.boss?.title,
      sprite: this.boss?.asset ?? this.member.asset,
      colors: this.family.colors,
      shape: a.shape,
      scale: a.scale * (this.boss ? 1.45 : this.spawn.elite ? 1.15 : 1),
      level: this.spawn.level,
      maxHp: s.maxHp,
      maxPhys: s.maxPhys,
      maxMag: s.maxMag,
      hostile: true,
      archetype: this.spawn.archetype,
      dead: this.rt.dead,
      boss: !!this.boss,
      elite: this.spawn.elite,
      element: this.family.element as DamageType,
    };
  }
}

export class NpcActor extends Actor {
  readonly kind = 'npc' as const;
  private _statuses: ActiveStatus[] = [];
  private _cool: Record<string, number> = {};
  private _phys: number;
  private _mag: number;
  homeX: number;
  homeY: number;
  nextWanderAt = 0;
  nextBarkAt = 0;
  /** Player currently in conversation with this NPC. */
  talkingTo: string | null = null;
  constructor(public def: NpcDef, public rt: NpcRuntime, zoneId: string, private world: WorldDefinition) {
    super(def.id, zoneId, rt.x, rt.y);
    this.homeX = def.x;
    this.homeY = def.y;
    const s = this.stats();
    this._phys = s.maxPhys;
    this._mag = s.maxMag;
  }
  get name() { return this.def.name; }
  get level() { return this.def.level; }
  get hp() { return this.rt.hp; }
  set hp(v) { this.rt.hp = v; }
  get physArmor() { return this._phys; }
  set physArmor(v) { this._phys = v; }
  get magArmor() { return this._mag; }
  set magArmor(v) { this._mag = v; }
  get statuses() { return this._statuses; }
  set statuses(v) { this._statuses = v; }
  get cooldowns() { return this._cool; }
  stats() {
    return computeMonsterStats({ level: this.def.level, archetype: this.def.archetype, element: 'physical', statuses: this._statuses, elite: this.def.role === 'guard' });
  }
  team(): Team { return this.rt.hostileTo.length ? 'enemies' : 'neutral'; }
  skillIds() { return ['attack', ...ARCHETYPES[this.def.archetype].skills.filter((s) => !s.startsWith('m_'))]; }
  alive() { return this.rt.alive && this.rt.hp > 0; }
  resetPools() {
    const s = this.stats();
    this.rt.hp = s.maxHp;
    this._phys = s.maxPhys;
    this._mag = s.maxMag;
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
      maxPhys: s.maxPhys,
      maxMag: s.maxMag,
      hostile: this.rt.hostileTo.length > 0,
      role: this.def.role,
      archetype: this.def.archetype,
      dead: !this.rt.alive,
    };
  }
}
