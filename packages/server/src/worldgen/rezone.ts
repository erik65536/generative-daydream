/**
 * Whole-place regeneration for the studio: a new map for one place of an existing world (optionally from an
 * edited layout plan), and for towns and wilds new content from the content model, spliced into the world
 * without renumbering anything that belongs to other places. Works on any saved world (no Draft needed).
 */
import {
  GROUND, Rng, SIZE_PROFILES, base64ToBytes, findPath, slugify,
  type FeatureDef, type NpcDef, type NpcRole, type QuestDef, type QuestObjective, type SpawnDef, type Vec2, type WorldDefinition, type ZoneDef, type ZoneLayoutPlan,
} from '@gd/shared';
import { genai } from '../genai/service';
import { questRewards } from '../rules/bind';
import { fuzzy } from './assemble';
import { fallbackAreaContent, fallbackNpc, fallbackTownContent, type NpcPlan } from './fallbacks';
import { BANKS, detectGenre, fallbackTileset, type Genre } from './genres';
import { generateDungeon, generateInterior, generateTown, generateWilderness, resolvePlan, type LayoutResult, type MapBuilder } from './layout';
import * as P from './prompts';
import { AreaContentSchema, LayoutPlanSchema, TownContentSchema, type AreaContentOut, type NpcOut, type TownContentOut } from './schemas';

type OuterKind = 'town' | 'wilderness' | 'dungeon';
export type PlanDraft = Partial<Omit<ZoneLayoutPlan, 'blockers'>> & { blockers?: Partial<ZoneLayoutPlan['blockers']> };

/** Roles that keep a shop, inn or workshop indoors. */
const INDOOR_ROLES: NpcRole[] = ['merchant', 'innkeeper', 'trainer', 'crafter', 'mystic', 'noble'];
/** Packs keep their distance so fighting one never drags in the next (aggro radius is 6.5 tiles). */
const PACK_SPACING = 13;
const ATTEMPTS = 10;

const sizeBoost = (w: WorldDefinition) => (w.input.size === 'huge' ? 8 : w.input.size === 'large' ? 4 : 0);
const genreOf = (w: WorldDefinition): Genre => {
  const g = w.concept.genre?.toLowerCase();
  return g && g in BANKS ? (g as Genre) : detectGenre(`${w.input.setting} ${w.input.story ?? ''} ${w.input.notes ?? ''}`);
};
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function outerZone(w: WorldDefinition, zoneId: string): ZoneDef & { kind: OuterKind } {
  const z = w.zones.find((x) => x.id === zoneId);
  if (!z) throw new Error('No such place.');
  if (z.kind === 'interior') throw new Error('Rooms inside buildings are rebuilt with the town they belong to.');
  return z as ZoneDef & { kind: OuterKind };
}

// ------------------------------------------------------------------------------------ layout

function generate(w: WorldDefinition, z: ZoneDef & { kind: OuterKind }, plan: ZoneLayoutPlan, rng: Rng) {
  const edges = z.features.filter((f) => f.kind === 'exit' && f.facing).map((f) => f.facing!);
  const boost = sizeBoost(w);
  if (z.kind === 'town') return generateTown(rng, { size: 50 + boost, buildingCount: z.features.filter((f) => f.kind === 'door').length, edges, plan });
  if (z.kind === 'wilderness') {
    const internalExits = z.features.filter((f) => f.kind === 'exit' && !f.facing).length;
    return generateWilderness(rng, { size: 62 + boost, edges, internalExits, style: w.tilesets[z.tilesetId]?.style ?? 'grass', plan });
  }
  return generateDungeon(rng, { size: 54 + boost, caves: plan.structure === 'caves' });
}

