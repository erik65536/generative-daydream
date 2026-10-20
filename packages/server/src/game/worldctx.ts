/** Read-only helpers over a WorldDefinition (places' ground, lookups, naming). */
import {
  Nav, itemDisplayName, rx, type BossDef, type FeatureDef, type ItemInstance, type MonsterFamily, type MonsterMember, type NpcDef, type QuestDef,
  type Ruleset, type UniqueItemDef, type WorldDefinition, type ZoneDef,
} from '@gd/shared';

/** A place as the game uses it: where people can walk and see, and its features by id. */
export interface ZoneMap {
  def: ZoneDef;
  nav: Nav;
  features: Map<string, FeatureDef>;
}

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
    if (!def.nav) throw new Error(`${def.name} has not been painted`);
    m = { def, nav: new Nav(def.nav), features: new Map(def.features.map((f) => [f.id, f])) };
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
