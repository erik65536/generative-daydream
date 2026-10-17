/** Read-only helpers over a WorldDefinition (decoded maps, lookups, naming). */
import {
  GROUND, OBJ, base64ToBytes, itemDisplayName, rx, type BossDef, type FeatureDef, type ItemInstance, type MonsterFamily, type MonsterMember, type NpcDef, type QuestDef,
  type Ruleset, type TilesetDef, type UniqueItemDef, type WorldDefinition, type ZoneDef,
} from '@gd/shared';

export interface ZoneMap {
  def: ZoneDef;
  ground: Uint8Array;
  objects: Uint8Array;
  tileset: TilesetDef;
  features: Map<string, FeatureDef>;
  /** Static blocking (walls, water, blocking objects, solid features). */
  solid: Uint8Array;
  /** Blocks line of sight. */
  opaque: Uint8Array;
}

const BLOCKING_OBJ = new Set<number>([OBJ.tree, OBJ.rock, OBJ.furniture, OBJ.pillar, OBJ.light]);
const SOLID_FEATURES = new Set(['chest', 'shrine', 'sign', 'lever', 'lore', 'bed', 'craft_station', 'waypoint']);

export class WorldCtx {
  readonly zones = new Map<string, ZoneDef>();
  readonly npcs = new Map<string, NpcDef>();
  readonly families = new Map<string, MonsterFamily>();
  readonly bosses = new Map<string, BossDef>();
  readonly quests = new Map<string, QuestDef>();
  private maps = new Map<string, ZoneMap>();
  readonly r: Ruleset;
  /** World uniques plus items created during play. */
  uniqueItems: Record<string, UniqueItemDef>;

  constructor(public readonly world: WorldDefinition) {
    for (const z of world.zones) this.zones.set(z.id, z);
    for (const n of world.npcs) this.npcs.set(n.id, n);
    for (const f of world.families) this.families.set(f.id, f);
    for (const b of world.bosses) this.bosses.set(b.id, b);
    for (const q of world.quests) this.quests.set(q.id, q);
    this.r = world.ruleset;
    this.uniqueItems = { ...world.uniqueItems };
  }

  get terms() {
    return this.r.terminology;
  }

  itemName(item: ItemInstance): string {
    return itemDisplayName(this.r, item, { uniqueItems: this.uniqueItems });
  }

  itemDescription(item: ItemInstance): string {
    if (item.uniqueId && this.uniqueItems[item.uniqueId]) return this.uniqueItems[item.uniqueId]!.description;
    return rx(this.r).item.get(item.baseId)?.description ?? '';
  }

  skillName(skillId: string): string {
    return rx(this.r).skill.get(skillId)?.name ?? skillId;
  }

  className(classId: string): string {
    return rx(this.r).cls.get(classId)?.name ?? classId;
  }

  map(zoneId: string): ZoneMap {
    let m = this.maps.get(zoneId);
    if (m) return m;
    const def = this.zones.get(zoneId);
    if (!def) throw new Error(`Unknown zone ${zoneId}`);
    const ground = base64ToBytes(def.ground);
    const objects = base64ToBytes(def.objects);
    const n = def.width * def.height;
    const solid = new Uint8Array(n);
    const opaque = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const g = ground[i]!;
      const o = objects[i]!;
      const walk = g === GROUND.floor || g === GROUND.floorAlt || g === GROUND.path;
      if (!walk || BLOCKING_OBJ.has(o)) solid[i] = 1;
      if (g === GROUND.wall || g === GROUND.void || o === OBJ.tree || o === OBJ.pillar) opaque[i] = 1;
    }
    const features = new Map<string, FeatureDef>();
    for (const f of def.features) {
      features.set(f.id, f);
      const i = f.y * def.width + f.x;
      if (SOLID_FEATURES.has(f.kind) || f.kind === 'gate') solid[i] = 1;
      if (f.kind === 'gate') opaque[i] = 1;
    }
    m = { def, ground, objects, tileset: this.world.tilesets[def.tilesetId]!, features, solid, opaque };
    this.maps.set(zoneId, m);
    return m;
  }

  family(id: string): MonsterFamily | undefined {
    return this.families.get(id);
  }

  member(familyId: string, archetype: string): MonsterMember | undefined {
    const f = this.families.get(familyId);
    return f?.members.find((m) => m.archetype === archetype) ?? f?.members[0];
  }

  unique(id: string): UniqueItemDef | undefined {
    return this.world.uniqueItems[id];
  }

  /** The town a zone belongs to (itself, or the parent of an interior). */
  townOf(zoneId: string): string | undefined {
    const z = this.zones.get(zoneId);
    if (!z) return undefined;
    if (z.kind === 'town') return z.id;
    if (z.kind === 'interior' && z.parentZoneId) return z.parentZoneId;
    return undefined;
  }

  /** Top-level zone for maps and quest "reach" checks. */
  outerZone(zoneId: string): string {
    const z = this.zones.get(zoneId);
    return z?.kind === 'interior' && z.parentZoneId ? z.parentZoneId : zoneId;
  }
}