/** Everything a place has, moved onto a freshly generated map; null when the map cannot hold it. */
function placeOnto(w: WorldDefinition, z: ZoneDef & { kind: OuterKind }, lay: LayoutResult & { gate?: { gates: Vec2[]; lever: Vec2 } }, rng: Rng) {
  const m: MapBuilder = lay.map;
  const feats: FeatureDef[] = [];
  const put = (f: FeatureDef, p: Vec2) => {
    const nf = { ...f, x: p.x, y: p.y };
    feats.push(nf);
    m.features.push(nf);
  };
  const anywhere = () => m.randomFree(rng) ?? lay.entry;
  const near = (c: Vec2, r: number) => m.randomFree(rng, (x, y) => Math.hypot(x - c.x, y - c.y) < r) ?? anywhere();

  // Exits keep their ids, targets and edges, so the places on the other side still lead here.
  let internal = 0;
  for (const f of z.features.filter((x) => x.kind === 'exit')) {
    let p: Vec2 | undefined;
    if (z.kind === 'dungeon') {
      p = { x: lay.entry.x, y: lay.entry.y - 1 };
      m.setG(p.x, p.y, GROUND.floor);
    } else if (f.facing) p = lay.edgeExits[f.facing];
    else p = lay.internalExitSpots[internal++] ?? lay.entry;
    if (!p) return null;
    put(f, p);
  }
  // Doors keep their ids, so each still pairs with its own interior.
  const doors = z.features.filter((x) => x.kind === 'door');
  if (lay.buildings.length < doors.length) return null;
  doors.forEach((f, i) => put(f, lay.buildings[i]!.door));

  const exitsNear = (p: Vec2, r: number) => feats.some((f) => (f.kind === 'exit' || f.kind === 'door') && dist(f, p) < r) || dist(p, lay.entry) < r;
  const rest = z.features.filter((f) => f.kind !== 'exit' && f.kind !== 'door' && f.kind !== 'gate' && f.kind !== 'lever');
  const plaza = lay.plaza ?? lay.entry;
  // Chests: the ones holding quest items go deepest.
  const chests = rest.filter((f) => f.kind === 'chest').sort((a, b) => (b.items?.length ? 1 : 0) - (a.items?.length ? 1 : 0) || (b.lootTier ?? 0) - (a.lootTier ?? 0));
  const chestSpots = [...lay.chestSpots].sort((a, b) => b.depth - a.depth);
  for (const c of chests) {
    let s = chestSpots.shift();
    while (s && !m.free(s.x, s.y)) s = chestSpots.shift();
    put(c, s ?? anywhere());
  }
  const trapSpots = lay.trapSpots.filter((t) => !exitsNear(t, 5));
  const decor = [...lay.decorSpots];
  const takeDecor = () => {
    while (decor.length) {
      const p = decor.shift()!;
      if (m.free(p.x, p.y)) return p;
    }
    return anywhere();
  };
  for (const f of rest) {
    if (f.kind === 'chest') continue;
    if (f.kind === 'waypoint') put(f, m.free(plaza.x + 2, plaza.y - 2) ? { x: plaza.x + 2, y: plaza.y - 2 } : near(plaza, 7));
    else if (f.kind === 'sign') put(f, near(lay.entry, 5));
    else if (f.kind === 'craft_station') put(f, near(plaza, 9));
    else if (f.kind === 'trap') {
      let t = trapSpots.shift();
      while (t && !m.free(t.x, t.y)) t = trapSpots.shift();
      put(f, t ?? m.randomFree(rng, (x, y) => !exitsNear({ x, y }, 5)) ?? anywhere());
    } else if (f.id.includes('_fx_') || f.id.startsWith('fx_')) put(f, m.randomFree(rng, (x, y) => Math.hypot(x - lay.entry.x, y - lay.entry.y) > 8) ?? anywhere());
    else if (f.kind === 'shrine' || f.kind === 'lore') put(f, takeDecor());
    else put(f, anywhere());
  }
  // A dungeon's sealed gate belongs to its map: the new map brings its own.
  if (lay.gate) {
    const gids = lay.gate.gates.map((t, i) => {
      const gid = `${z.id}_gate${i}`;
      put({ id: gid, kind: 'gate', x: 0, y: 0, name: 'Sealed Gate' }, t);
      return gid;
    });
    put({ id: `${z.id}_lever0`, kind: 'lever', x: 0, y: 0, gateIds: gids, name: w.tilesets[z.tilesetId]?.roles.lever.name ?? 'Lever' }, lay.gate.lever);
  }

  // Monsters: same groups, new places (boss groups at the boss spot, the rest from shallow to deep).
  const spawns: SpawnDef[] = [];
  const taken = (x: number, y: number) => spawns.some((s) => s.x === x && s.y === y);
  const groups = new Map<string, SpawnDef[]>();
  for (const s of z.spawns) groups.set(s.groupId, [...(groups.get(s.groupId) ?? []), s]);
  const bossGroups = [...groups.values()].filter((g) => g.some((s) => s.bossId));
  const packs = [...groups.values()].filter((g) => !g.some((s) => s.bossId)).sort((a, b) => a.reduce((t, s) => t + s.level, 0) / a.length - b.reduce((t, s) => t + s.level, 0) / b.length);
  const used: Vec2[] = [];
  for (const g of bossGroups) {
    const spot = lay.bossSpot ?? lay.packSpots[lay.packSpots.length - 1] ?? lay.entry;
    used.push(spot);
    for (const s of g) {
      const p = s.bossId ? spot : m.randomFree(rng, (x, y) => Math.hypot(x - spot.x, y - spot.y) < 4 && !taken(x, y)) ?? spot;
      spawns.push({ ...s, x: p.x, y: p.y });
    }
  }
  const spots = [...lay.packSpots].sort((a, b) => a.depth - b.depth);
  const pickSpot = (exitR: number, spacing: number) => spots.find((s) => !exitsNear(s, exitR) && !used.some((u) => dist(u, s) < spacing) && m.passable(s.x, s.y));
  for (const g of packs) {
    const spot = pickSpot(9, PACK_SPACING) ?? pickSpot(7, 9);
    if (!spot) continue; // no room left for this pack on the new map
    used.push(spot);
    for (const s of g) {
      const p = m.randomFree(rng, (x, y) => Math.hypot(x - spot.x, y - spot.y) < 2.6 && !taken(x, y)) ?? spot;
      spawns.push({ ...s, x: p.x, y: p.y });
    }
  }

  // People outdoors in this place.
  const npcPos = new Map<string, Vec2>();
  w.npcs.filter((n) => n.zoneId === z.id).forEach((n, i) => npcPos.set(n.id, lay.npcSpots.length ? lay.npcSpots[i % lay.npcSpots.length]! : near(lay.entry, 6)));

  for (const f of feats) m.setO(f.x, f.y, 0);
  for (const s of spawns) m.setO(s.x, s.y, 0);
  // Every way out must be reachable from where people arrive.
  for (const f of feats.filter((x) => x.kind === 'exit' || x.kind === 'door')) {
    if (!findPath(lay.entry, f, { width: m.w, height: m.h, passable: (x, y) => m.passable(x, y), stopWithin: 1.5, maxNodes: 80000 })) return null;
  }
  return { feats, spawns, npcPos };
}

export interface RebuildResult {
  zoneId: string;
  plan: ZoneLayoutPlan;
  width: number;
  height: number;
  droppedPacks: number;
}

/**
 * Give one place a new map: its generator runs again with a new seed and the (possibly edited) plan, keeping
 * the same edge exits, and everything in it (exits, doors, chests, shrines, people, monsters) is placed again.
 * Other places are untouched.
 */
export function rebuildZoneMap(w: WorldDefinition, zoneId: string, opts: { plan?: PlanDraft; seed?: string } = {}): RebuildResult {
  const z = outerZone(w, zoneId);
  const ts = w.tilesets[z.tilesetId];
  const draft = opts.plan ? { ...z.layout, ...opts.plan, blockers: { ...z.layout?.blockers, ...opts.plan.blockers } } : z.layout;
  const plan = resolvePlan(z.kind, draft as PlanDraft & { blockers?: ZoneLayoutPlan['blockers'] }, ts?.style);
  const seed = opts.seed ?? `${Date.now()}`;
  for (let t = 0; t < ATTEMPTS; t++) {
    const rng = new Rng(`${w.seed}:rezone:${z.id}:${seed}:${t}`);
    const lay = generate(w, z, plan, rng);
    const placed = placeOnto(w, z, lay, rng);
    if (!placed) continue;
    const enc = lay.map.encode();
    const groups = new Set(z.spawns.map((s) => s.groupId)).size - new Set(placed.spawns.map((s) => s.groupId)).size;
    Object.assign(z, { width: lay.map.w, height: lay.map.h, ground: enc.ground, objects: enc.objects, variation: enc.variation, entry: lay.entry, layout: plan, indoor: plan.enclosed || undefined, features: placed.feats, spawns: placed.spawns });
    for (const n of w.npcs) {
      const p = placed.npcPos.get(n.id);
      if (p) Object.assign(n, { x: p.x, y: p.y });
    }
    // Indoors or out decides the light, as when the world was made.
    if (ts) {
      ts.outdoor = !plan.enclosed;
      if (z.kind === 'dungeon') ts.ambient = Math.min(0.5, ts.ambient);
      else if (plan.enclosed) ts.ambient = Math.min(0.92, Math.max(0.7, ts.ambient));
      else ts.ambient = Math.max(0.85, ts.ambient);
    }
    w.updatedAt = Date.now();
    return { zoneId: z.id, plan, width: z.width, height: z.height, droppedPacks: groups };
  }
  throw new Error(z.kind === 'town' ? `This layout could not fit ${z.features.filter((f) => f.kind === 'door').length} buildings with every way out reachable; try another structure or fewer blockers.` : 'This layout could not connect every way out; try another structure or fewer blockers.');
}

/** Let the design model choose the place's level design from the owner's direction. */
export async function designZonePlan(w: WorldDefinition, zoneId: string, guidance: string): Promise<PlanDraft | undefined> {
  const z = outerZone(w, zoneId);
  const g = genai();
  if (g.isProcedural('world.design') || !guidance.trim()) return undefined;
  const out = await g.structured('world.design', {
    system: P.SYSTEM,
    prompt: `${P.conceptSummary(w.concept as never)}\n\nPLACE: ${z.name}, a ${z.kind}: ${z.description}\nIts level design now: ${JSON.stringify(z.layout ?? {})}\n\nTHE OWNER'S DIRECTION FOR THIS PLACE: ${guidance.trim()}\n\nGive the place's new "layout" following the direction.\n${P.LAYOUT_HELP}`,
    schema: LayoutPlanSchema,
    name: 'layout',
    maxTokens: 600,
  });
  return out;
}

// ------------------------------------------------------------------------------------ content

/** Ask the content model for a place's new people and side quests (towns) or lore and shrine (wilds). */
export async function writeZoneContent(w: WorldDefinition, zoneId: string, guidance: string): Promise<TownContentOut | AreaContentOut> {
  const z = outerZone(w, zoneId);
  const g = genai();
  const genre = genreOf(w);
  const rng = new Rng(`${w.seed}:content:${z.id}:${Date.now()}`);
  const concept = w.concept as never;
  const direction = guidance.trim() ? `\n\nTHE OWNER'S DIRECTION FOR THIS PLACE (follow it closely): ${guidance.trim()}` : '';
  const region = String(z.regionIndex);
  const linked = z.links.map((id) => w.zones.find((x) => x.id === id)).filter((x): x is ZoneDef => !!x);
  if (z.kind === 'town') {
    const here = townZoneIds(w, z);
    const keyNpcs = w.npcs.filter((n) => here.has(n.zoneId) && n.essential);
    const size = SIZE_PROFILES[w.input.size];
    const npcCount = Math.max(w.input.combatMode === 'party_npc' ? 8 : 7, w.npcs.filter((n) => here.has(n.zoneId) && !n.essential).length);
    const sideQuests = Math.max(size.sideQuestsPerTown[0], Math.min(size.sideQuestsPerTown[1], w.quests.filter((q) => !q.main && q.zoneId === z.id).length));
    const families = [...new Set(linked.flatMap((l) => l.familyIds))].map((id) => w.families.find((f) => f.id === id)?.name).filter((x): x is string => !!x);
    const fb = () => {
      const fbTs = fallbackTileset(z.tilesetId, z.name, w.tilesets[z.tilesetId]?.style ?? 'stone', 'town', genre);
      return fallbackTownContent(genre, rng, z.name, npcCount, fbTs, fbTs, { families, zones: linked.map((l) => l.name) }, sideQuests);
    };
    if (g.isProcedural('world.content')) return fb();
    return g.structured('world.content', {
      system: P.SYSTEM,
      prompt: P.townPrompt(w.input, concept, { name: z.name, description: z.description, lore: z.lore, level: z.levelRange[0], region }, {
        npcCount, sideQuests, keyNpcs: keyNpcs.map((k) => `${k.name} (${k.title})`), nearbyZones: linked.map((l) => l.name), families, companions: w.input.combatMode === 'party_npc',
        requiredRoles: ['innkeeper', 'merchant (general)', 'merchant (weapons or armor)', 'trainer', 'guard'],
      }) + `\n\nThe town's look (tileset, interiorTileset) is kept as it is; return it anyway.${direction}`,
      schema: TownContentSchema,
      name: 'town_content',
      maxTokens: 9000,
    });
  }
  const loreCount = z.kind === 'dungeon' ? 2 : 1;
  const fb = () => fallbackAreaContent(fallbackTileset(z.tilesetId, z.name, w.tilesets[z.tilesetId]?.style ?? 'grass', z.kind, genre), z.name, rng, genre);
  if (g.isProcedural('world.content')) return fb();
  const families = z.familyIds.map((id) => w.families.find((f) => f.id === id)?.name).filter((x): x is string => !!x);
  return g.structured('world.content', {
    system: P.SYSTEM,
    prompt: P.areaPrompt(w.input, concept, { name: z.name, kind: z.kind, description: z.description, lore: z.lore, level: z.levelRange, families }, loreCount) + `\n\nThe zone's look (tileset) is kept as it is; return it anyway.${direction}`,
    schema: AreaContentSchema,
    name: 'area_content',
    maxTokens: 5000,
  });
}

/** An open, reachable tile on a saved map, away from its entry (for something new placed in a place that keeps its map). */
function freeTileIn(z: ZoneDef, rng: Rng): Vec2 | null {
  const g = base64ToBytes(z.ground), o = base64ToBytes(z.objects);
  const walk = (x: number, y: number) => x > 0 && y > 0 && x < z.width - 1 && y < z.height - 1 && [GROUND.floor, GROUND.floorAlt, GROUND.path].includes(g[y * z.width + x] as 1);
  const busy = (x: number, y: number) => z.features.some((f) => f.x === x && f.y === y) || z.spawns.some((s) => s.x === x && s.y === y);
  for (let t = 0; t < 400; t++) {
    const x = rng.int(1, z.width - 2), y = rng.int(1, z.height - 2);
    if (!walk(x, y) || o[y * z.width + x] || busy(x, y) || Math.hypot(x - z.entry.x, y - z.entry.y) < 8) continue;
    if (findPath(z.entry, { x, y }, { width: z.width, height: z.height, passable: (px, py) => walk(px, py) && !o[py * z.width + px], stopWithin: 1.5, maxNodes: 40000 })) return { x, y };
  }
  return null;
}

const townZoneIds = (w: WorldDefinition, z: ZoneDef) => new Set([z.id, ...w.zones.filter((i) => i.parentZoneId === z.id).map((i) => i.id)]);

/** Swap a name in a quest's texts. */
function swapInQuest(q: QuestDef, from: string, to: string) {
  if (!from || from === to) return;
  const s = (t: string | undefined) => (t && t.includes(from) ? t.split(from).join(to) : t);
  q.title = s(q.title)!;
  q.summary = s(q.summary)!;
  q.completionText = s(q.completionText);
  for (const o of q.objectives) o.description = s(o.description)!;
}

export interface ContentResult {
  added: string[];
  removed: string[];
  quests: string[];
}

/**
 * Replace a town's residents (story characters stay), its side quests and its buildings with new content.
 * New ids never reuse another place's; quests elsewhere that needed a removed resident are handed to a
 * new resident with the same job. The town's map must be rebuilt afterwards (rebuildZoneMap) to seat the
 * new buildings.
 */
export function spliceTownContent(w: WorldDefinition, zoneId: string, content: TownContentOut, seed = `${Date.now()}`): ContentResult {
  const z = outerZone(w, zoneId);
  if (z.kind !== 'town') throw new Error('Only towns have residents.');
  const rng = new Rng(`${w.seed}:towncontent:${z.id}:${seed}`);
  const genre = genreOf(w);
  const bank = BANKS[genre];
  const r = w.ruleset;
  const systems = { traps: r.systems.traps, lockpicking: r.systems.locks, crafting: r.crafting.enabled };
  const size = SIZE_PROFILES[w.input.size];
  const here = townZoneIds(w, z);
  const oldResidents = w.npcs.filter((n) => here.has(n.zoneId) && !n.essential);
  const story = w.npcs.filter((n) => here.has(n.zoneId) && n.essential);

  // 1. The town's side quests go, with the items and quest markers only they used.
  const oldSide = w.quests.filter((q) => !q.main && q.zoneId === z.id);
  const sideIds = new Set(oldSide.map((q) => q.id));
  const keepQuests = w.quests.filter((q) => !sideIds.has(q.id));
  const stillUsed = (u: string) => keepQuests.some((q) => q.objectives.some((o) => o.itemUniqueId === u) || q.grantsOnStart?.includes(u));
  const deadItems = new Set(oldSide.flatMap((q) => [...q.objectives.map((o) => o.itemUniqueId), ...(q.grantsOnStart ?? [])]).filter((u): u is string => !!u && u.startsWith('u_side_') && !stillUsed(u)));
  const deadFx = new Set(oldSide.flatMap((q) => q.objectives.map((o) => o.featureId)).filter((f): f is string => !!f && !keepQuests.some((q) => q.objectives.some((o) => o.featureId === f))));
  w.quests = keepQuests;
  for (const u of deadItems) delete w.uniqueItems[u];
  for (const b of w.bosses) b.drops = b.drops.filter((u) => !deadItems.has(u));
  for (const zz of w.zones) {
    if (zz.features.some((f) => deadFx.has(f.id))) zz.features = zz.features.filter((f) => !deadFx.has(f.id));
    for (const f of zz.features) if (f.items?.some((u) => deadItems.has(u))) {
      f.items = f.items.filter((u) => !deadItems.has(u));
      if (!f.items.length) delete f.items;
    }
  }
  for (const n of w.npcs) n.questIds = n.questIds.filter((q) => !sideIds.has(q));

  // 2. New residents (anyone keeping their name keeps their id, memories and portrait).
  const companionsAllowed = w.input.combatMode === 'party_npc';
  const list: NpcOut[] = content.npcs.filter((o) => !story.some((s) => s.name.toLowerCase() === o.name.toLowerCase()));
  const required: NpcPlan[] = [
    { role: 'innkeeper', slot: 'innkeeper' },
    { role: 'merchant', merchantKind: 'general', slot: 'trader' },
    { role: 'merchant', merchantKind: 'weapons', slot: 'weapons' },
    { role: 'trainer', slot: 'trainer' },
    { role: 'guard', slot: 'guard' },
  ];
  if (companionsAllowed) required.push({ role: 'companion', slot: 'companion' });
  const covers = (n: NpcOut, req: NpcPlan) => n.role === req.role && (req.merchantKind === undefined || req.merchantKind === 'general' || (req.merchantKind === 'weapons' && (n.merchantKind === 'weapons' || n.merchantKind === 'armor')) || n.merchantKind === req.merchantKind);
  for (const req of required) if (!list.some((n) => covers(n, req))) list.push(fallbackNpc(genre, rng, req, z.name));

  const oldByName = new Map(oldResidents.map((n) => [n.name.toLowerCase(), n]));
  const usedNames = new Set(w.npcs.filter((n) => !oldResidents.includes(n)).map((n) => n.name.toLowerCase()));
  let nextIdx = 1 + Math.max(0, ...w.npcs.map((n) => Number(/_(\d+)$/.exec(n.id)?.[1] ?? 0)));
  const arche = (role: NpcRole) => (role === 'guard' ? 'guardian' : role === 'mystic' ? 'caster' : role === 'companion' ? rng.pick(['skirmisher', 'archer', 'caster', 'healer', 'guardian'] as const) : role === 'trainer' ? 'skirmisher' : 'brute');
  const fresh: NpcDef[] = list.map((o) => {
    let name = o.name;
    while (usedNames.has(name.toLowerCase())) name = `${o.name} ${rng.pick(bank.lastNames)}`;
    usedNames.add(name.toLowerCase());
    const prev = oldByName.get(name.toLowerCase());
    return {
      id: prev?.id ?? `n_${slugify(name)}_${nextIdx++}`,
      name,
      title: o.title,
      role: o.role,
      merchantKind: o.role === 'merchant' ? o.merchantKind ?? 'general' : undefined,
      zoneId: z.id,
      x: 0,
      y: 0,
      pronouns: o.pronouns ?? 'they/them',
      personality: o.personality,
      appearance: o.appearance,
      backstory: o.backstory,
      knowledge: o.knowledge ?? [],
      secrets: o.secrets ?? [],
      voice: o.voice ?? o.personality,
      greeting: o.greeting,
      barks: o.barks?.length ? o.barks : ['...'],
      level: Math.max(1, z.levelRange[0] + (o.role === 'guard' ? 3 : o.role === 'companion' ? 0 : 1)),
      archetype: arche(o.role),
      canJoinParty: companionsAllowed && (o.canJoinParty === true || o.role === 'companion'),
      essential: false,
      questIds: [],
      colors: prev?.colors ?? [rng.pick(['#7a4a3a', '#3a5a7a', '#5a7a3a', '#7a6a3a', '#6a3a6a', '#3a6a6a', '#8a8a8a']), rng.pick(['#d0b090', '#a07850', '#704830', '#e0c0a0'])],
      wanders: o.role === 'commoner' || o.role === 'guard' || o.role === 'companion',
    };
  });
  const keptIds = new Set(fresh.map((n) => n.id));
  const removed = oldResidents.filter((n) => !keptIds.has(n.id));
  const removedIds = new Set(removed.map((n) => n.id));
  w.npcs = [...w.npcs.filter((n) => !removedIds.has(n.id) && !keptIds.has(n.id)), ...fresh];
  for (const o of content.npcs) {
    const me = fresh.find((n) => n.name === o.name);
    if (me) me.relations = (o.friends ?? []).map((f) => fuzzy(f, w.npcs, (n) => n.name)?.id).filter((x): x is string => !!x && x !== me.id);
  }
  for (const n of w.npcs) if (n.relations?.some((id) => removedIds.has(id))) n.relations = n.relations.filter((id) => !removedIds.has(id));
  // Their portraits go with them.
  for (const n of removed) {
    for (const k of Object.keys(w.assets)) if (k === `spr_npc_${n.id}` || k.startsWith(`spr_npc_${n.id}@`)) delete w.assets[k];
    if (w.artOverrides) for (const k of Object.keys(w.artOverrides)) if (k === `spr_npc_${n.id}`) delete w.artOverrides[k];
  }

  // 3. Quests elsewhere that needed someone who left go to whoever does the same job now.
  const stand = (old: NpcDef) => fresh.find((n) => n.role === old.role && n.merchantKind === old.merchantKind) ?? fresh.find((n) => n.role === old.role) ?? fresh[0]!;
  const byId = new Map(removed.map((n) => [n.id, n]));
  for (const q of w.quests) {
    const swaps = new Map<string, NpcDef>();
    const sub = (id: string | undefined) => {
      const old = id ? byId.get(id) : undefined;
      if (!old) return id;
      const n = stand(old);
      swaps.set(old.name, n);
      return n.id;
    };
    q.giverNpcId = sub(q.giverNpcId);
    q.turnInNpcId = sub(q.turnInNpcId);
    for (const o of q.objectives) o.npcId = sub(o.npcId);
    for (const [from, n] of swaps) swapInQuest(q, from, n.name);
    if (q.giverNpcId && swaps.size) {
      const g = w.npcs.find((n) => n.id === q.giverNpcId);
      if (g && !g.questIds.includes(q.id)) g.questIds.push(q.id);
    }
  }

  // 4. Buildings: one per shopkeeper or host, plus two homes; every interior is built anew.
  const oldInteriors = new Set(w.zones.filter((i) => i.parentZoneId === z.id).map((i) => i.id));
  w.zones = w.zones.filter((i) => !oldInteriors.has(i.id));
  z.features = z.features.filter((f) => f.kind !== 'door');
  const townNpcs = [...story, ...fresh];
  for (const n of townNpcs) n.zoneId = z.id;
  const indoor = townNpcs.filter((n) => INDOOR_ROLES.includes(n.role));
  const outdoor = townNpcs.filter((n) => !indoor.includes(n));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const buildingNames = [...content.buildings];
  const purposeFor = (n: NpcDef) => (n.role === 'innkeeper' ? 'inn' : n.role === 'merchant' ? `${n.merchantKind} shop` : n.role === 'trainer' ? 'training hall' : n.role === 'crafter' ? 'workshop' : 'house');
  const nameFor = (n: NpcDef, purpose: string) => {
    const match = buildingNames.findIndex((b) => norm(b.purpose).split(' ').some((x) => x.length > 2 && norm(purpose).includes(x)) || norm(b.name).includes(norm(n.name.split(' ')[0]!)));
    if (match >= 0) return buildingNames.splice(match, 1)[0]!.name;
    const last = n.name.split(' ').slice(-1)[0];
    return n.role === 'innkeeper' ? `The ${rng.pick(['Gilded', 'Weary', 'Laughing', 'Crooked', 'Lucky', 'Sleeping'])} ${rng.pick(['Lantern', 'Goose', 'Kettle', 'Stag', 'Anchor', 'Moon'])}` : `${last}'s ${purpose.replace(/^\w+ shop$/, 'Shop').replace(/\b\w/g, (c) => c.toUpperCase())}`;
  };
  const assignments = indoor.map((n) => ({ npcs: [n], purpose: purposeFor(n), name: '' }));
  assignments.forEach((a) => (a.name = nameFor(a.npcs[0]!, a.purpose)));
  for (let i = 0; i < 2; i++) assignments.push({ npcs: [], purpose: 'house', name: buildingNames.shift()?.name ?? `${rng.pick(bank.lastNames)} House` });
  const inn = assignments.find((a) => a.purpose === 'inn');
  for (const c of outdoor.filter((n) => n.role === 'companion')) if (inn && rng.chance(0.6)) {
    inn.npcs.push(c);
    outdoor.splice(outdoor.indexOf(c), 1);
  }
  const inTs = w.tilesets[`${z.tilesetId}_in`] ? `${z.tilesetId}_in` : (w.zones.find((i) => oldInteriors.has(i.id))?.tilesetId ?? `${z.tilesetId}_in`);
  const interiors: ZoneDef[] = assignments.map((asg, bi) => {
    const interiorId = `${z.id}_b${bi}`;
    const ilay = generateInterior(rng.fork(interiorId), asg.purpose);
    const doorId = `${z.id}_door${bi}`;
    const innerDoorId = `${interiorId}_door`;
    z.features.push({ id: doorId, kind: 'door', x: 0, y: 0, targetZoneId: interiorId, targetFeatureId: innerDoorId, name: asg.name });
    const inDoor = ilay.internalExitSpots[0]!;
    const iz: ZoneDef = {
      id: interiorId,
      name: asg.name,
      kind: 'interior',
      description: `${asg.name}, in ${z.name}.`,
      regionIndex: z.regionIndex,
      levelRange: z.levelRange,
      tilesetId: inTs,
      width: ilay.map.w,
      height: ilay.map.h,
      ground: '',
      objects: '',
      features: [{ id: innerDoorId, kind: 'door', x: inDoor.x, y: inDoor.y, targetZoneId: z.id, targetFeatureId: doorId, name: `Exit to ${z.name}` }, ...ilay.map.features.map((f) => ({ ...f, id: `${interiorId}_${f.id}` }))],
      spawns: [],
      parentZoneId: z.id,
      mapPos: z.mapPos,
      links: [z.id],
      entry: ilay.entry,
      buildingPurpose: asg.purpose,
      familyIds: [],
    };
    ilay.map.features = [];
    asg.npcs.forEach((n, ni) => {
      const spot = ilay.npcSpots[ni] ?? ilay.entry;
      Object.assign(n, { zoneId: interiorId, x: spot.x, y: spot.y, wanders: n.role === 'companion' });
    });
    if (asg.purpose === 'house' && rng.chance(0.5)) {
      const cs = ilay.chestSpots[0];
      if (cs) iz.features.push({ id: `${interiorId}_chest`, kind: 'chest', x: cs.x, y: cs.y, lootTier: z.levelRange[0], lockLevel: systems.lockpicking && rng.chance(0.5) ? z.levelRange[0] : undefined, name: w.tilesets[inTs]?.roles.chest.name ?? 'Chest' });
    }
    for (const f of iz.features) ilay.map.setO(f.x, f.y, 0);
    const enc = ilay.map.encode();
    Object.assign(iz, { ground: enc.ground, objects: enc.objects, variation: enc.variation });
    return iz;
  });
  // Interiors sit right after their town, as at assembly.
  const at = w.zones.indexOf(z) + 1;
  w.zones.splice(at, 0, ...interiors);

  // 5. Side quests from the new residents.
  const families = w.families;
  const nearby = z.links.map((id) => w.zones.find((x) => x.id === id)).filter((x): x is ZoneDef => !!x);
  const hunting = nearby.filter((x) => x.kind !== 'town');
  const famOf = (zz?: ZoneDef) => (zz ? families.find((f) => zz.familyIds.includes(f.id)) : undefined);
  const familyByHint = (hint?: string, zz?: ZoneDef) => fuzzy(hint, families, (f) => f.name) ?? fuzzy(hint, families.flatMap((f) => f.members.map((m) => ({ f, m }))), (x) => x.m.name)?.f ?? famOf(zz);
  const healPotion = r.items.find((i) => i.category === 'potion' && i.use?.effects.some((e) => e.kind === 'heal'))?.id;
  const gen = Math.max(0, ...[...w.quests, ...oldSide].map((q) => Number(new RegExp(`^q_side_${z.id.slice(2)}_r(\\d+)_`).exec(q.id)?.[1] ?? 0))) + 1;
  const tag = `${z.id.slice(2)}_r${gen}`;
  const placeItem = (uid: string, host?: ZoneDef) => {
    const chest = host?.features.filter((f) => f.kind === 'chest').sort((a, b) => (b.lootTier ?? 0) - (a.lootTier ?? 0))[0];
    const spot = !chest && host ? freeTileIn(host, rng) : null;
    if (chest) chest.items = [...(chest.items ?? []), uid];
    else if (host && spot) host.features.push({ id: `${host.id}_qchest_${uid}`, kind: 'chest', x: spot.x, y: spot.y, lootTier: host.levelRange[1], items: [uid], name: w.tilesets[host.tilesetId]?.roles.chest.name ?? 'Chest' });
    // Nowhere out there: it waits in a chest in town (placed with the new map).
    else z.features.push({ id: `${z.id}_qchest_${uid}`, kind: 'chest', x: 0, y: 0, lootTier: z.levelRange[1], items: [uid], name: w.tilesets[z.tilesetId]?.roles.chest.name ?? 'Chest' });
  };
  const newQuests: string[] = [];
  const allZones = w.zones.filter((x) => x.kind !== 'interior');
  content.sideQuests.slice(0, size.sideQuestsPerTown[1]).forEach((sq, i) => {
    const id = `q_side_${tag}_${i}`;
    const giver = fuzzy(sq.giverName, townNpcs, (n) => n.name) ?? fuzzy(sq.giverName, w.npcs, (n) => n.name) ?? townNpcs[(i * 3 + 2) % townNpcs.length]!;
    const objectives: QuestObjective[] = [];
    const grants: string[] = [];
    let lastItem: string | undefined;
    sq.objectives.forEach((o, oi) => {
      const base = { id: `o${oi}`, description: o.description, hidden: oi > 0 };
      if (o.type === 'talk' || o.type === 'persuade') {
        const npc = fuzzy(o.target ?? o.description, w.npcs, (n) => n.name);
        if (npc) objectives.push({ ...base, type: o.type, npcId: npc.id });
      } else if (o.type === 'kill' || o.type === 'kill_unique') {
        const host = hunting[i % Math.max(1, hunting.length)];
        const fam = familyByHint(o.target ?? o.description, host) ?? families[0];
        if (fam) objectives.push({ ...base, type: 'kill', familyId: fam.id, count: Math.min(8, o.count ?? 4) });
      } else if (o.type === 'collect') {
        const uid = `u_side_${tag}_${i}_${oi}`;
        const nm = (o.target ?? o.description).replace(/^(find|collect|recover|retrieve|get)\s+(the\s+)?/i, '').slice(0, 48);
        w.uniqueItems[uid] = { id: uid, baseId: 'quest_item', name: nm.charAt(0).toUpperCase() + nm.slice(1), description: o.description, rarityId: r.rarities[2]!.id, mods: [], questItem: true };
        placeItem(uid, hunting[(i + oi) % Math.max(1, hunting.length)]);
        objectives.push({ ...base, type: 'collect', itemUniqueId: uid, count: 1 });
        lastItem = uid;
      } else if (o.type === 'deliver') {
        const npc = fuzzy(o.target ?? o.description, w.npcs, (n) => n.name) ?? giver;
        let item = lastItem;
        if (!item) {
          item = `u_side_${tag}_${i}_pkg`;
          w.uniqueItems[item] = { id: item, baseId: 'quest_item', name: `Parcel for ${npc.name}`, description: `A wrapped parcel ${giver.name} asked you to deliver.`, rarityId: r.rarities[1]!.id, mods: [], questItem: true };
          grants.push(item);
        }
        objectives.push({ ...base, type: 'deliver', itemUniqueId: item, npcId: npc.id, count: 1 });
      } else if (o.type === 'reach') {
        const zz = fuzzy(o.target ?? o.description, allZones, (x) => x.name) ?? hunting[0];
        if (zz) objectives.push({ ...base, type: 'reach', zoneId: zz.id });
      } else if (o.type === 'interact') {
        const zz = fuzzy(o.target ?? o.description, allZones, (x) => x.name) ?? hunting[0] ?? z;
        const fid = `fx_${id}_${oi}`;
        // In town it is placed with the new map; elsewhere on an open tile of that place's own map.
        const spot = zz.id === z.id ? { x: 0, y: 0 } : freeTileIn(zz, rng);
        const host = spot ? zz : z;
        host.features.push({ id: fid, kind: 'shrine', x: spot?.x ?? 0, y: spot?.y ?? 0, shrineEffect: 'restore', name: (o.target ?? o.description).slice(0, 48).replace(/^\w/, (c) => c.toUpperCase()) });
        objectives.push({ ...base, type: 'interact', featureId: fid, zoneId: host.id });
      } else if (o.type === 'disarm' && systems.traps) objectives.push({ ...base, type: 'disarm', count: o.count ?? 2 });
      else if (o.type === 'craft' && systems.crafting) objectives.push({ ...base, type: 'craft', count: o.count ?? 1 });
    });
    if (!objectives.length) return;
    const last = objectives[objectives.length - 1]!;
    if (!((last.type === 'talk' || last.type === 'deliver') && last.npcId === giver.id)) objectives.push({ id: `o${objectives.length}`, type: 'talk', npcId: giver.id, description: `Return to ${giver.name}`, hidden: true });
    const q: QuestDef = {
      id,
      title: sq.title,
      summary: sq.summary,
      main: false,
      level: Math.max(1, hunting[0]?.levelRange[0] ?? z.levelRange[0]),
      giverNpcId: giver.id,
      turnInNpcId: giver.id,
      zoneId: z.id,
      objectives,
      rewards: { xp: 0, gold: 0, items: rng.chance(0.6) ? [`slot:${rng.pick(['weapon', 'armor', 'armor', 'accessory'])}:${rng.chance(0.3) ? 2 : 1}`] : healPotion ? [`base:${healPotion}:0`] : [] },
      prerequisites: [],
      completionText: sq.completionText,
      grantsOnStart: grants.length ? grants : undefined,
    };
    questRewards(r, q);
    w.quests.push(q);
    giver.questIds.push(id);
    newQuests.push(sq.title);
  });

  // 6. The sign at the entrance.
  const sign = z.features.find((f) => f.kind === 'sign');
  if (sign && content.signText) sign.text = content.signText;
  w.updatedAt = Date.now();
  return { added: fresh.filter((n) => !oldResidents.some((o) => o.id === n.id)).map((n) => n.name), removed: removed.map((n) => n.name), quests: newQuests };
}

/** Replace a wild's or dungeon's lore notes and shrine name (positions are set by the next rebuildZoneMap). */
export function spliceAreaContent(w: WorldDefinition, zoneId: string, content: AreaContentOut): ContentResult {
  const z = outerZone(w, zoneId);
  if (z.kind === 'town') throw new Error('Towns get residents, not area content.');
  const oldLore = z.features.filter((f) => f.kind === 'lore');
  const oldIds = new Set(oldLore.map((f) => f.loreId));
  w.lore = w.lore.filter((l) => !oldIds.has(l.id));
  z.features = z.features.filter((f) => f.kind !== 'lore');
  let n = 1 + Math.max(0, ...w.lore.map((l) => Number(/^l(\d+)$/.exec(l.id)?.[1] ?? 0)), ...[...oldIds].map((id) => Number(/^l(\d+)$/.exec(id ?? '')?.[1] ?? 0)));
  for (const note of content.loreNotes) {
    const lid = `l${n++}`;
    w.lore.push({ id: lid, title: note.title, text: note.text });
    z.features.push({ id: `${z.id}_lore${lid.slice(1)}`, kind: 'lore', x: 0, y: 0, loreId: lid, name: note.title });
  }
  const shrine = z.features.find((f) => f.kind === 'shrine' && !f.id.includes('fx_'));
  if (shrine && content.shrineName) shrine.name = content.shrineName;
  w.updatedAt = Date.now();
  return { added: content.loreNotes.map((l) => l.title), removed: oldLore.map((f) => f.name ?? ''), quests: [] };
}
