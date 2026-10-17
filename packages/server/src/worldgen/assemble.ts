/** Turns all generated pieces into a validated, fully linked WorldDefinition. */
import {
  MONSTER_ARCHETYPES, Rng, SIZE_PROFILES, slugify,
  type BossDef, type LoreNote, type MonsterArchetype, type MonsterFamily, type NpcDef, type NpcRole, type QuestDef, type QuestObjective,
  type Ruleset, type TilesetDef, type UniqueItemDef, type Vec2, type WorldDefinition, type WorldInput, type ZoneDef, type ArcDef,
} from '@gd/shared';
import { bindWorld, resolveElement, uniqueBase } from '../rules/bind';
import { buildPack } from '../rules/encounters';
import type { RulesetIntent } from '../rules/intent';
import { BANKS, fallbackTileset, type Genre } from './genres';
import { fallbackNpc, tilesetFromOut } from './fallbacks';
import { generateDungeon, generateInterior, generateTown, generateWilderness, type EdgeDir, type LayoutResult } from './layout';
import { normColor, normColors, type AreaContentOut, type AtlasOut, type ConceptOut, type FamiliesOut, type NpcOut, type StoryOut, type TownContentOut } from './schemas';
import type { WorldSkeleton, ZoneSlot } from './structure';

export interface Draft {
  id: string;
  input: WorldInput;
  seed: string;
  genre: Genre;
  skeleton: WorldSkeleton;
  concept: ConceptOut;
  atlas: AtlasOut;
  story: StoryOut;
  ruleset: Ruleset;
  rulesIntent: RulesetIntent;
  families: FamiliesOut;
  towns: Record<string, TownContentOut>;
  areas: Record<string, AreaContentOut>;
  log: string[];
}

const zid = (slot: string) => `z_${slot}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Best fuzzy match of a free-text reference against named things. */
function fuzzy<T>(ref: string | undefined, items: T[], name: (t: T) => string): T | undefined {
  if (!ref) return undefined;
  const r = norm(ref);
  if (!r) return undefined;
  let best: T | undefined;
  let bestScore = 0;
  const rw = new Set(r.split(' ').filter((w) => w.length > 2));
  for (const it of items) {
    const n = norm(name(it));
    if (!n) continue;
    let score = 0;
    if (n === r) score = 100;
    else if (n.includes(r) || r.includes(n)) score = 50 + Math.min(n.length, r.length);
    else {
      const nw = n.split(' ').filter((w) => w.length > 2);
      score = nw.filter((w) => rw.has(w) || [...rw].some((x) => x.startsWith(w) || w.startsWith(x))).length * 10;
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return bestScore >= 10 ? best : undefined;
}

const EDGE_VEC: Record<EdgeDir, Vec2> = { e: { x: 1, y: 0 }, w: { x: -1, y: 0 }, s: { x: 0, y: 1 }, n: { x: 0, y: -1 } };

/** Assign each non-dungeon neighbor an edge direction based on map positions. */
function assignEdges(slot: ZoneSlot, neighbors: ZoneSlot[]): Map<string, EdgeDir> {
  const out = new Map<string, EdgeDir>();
  const used = new Set<EdgeDir>();
  const sorted = neighbors.map((n) => ({ n, dx: n.mapPos.x - slot.mapPos.x, dy: n.mapPos.y - slot.mapPos.y }));
  for (const { n, dx, dy } of sorted) {
    const prefs = (Object.keys(EDGE_VEC) as EdgeDir[]).sort((a, b) => EDGE_VEC[b].x * dx + EDGE_VEC[b].y * dy - (EDGE_VEC[a].x * dx + EDGE_VEC[a].y * dy));
    const dir = prefs.find((d) => !used.has(d)) ?? prefs[0]!;
    used.add(dir);
    out.set(n.slotId, dir);
  }
  return out;
}

export function assembleWorld(d: Draft, owner: { id: string; name: string }): WorldDefinition {
  const rng = new Rng(`${d.seed}:assemble`);
  const bank = BANKS[d.genre];
  const sk = d.skeleton;
  const r = d.ruleset;
  const systems = { traps: r.systems.traps, lockpicking: r.systems.locks, crafting: r.crafting.enabled };
  const size = SIZE_PROFILES[d.input.size];
  const zoneInfo = (slot: string) => d.atlas.zones.find((z) => z.slotId === slot);
  const slotById = new Map(sk.slots.map((s) => [s.slotId, s]));

  // ------------------------------------------------------------------ families
  const families: MonsterFamily[] = d.families.families.map((f, i) => {
    const members = f.members.filter((m, j, arr) => arr.findIndex((x) => x.archetype === m.archetype) === j);
    // Every family needs at least a melee and a ranged option for interesting fights.
    if (!members.some((m) => r.monsters[m.archetype].range < 2)) members.push({ archetype: 'skirmisher', name: `${f.name} Warrior`, description: '', appearance: `${f.name} warrior` });
    if (!members.some((m) => r.monsters[m.archetype].range >= 2)) members.push({ archetype: 'archer', name: `${f.name} Hunter`, description: '', appearance: `${f.name} hunter` });
    const colors = normColors(f.colors);
    return { id: `f${i}_${slugify(f.name)}`, name: f.name, description: f.description, element: resolveElement(r, f.element, i), habitat: f.habitat, colors: colors.length ? colors : ['#6a6a6a', '#3a3a3a', '#d0c080'], members };
  });

  // ------------------------------------------------------------------ zones (definitions; layout later)
  const familyScore = (fam: MonsterFamily, slot: ZoneSlot) => {
    const zi = zoneInfo(slot.slotId);
    const words = new Set(norm(`${slot.kind} ${zi?.biome ?? ''} ${zi?.name ?? ''} ${zi?.description ?? ''}`).split(' '));
    return norm(fam.habitat).split(' ').filter((w) => words.has(w)).length + rng.next() * 0.9;
  };
  const familyUse = new Map<string, number>();
  const zoneFamilies = new Map<string, string[]>();
  for (const s of sk.slots) {
    if (s.kind === 'town') {
      zoneFamilies.set(s.slotId, []);
      continue;
    }
    const ranked = [...families].sort((a, b) => familyScore(b, s) - (familyUse.get(b.id) ?? 0) * 0.6 - (familyScore(a, s) - (familyUse.get(a.id) ?? 0) * 0.6));
    const chosen = ranked.slice(0, Math.min(2, ranked.length)).map((f) => f.id);
    chosen.forEach((id) => familyUse.set(id, (familyUse.get(id) ?? 0) + 1));
    zoneFamilies.set(s.slotId, chosen);
  }

  // ------------------------------------------------------------------ tilesets
  const tilesets: Record<string, TilesetDef> = {};
  for (const s of sk.slots) {
    const zi = zoneInfo(s.slotId)!;
    const styleFallback = (zi.biome ?? bank.styles[s.kind][0]) as TilesetDef['style'];
    const fb = fallbackTileset(`ts_${s.slotId}`, zi.name, styleFallback, s.kind, d.genre);
    if (s.kind === 'town') {
      const tc = d.towns[s.slotId];
      tilesets[fb.id] = tilesetFromOut(fb.id, tc?.tileset, fb);
      const inStyle = (tc?.interiorTileset?.style ?? bank.styles.interior[0]) as TilesetDef['style'];
      const fbIn = fallbackTileset(`ts_${s.slotId}_in`, `${zi.name} interiors`, inStyle, 'interior', d.genre);
      tilesets[fbIn.id] = tilesetFromOut(fbIn.id, tc?.interiorTileset, fbIn);
      tilesets[fbIn.id]!.outdoor = false;
      tilesets[fbIn.id]!.ambient = Math.min(0.85, Math.max(0.55, tilesets[fbIn.id]!.ambient));
    } else {
      tilesets[fb.id] = tilesetFromOut(fb.id, d.areas[s.slotId]?.tileset, fb);
    }
    const t = tilesets[fb.id]!;
    t.outdoor = s.kind !== 'dungeon';
    if (s.kind === 'dungeon') t.ambient = Math.min(0.5, t.ambient);
    else t.ambient = Math.max(0.85, t.ambient);
  }

  // ------------------------------------------------------------------ unique items, bosses, key npcs
  const uniqueItems: Record<string, UniqueItemDef> = {};
  const itemKey = new Map<string, string>();
  d.story.keyItems.forEach((it, i) => {
    const id = `u_${i}_${slugify(it.name)}`;
    const baseId = uniqueBase(r, it.kind, rng.fork(id));
    uniqueItems[id] = { id, baseId, name: it.name, description: it.description, rarityId: baseId === 'quest_item' ? r.rarities[2]!.id : r.rarities[4]!.id, mods: [], questItem: true };
    itemKey.set(it.key, id);
  });
  const dungeonSlots = sk.slots.filter((s) => s.kind === 'dungeon');
  const bosses: BossDef[] = [];
  const bossKey = new Map<string, string>();
  const bossDungeonUsed = new Set<string>();
  d.story.bosses.forEach((b, i) => {
    let slot = slotById.get(b.dungeonSlot);
    if (!slot || slot.kind !== 'dungeon' || bossDungeonUsed.has(slot.slotId)) slot = dungeonSlots.find((x) => !bossDungeonUsed.has(x.slotId)) ?? slot ?? dungeonSlots[0]!;
    bossDungeonUsed.add(slot.slotId);
    const famIds = zoneFamilies.get(slot.slotId) ?? [];
    const id = `b${i}_${slugify(b.name)}`;
    const isFinal = i === d.story.bosses.length - 1;
    bosses.push({
      id,
      name: b.name,
      title: b.title,
      description: b.description,
      familyId: famIds[0] ?? families[0]!.id,
      archetype: b.archetype,
      level: Math.min(sk.maxLevel, slot.levelRange[1] + (isFinal ? 1 : 0)),
      zoneId: zid(slot.slotId),
      appearance: b.appearance,
      drops: [],
      taunt: b.taunt,
    });
    bossKey.set(b.key, id);
  });

  const npcs: NpcDef[] = [];
  const npcKey = new Map<string, string>();
  const usedNames = new Set<string>();
  const companionsAllowed = d.input.combatMode === 'party_npc';
  const pickArchetype = (role: NpcRole): MonsterArchetype =>
    role === 'guard' ? 'guardian' : role === 'mystic' ? 'caster' : role === 'companion' ? rng.pick(['skirmisher', 'archer', 'caster', 'healer', 'guardian'] as MonsterArchetype[]) : role === 'trainer' ? 'skirmisher' : 'brute';
  const makeNpc = (o: NpcOut & { secret?: string }, zoneSlot: string, idx: number, extra?: Partial<NpcDef>): NpcDef => {
    let name = o.name;
    while (usedNames.has(name.toLowerCase())) name = `${o.name} ${rng.pick(bank.lastNames)}`;
    usedNames.add(name.toLowerCase());
    const slot = slotById.get(zoneSlot)!;
    const role = o.role;
    return {
      id: `n_${slugify(name)}_${idx}`,
      name,
      title: o.title,
      role,
      merchantKind: role === 'merchant' ? o.merchantKind ?? 'general' : undefined,
      zoneId: zid(zoneSlot),
      x: 0,
      y: 0,
      pronouns: o.pronouns ?? 'they/them',
      personality: o.personality,
      appearance: o.appearance,
      backstory: o.backstory,
      knowledge: o.knowledge ?? [],
      secrets: [...(o.secrets ?? []), ...(o.secret ? [o.secret] : [])],
      voice: o.voice ?? o.personality,
      greeting: o.greeting,
      barks: o.barks?.length ? o.barks : ['...'],
      level: Math.max(1, slot.levelRange[0] + (role === 'guard' ? 3 : role === 'companion' ? 0 : 1)),
      archetype: pickArchetype(role),
      canJoinParty: companionsAllowed && (o.canJoinParty === true || role === 'companion'),
      essential: false,
      questIds: [],
      colors: [rng.pick(['#7a4a3a', '#3a5a7a', '#5a7a3a', '#7a6a3a', '#6a3a6a', '#3a6a6a', '#8a8a8a']), rng.pick(['#d0b090', '#a07850', '#704830', '#e0c0a0'])],
      wanders: role === 'commoner' || role === 'guard' || role === 'companion',
      ...extra,
    };
  };
  d.story.keyNpcs.forEach((k, i) => {
    const slot = slotById.get(k.townSlot)?.kind === 'town' ? k.townSlot : sk.startSlot;
    const n = makeNpc(
      { name: k.name, title: k.title, role: k.role, pronouns: k.pronouns, personality: k.personality, appearance: k.appearance, backstory: k.backstory, knowledge: [], secrets: [], greeting: `${k.name} regards you carefully.`, barks: [], secret: k.secret },
      slot,
      i,
      { essential: true },
    );
    n.greeting = '';
    npcs.push(n);
    npcKey.set(k.key, n.id);
  });

  // Town residents.
  const townSlots = sk.slots.filter((s) => s.kind === 'town');
  for (const t of townSlots) {
    const content = d.towns[t.slotId];
    const residents = content?.npcs ?? [];
    const required: { role: NpcRole; merchantKind?: NpcOut['merchantKind']; title: string }[] = [
      { role: 'innkeeper', title: 'Innkeeper' },
      { role: 'merchant', merchantKind: 'general', title: 'Trader' },
      { role: 'merchant', merchantKind: 'weapons', title: 'Smith' },
      { role: 'trainer', title: 'Trainer' },
      { role: 'guard', title: 'Guard' },
    ];
    if (companionsAllowed) required.push({ role: 'companion', title: 'Wandering Adventurer' });
    const list = [...residents];
    for (const req of required) {
      const has = list.some((n) => n.role === req.role && (!req.merchantKind || n.merchantKind === req.merchantKind || req.merchantKind === 'general'));
      if (!has) list.push(fallbackNpc(bank, rng, req, zoneInfo(t.slotId)!.name));
    }
    list.forEach((o, i) => npcs.push(makeNpc(o, t.slotId, 100 + npcs.length + i)));
  }
  // Relations: friends by name + same town.
  for (const t of townSlots) {
    const content = d.towns[t.slotId];
    for (const o of content?.npcs ?? []) {
      const me = npcs.find((n) => n.name === o.name && n.zoneId === zid(t.slotId));
      if (!me) continue;
      me.relations = (o.friends ?? []).map((f) => fuzzy(f, npcs, (n) => n.name)?.id).filter((x): x is string => !!x && x !== me.id);
    }
  }
  // ------------------------------------------------------------------ quests
  const quests: QuestDef[] = [];
  const arcs: ArcDef[] = [];
  const itemPlacements: { uniqueId: string; zoneId?: string; bossId?: string; npcId?: string }[] = [];
  const interactFeatures: { zoneId: string; featureId: string; name: string }[] = [];
  const familyByHint = (hint?: string, zoneSlot?: string) =>
    fuzzy(hint, families, (f) => f.name) ?? fuzzy(hint, families.flatMap((f) => f.members.map((m) => ({ f, m }))), (x) => x.m.name)?.f ?? (zoneSlot ? families.find((f) => zoneFamilies.get(zoneSlot)?.includes(f.id)) : undefined);
  const firstFamilyNear = (regionIndex: number) => {
    const s = sk.slots.find((x) => x.regionIndex === regionIndex && x.kind === 'wilderness') ?? sk.slots.find((x) => x.kind === 'wilderness');
    return s ? families.find((f) => zoneFamilies.get(s.slotId)?.includes(f.id)) : families[0];
  };
  const zoneLevel = (zoneId: string) => slotById.get(zoneId.slice(2))?.levelRange[1] ?? 1;

  let prevMain: QuestDef | null = null;
  d.story.arcs.slice(0, sk.arcs).forEach((arc, a) => {
    const regionIndex = Math.min(sk.regions.length - 1, Math.floor((a * sk.regions.length) / Math.max(1, sk.arcs)));
    const arcDef: ArcDef = { index: a, title: arc.title, summary: arc.summary, revelation: arc.revelation, questIds: [], regionIndex };
    arc.quests.forEach((q, qi) => {
      const id = `q_main_${a}_${qi}`;
      const giverId = npcKey.get(q.giverKey) ?? fuzzy(q.giverKey, npcs.filter((n) => n.essential), (n) => n.name)?.id ?? npcs.find((n) => n.essential)?.id;
      const objectives: QuestObjective[] = [];
      const grants: string[] = [];
      const collected = new Set<string>();
      let killBossInZone: { bossId: string; zoneId: string } | null = null;
      q.objectives.forEach((o, oi) => {
        const oid = `o${oi}`;
        const base = { id: oid, description: o.description, hidden: oi > 0 && a + qi > 0 && oi > 1 };
        switch (o.type) {
          case 'talk':
          case 'persuade': {
            const npc = npcKey.get(o.npcKey ?? '') ?? fuzzy(o.npcKey ?? o.description, npcs, (n) => n.name)?.id;
            if (npc) objectives.push({ ...base, type: o.type, npcId: npc });
            break;
          }
          case 'kill_unique': {
            const b = bossKey.get(o.bossKey ?? '') ?? fuzzy(o.bossKey ?? o.description, bosses, (x) => x.name)?.id;
            if (b) {
              objectives.push({ ...base, type: 'kill_unique', targetId: b });
              killBossInZone = { bossId: b, zoneId: bosses.find((x) => x.id === b)!.zoneId };
            }
            break;
          }
          case 'kill': {
            const fam = familyByHint(o.familyHint ?? o.description, o.zoneSlot) ?? firstFamilyNear(regionIndex);
            if (fam) objectives.push({ ...base, type: 'kill', familyId: fam.id, count: o.count ?? 5, zoneId: o.zoneSlot && slotById.has(o.zoneSlot) ? zid(o.zoneSlot) : undefined });
            break;
          }
          case 'collect': {
            const u = itemKey.get(o.itemKey ?? '') ?? fuzzy(o.itemKey ?? o.description, Object.values(uniqueItems), (x) => x.name)?.id;
            if (!u) break;
            objectives.push({ ...base, type: 'collect', itemUniqueId: u, count: 1 });
            collected.add(u);
            const zoneId = o.zoneSlot && slotById.has(o.zoneSlot) ? zid(o.zoneSlot) : undefined;
            if (!itemPlacements.some((p) => p.uniqueId === u)) {
              const kb = killBossInZone as { bossId: string; zoneId: string } | null;
              if (kb && (!zoneId || zoneId === kb.zoneId)) itemPlacements.push({ uniqueId: u, bossId: kb.bossId });
              else itemPlacements.push({ uniqueId: u, zoneId: zoneId ?? zid((dungeonSlots.find((s) => s.regionIndex === regionIndex) ?? dungeonSlots[0]!).slotId) });
            }
            break;
          }
          case 'deliver': {
            const u = itemKey.get(o.itemKey ?? '') ?? fuzzy(o.itemKey ?? o.description, Object.values(uniqueItems), (x) => x.name)?.id;
            const npc = npcKey.get(o.npcKey ?? '') ?? fuzzy(o.npcKey ?? o.description, npcs, (n) => n.name)?.id;
            if (!u || !npc) break;
            if (!collected.has(u) && !itemPlacements.some((p) => p.uniqueId === u)) grants.push(u);
            objectives.push({ ...base, type: 'deliver', itemUniqueId: u, npcId: npc, count: 1 });
            break;
          }
          case 'reach': {
            if (o.zoneSlot && slotById.has(o.zoneSlot)) objectives.push({ ...base, type: 'reach', zoneId: zid(o.zoneSlot) });
            break;
          }
          case 'interact': {
            const slot = o.zoneSlot && slotById.has(o.zoneSlot) ? o.zoneSlot : sk.slots.find((s) => s.regionIndex === regionIndex && s.kind !== 'town')?.slotId;
            if (!slot) break;
            const fid = `fx_${id}_${oi}`;
            interactFeatures.push({ zoneId: zid(slot), featureId: fid, name: o.description.replace(/^(activate|use|touch|light|open|inspect|examine)\s+(the\s+)?/i, '').slice(0, 48) });
            objectives.push({ ...base, type: 'interact', featureId: fid, zoneId: zid(slot) });
            break;
          }
          case 'disarm':
            if (systems.traps) objectives.push({ ...base, type: 'disarm', count: o.count ?? 2 });
            break;
          case 'craft':
            if (systems.crafting) objectives.push({ ...base, type: 'craft', count: o.count ?? 1 });
            break;
        }
      });
      // Every main quest must be completable and end with a conversation.
      if (!objectives.length) {
        const dz = dungeonSlots.find((s) => s.regionIndex === regionIndex) ?? dungeonSlots[0]!;
        objectives.push({ id: 'o0', type: 'reach', zoneId: zid(dz.slotId), description: `Investigate ${zoneInfo(dz.slotId)?.name}` });
      }
      const turnIn = npcKey.get(q.turnInKey ?? '') ?? giverId;
      const last = objectives[objectives.length - 1]!;
      if (turnIn && !((last.type === 'talk' || last.type === 'deliver' || last.type === 'persuade') && last.npcId === turnIn)) {
        objectives.push({ id: `o${objectives.length}`, type: 'talk', npcId: turnIn, description: `Return to ${npcs.find((n) => n.id === turnIn)?.name}` , hidden: true });
      }
      // Introduce a new giver if they are someone the player hasn't just spoken to.
      if (giverId && prevMain && prevMain.turnInNpcId !== giverId && !(objectives[0]!.type === 'talk' && objectives[0]!.npcId === giverId)) {
        objectives.unshift({ id: 'o_intro', type: 'talk', npcId: giverId, description: `Speak with ${npcs.find((n) => n.id === giverId)?.name}` });
      }
      objectives.forEach((o, i) => (o.hidden = i > 0 ? o.hidden ?? true : false));
      const levelZone = objectives.find((o) => o.zoneId)?.zoneId;
      const level = levelZone ? zoneLevel(levelZone) : sk.regions[regionIndex]!.levelRange[0];
      const isFinal = a === sk.arcs - 1 && qi === arc.quests.length - 1;
      const quest: QuestDef = {
        id,
        title: q.title,
        summary: q.summary,
        main: true,
        arcIndex: a,
        level,
        giverNpcId: giverId,
        turnInNpcId: turnIn,
        objectives,
        rewards: { xp: 0, gold: 0, items: isFinal ? [] : [`slot:${rng.pick(['weapon', 'armor', 'accessory'])}:${qi === arc.quests.length - 1 ? 3 : 2}`] },
        prerequisites: prevMain ? [prevMain.id] : [],
        autoStart: true,
        completionText: q.completionText,
        grantsOnStart: grants.length ? grants : undefined,
      };
      quests.push(quest);
      arcDef.questIds.push(id);
      prevMain = quest;
      if (giverId) npcs.find((n) => n.id === giverId)?.questIds.push(id);
    });
    arcs.push(arcDef);
  });
  const finalQuestId = prevMain ? (prevMain as QuestDef).id : '';

  // Side quests per town.
  const healPotion = r.items.find((i) => i.category === 'potion' && i.use?.effects.some((e) => e.kind === 'heal'))?.id;
  for (const t of townSlots) {
    const content = d.towns[t.slotId];
    const townNpcs = npcs.filter((n) => n.zoneId === zid(t.slotId));
    const nearby = t.links.map((l) => slotById.get(l)!).filter(Boolean);
    const nearbyHunting = nearby.filter((s) => s.kind !== 'town');
    (content?.sideQuests ?? []).slice(0, size.sideQuestsPerTown[1]).forEach((sq, i) => {
      const id = `q_side_${t.slotId}_${i}`;
      const giver = fuzzy(sq.giverName, townNpcs, (n) => n.name) ?? fuzzy(sq.giverName, npcs, (n) => n.name) ?? townNpcs[(i * 3 + 2) % townNpcs.length]!;
      const objectives: QuestObjective[] = [];
      const grants: string[] = [];
      let lastItem: string | undefined;
      sq.objectives.forEach((o, oi) => {
        const base = { id: `o${oi}`, description: o.description, hidden: oi > 0 };
        if (o.type === 'talk' || o.type === 'persuade') {
          const npc = fuzzy(o.target ?? o.description, npcs, (n) => n.name);
          if (npc) objectives.push({ ...base, type: o.type, npcId: npc.id });
        } else if (o.type === 'kill' || o.type === 'kill_unique') {
          const host = nearbyHunting[i % Math.max(1, nearbyHunting.length)];
          const fam = familyByHint(o.target ?? o.description, host?.slotId) ?? (host ? families.find((f) => zoneFamilies.get(host.slotId)?.includes(f.id)) : families[0]);
          if (fam) objectives.push({ ...base, type: 'kill', familyId: fam.id, count: Math.min(8, o.count ?? 4) });
        } else if (o.type === 'collect') {
          const uid = `u_side_${t.slotId}_${i}_${oi}`;
          const nm = (o.target ?? o.description).replace(/^(find|collect|recover|retrieve|get)\s+(the\s+)?/i, '').slice(0, 48);
          uniqueItems[uid] = { id: uid, baseId: 'quest_item', name: nm.charAt(0).toUpperCase() + nm.slice(1), description: o.description, rarityId: r.rarities[2]!.id, mods: [], questItem: true };
          const host = nearbyHunting[(i + oi) % Math.max(1, nearbyHunting.length)] ?? nearby[0];
          itemPlacements.push({ uniqueId: uid, zoneId: host ? zid(host.slotId) : zid(t.slotId) });
          objectives.push({ ...base, type: 'collect', itemUniqueId: uid, count: 1 });
          lastItem = uid;
        } else if (o.type === 'deliver') {
          const npc = fuzzy(o.target ?? o.description, npcs, (n) => n.name) ?? giver;
          let item = lastItem;
          if (!item) {
            item = `u_side_${t.slotId}_${i}_pkg`;
            uniqueItems[item] = { id: item, baseId: 'quest_item', name: `Parcel for ${npc.name}`, description: `A wrapped parcel ${giver.name} asked you to deliver.`, rarityId: r.rarities[1]!.id, mods: [], questItem: true };
            grants.push(item);
          }
          objectives.push({ ...base, type: 'deliver', itemUniqueId: item, npcId: npc.id, count: 1 });
        } else if (o.type === 'reach') {
          const z = fuzzy(o.target ?? o.description, sk.slots, (s) => zoneInfo(s.slotId)?.name ?? '') ?? nearbyHunting[0];
          if (z) objectives.push({ ...base, type: 'reach', zoneId: zid(z.slotId) });
        } else if (o.type === 'interact') {
          const z = fuzzy(o.target ?? o.description, sk.slots, (s) => zoneInfo(s.slotId)?.name ?? '') ?? nearbyHunting[0] ?? t;
          const fid = `fx_${id}_${oi}`;
          interactFeatures.push({ zoneId: zid(z.slotId), featureId: fid, name: (o.target ?? o.description).slice(0, 48) });
          objectives.push({ ...base, type: 'interact', featureId: fid, zoneId: zid(z.slotId) });
        } else if (o.type === 'disarm' && systems.traps) objectives.push({ ...base, type: 'disarm', count: o.count ?? 2 });
        else if (o.type === 'craft' && systems.crafting) objectives.push({ ...base, type: 'craft', count: o.count ?? 1 });
      });
      if (!objectives.length) return;
      const last = objectives[objectives.length - 1]!;
      if (!((last.type === 'talk' || last.type === 'deliver') && last.npcId === giver.id))
        objectives.push({ id: `o${objectives.length}`, type: 'talk', npcId: giver.id, description: `Return to ${giver.name}`, hidden: true });
      const level = Math.max(1, (nearbyHunting[0]?.levelRange[0] ?? t.levelRange[0]));
      quests.push({
        id,
        title: sq.title,
        summary: sq.summary,
        main: false,
        level,
        giverNpcId: giver.id,
        turnInNpcId: giver.id,
        zoneId: zid(t.slotId),
        objectives,
        rewards: { xp: 0, gold: 0, items: rng.chance(0.6) ? [`slot:${rng.pick(['weapon', 'armor', 'armor', 'accessory'])}:${rng.chance(0.3) ? 2 : 1}`] : healPotion ? [`base:${healPotion}:0`] : [] },
        prerequisites: [],
        completionText: sq.completionText,
        grantsOnStart: grants.length ? grants : undefined,
      });
      giver.questIds.push(id);
    });
  }

  // ------------------------------------------------------------------ layouts
  const zones: ZoneDef[] = [];
  const layouts = new Map<string, LayoutResult>();
  const lore: LoreNote[] = [];
  const featureId = (zoneId: string, kind: string, n: number) => `${zoneId}_${kind}${n}`;
  const nonDungeonNeighbors = (s: ZoneSlot) => s.links.map((l) => slotById.get(l)!).filter((x) => x && x.kind !== 'dungeon' && s.kind !== 'dungeon');
  const edgeMaps = new Map<string, Map<string, EdgeDir>>();
  for (const s of sk.slots) if (s.kind !== 'dungeon') edgeMaps.set(s.slotId, assignEdges(s, nonDungeonNeighbors(s)));
  const sizeBoost = d.input.size === 'huge' ? 8 : d.input.size === 'large' ? 4 : 0;

  for (const s of sk.slots) {
    const zi = zoneInfo(s.slotId)!;
    const zrng = rng.fork(s.slotId);
    const tileset = tilesets[`ts_${s.slotId}`]!;
    const id = zid(s.slotId);
    let lay: LayoutResult;
    const edges = edgeMaps.get(s.slotId);
    if (s.kind === 'town') {
      const indoorRoles = npcs.filter((n) => n.zoneId === id && ['merchant', 'innkeeper', 'trainer', 'crafter', 'mystic', 'noble'].includes(n.role)).length;
      lay = generateTown(zrng, { size: 50 + sizeBoost, buildingCount: indoorRoles + 2, edges: [...(edges?.values() ?? [])], outdoor: tileset.style !== 'metal' });
    } else if (s.kind === 'wilderness') {
      const dungeonsHere = s.links.filter((l) => slotById.get(l)?.kind === 'dungeon').length;
      lay = generateWilderness(zrng, { size: 62 + sizeBoost, edges: [...(edges?.values() ?? [])], internalExits: dungeonsHere, style: tileset.style });
    } else {
      lay = generateDungeon(zrng, { size: 54 + sizeBoost, caves: tileset.style === 'dirt' || tileset.style === 'crystal' || tileset.style === 'flesh' });
    }
    layouts.set(id, lay);
    zones.push({
      id,
      name: zi.name,
      kind: s.kind,
      description: zi.description,
      regionIndex: s.regionIndex,
      levelRange: s.levelRange,
      tilesetId: tileset.id,
      width: lay.map.w,
      height: lay.map.h,
      ground: '',
      objects: '',
      features: [],
      spawns: [],
      mapPos: s.mapPos,
      links: s.links.map(zid),
      entry: lay.entry,
      lore: zi.lore,
      familyIds: zoneFamilies.get(s.slotId) ?? [],
    });
  }
  const zoneById = new Map(zones.map((z) => [z.id, z]));

  // Exits between zones.
  for (const s of sk.slots) {
    const z = zoneById.get(zid(s.slotId))!;
    const lay = layouts.get(z.id)!;
    for (const linkSlot of s.links) {
      const other = slotById.get(linkSlot)!;
      const oz = zid(linkSlot);
      if (s.kind === 'dungeon') {
        // Stairs back up at the entrance.
        const fid = `${z.id}_exit_${linkSlot}`;
        const p = { x: lay.entry.x, y: lay.entry.y - 1 };
        lay.map.setG(p.x, p.y, 1);
        z.features.push({ id: fid, kind: 'exit', x: p.x, y: p.y, targetZoneId: oz, targetFeatureId: `${oz}_exit_${s.slotId}`, name: `To ${zoneInfo(linkSlot)?.name}` });
      } else if (other.kind === 'dungeon') {
        const idx = s.links.filter((l) => slotById.get(l)?.kind === 'dungeon').indexOf(linkSlot);
        const p = lay.internalExitSpots[idx] ?? lay.entry;
        z.features.push({ id: `${z.id}_exit_${linkSlot}`, kind: 'exit', x: p.x, y: p.y, targetZoneId: oz, targetFeatureId: `${oz}_exit_${s.slotId}`, name: zoneInfo(linkSlot)?.name });
      } else {
        const dir = edgeMaps.get(s.slotId)?.get(linkSlot);
        const p = dir ? lay.edgeExits[dir] : undefined;
        if (!p) continue;
        z.features.push({ id: `${z.id}_exit_${linkSlot}`, kind: 'exit', x: p.x, y: p.y, targetZoneId: oz, targetFeatureId: `${oz}_exit_${s.slotId}`, name: `To ${zoneInfo(linkSlot)?.name}`, facing: dir });
      }
    }
  }

  // Towns: buildings, interiors, NPC placement, sign, waypoint.
  for (const t of townSlots) {
    const z = zoneById.get(zid(t.slotId))!;
    const lay = layouts.get(z.id)!;
    const content = d.towns[t.slotId];
    const townNpcs = npcs.filter((n) => n.zoneId === z.id);
    const indoor = townNpcs.filter((n) => ['merchant', 'innkeeper', 'trainer', 'crafter', 'mystic', 'noble'].includes(n.role));
    const outdoor = townNpcs.filter((n) => !indoor.includes(n));
    const buildingNames = [...(content?.buildings ?? [])];
    const purposeFor = (n: NpcDef) => (n.role === 'innkeeper' ? 'inn' : n.role === 'merchant' ? `${n.merchantKind} shop` : n.role === 'trainer' ? 'training hall' : n.role === 'crafter' ? 'workshop' : 'house');
    const nameFor = (n: NpcDef, purpose: string) => {
      const match = buildingNames.findIndex((b) => norm(b.purpose).split(' ').some((w) => w.length > 2 && norm(purpose).includes(w)) || norm(b.name).includes(norm(n.name.split(' ')[0]!)));
      if (match >= 0) return buildingNames.splice(match, 1)[0]!.name;
      const last = n.name.split(' ').slice(-1)[0];
      return n.role === 'innkeeper' ? `The ${rng.pick(['Gilded', 'Weary', 'Laughing', 'Crooked', 'Lucky', 'Sleeping'])} ${rng.pick(['Lantern', 'Goose', 'Kettle', 'Stag', 'Anchor', 'Moon'])}` : `${last}'s ${purpose.replace(/^\w+ shop$/, 'Shop').replace(/\b\w/g, (c) => c.toUpperCase())}`;
    };
    const assignments: { npcs: NpcDef[]; purpose: string; name: string }[] = indoor.map((n) => {
      const purpose = purposeFor(n);
      return { npcs: [n], purpose, name: nameFor(n, purpose) };
    });
    // Remaining buildings are homes (a quest giver or two may live there).
    while (assignments.length < lay.buildings.length) assignments.push({ npcs: [], purpose: 'house', name: buildingNames.shift()?.name ?? `${rng.pick(bank.lastNames)} House` });
    // Companions often wait at the inn.
    const inn = assignments.find((a) => a.purpose === 'inn');
    for (const c of outdoor.filter((n) => n.role === 'companion')) if (inn && rng.chance(0.6)) { inn.npcs.push(c); outdoor.splice(outdoor.indexOf(c), 1); }
    lay.buildings.forEach((b, bi) => {
      const asg = assignments[bi];
      if (!asg) return;
      const interiorId = `${z.id}_b${bi}`;
      const ilay = generateInterior(rng.fork(interiorId), asg.purpose);
      const doorId = `${z.id}_door${bi}`;
      const innerDoorId = `${interiorId}_door`;
      z.features.push({ id: doorId, kind: 'door', x: b.door.x, y: b.door.y, targetZoneId: interiorId, targetFeatureId: innerDoorId, name: asg.name });
      const inDoor = ilay.internalExitSpots[0]!;
      const iz: ZoneDef = {
        id: interiorId,
        name: asg.name,
        kind: 'interior',
        description: `${asg.name}, in ${z.name}.`,
        regionIndex: z.regionIndex,
        levelRange: z.levelRange,
        tilesetId: `ts_${t.slotId}_in`,
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
        n.zoneId = interiorId;
        n.x = spot.x;
        n.y = spot.y;
        n.wanders = n.role === 'companion';
      });
      if (asg.purpose === 'house' && rng.chance(0.5)) {
        const cs = ilay.chestSpots[0];
        if (cs) iz.features.push({ id: `${interiorId}_chest`, kind: 'chest', x: cs.x, y: cs.y, lootTier: z.levelRange[0], lockLevel: systems.lockpicking && rng.chance(0.5) ? z.levelRange[0] : undefined, name: tilesets[`ts_${t.slotId}_in`]!.roles.chest.name });
      }
      layouts.set(interiorId, ilay);
      zones.push(iz);
      zoneById.set(interiorId, iz);
    });
    for (const n of indoor) if (n.zoneId === z.id) outdoor.push(n);
    outdoor.forEach((n, i) => {
      const spot = lay.npcSpots[i % lay.npcSpots.length] ?? lay.entry;
      n.x = spot.x;
      n.y = spot.y;
    });
    const plaza = lay.plaza ?? lay.entry;
    z.features.push({ id: `${z.id}_waypoint`, kind: 'waypoint', x: plaza.x + 2, y: plaza.y - 2, name: `${z.name} Waypoint` });
    lay.map.setO(plaza.x + 2, plaza.y - 2, 0);
    const signSpot = lay.map.randomFree(rng, (x, y) => Math.hypot(x - lay.entry.x, y - lay.entry.y) < 5) ?? { x: lay.entry.x + 1, y: lay.entry.y };
    z.features.push({ id: `${z.id}_sign`, kind: 'sign', x: signSpot.x, y: signSpot.y, text: content?.signText ?? `Welcome to ${z.name}.`, name: tilesets[`ts_${t.slotId}`]!.roles.sign.name });
    if (systems.crafting) {
      const cs = lay.map.randomFree(rng, (x, y) => Math.hypot(x - plaza.x, y - plaza.y) < 9);
      if (cs) z.features.push({ id: `${z.id}_craft`, kind: 'craft_station', x: cs.x, y: cs.y, name: 'Workbench' });
    }
  }

  // Wilds & dungeons: spawns, chests, traps, shrines, lore.
  let loreN = 0;
  /** Packs keep their distance so fighting one never drags in the next (aggro radius is 6.5 tiles). */
  const PACK_SPACING = 13;
  for (const s of sk.slots.filter((x) => x.kind !== 'town')) {
    const z = zoneById.get(zid(s.slotId))!;
    const lay = layouts.get(z.id)!;
    const zrng = rng.fork(`${z.id}:pop`);
    const fams = z.familyIds.map((id) => families.find((f) => f.id === id)!).filter(Boolean);
    const exitsNear = (p: Vec2, r: number) => z.features.some((f) => (f.kind === 'exit' || f.kind === 'door') && Math.hypot(f.x - p.x, f.y - p.y) < r) || Math.hypot(p.x - lay.entry.x, p.y - lay.entry.y) < r;
    let packN = 0;
    const used: Vec2[] = [];
    const bossSpots = bosses.filter((x) => x.zoneId === z.id).map(() => lay.bossSpot ?? lay.entry);
    for (const spot of lay.packSpots) {
      if (exitsNear(spot, 9) || !fams.length) continue;
      if ([...used, ...bossSpots].some((u) => Math.hypot(u.x - spot.x, u.y - spot.y) < PACK_SPACING)) continue;
      used.push(spot);
      const fam = zrng.pick(fams);
      const level = Math.max(1, Math.round(z.levelRange[0] + (z.levelRange[1] - z.levelRange[0]) * spot.depth));
      const kind = zrng.chance(0.15 + spot.depth * 0.1) ? 'elite' : 'normal';
      const pack = buildPack(r, zrng, { mode: d.input.combatMode, level, kind, roles: fam.members.map((m) => m.archetype), depth: spot.depth });
      const groupId = `${z.id}_g${packN++}`;
      pack.forEach((m, i) => {
        const p = lay.map.randomFree(zrng, (x, y) => Math.hypot(x - spot.x, y - spot.y) < 2.6 && !z.spawns.some((sp) => sp.x === x && sp.y === y)) ?? spot;
        z.spawns.push({ id: `${groupId}_${i}`, kind: 'monster', familyId: fam.id, archetype: m.role, level: m.level, x: p.x, y: p.y, groupId, elite: m.elite });
      });
    }
    // Boss
    for (const b of bosses.filter((x) => x.zoneId === z.id)) {
      const spot = lay.bossSpot ?? lay.packSpots[lay.packSpots.length - 1] ?? lay.entry;
      const groupId = `${z.id}_boss`;
      z.spawns.push({ id: `${groupId}_${b.id}`, kind: 'monster', familyId: b.familyId, archetype: b.archetype, level: b.level, x: spot.x, y: spot.y, groupId, bossId: b.id });
      const fam = families.find((f) => f.id === b.familyId) ?? families[0]!;
      const adds = buildPack(r, zrng, { mode: d.input.combatMode, level: b.level, kind: 'boss', roles: fam.members.map((m) => m.archetype) }).filter((m) => !m.boss);
      adds.forEach((m, i) => {
        const p = lay.map.randomFree(zrng, (x, y) => Math.hypot(x - spot.x, y - spot.y) < 4);
        if (p) z.spawns.push({ id: `${groupId}_m${i}`, kind: 'monster', familyId: fam.id, archetype: m.role, level: Math.max(1, b.level - 1), x: p.x, y: p.y, groupId });
      });
    }
    // Chests (quest items placed first in the deepest chests).
    const chests = [...lay.chestSpots].sort((a, b) => b.depth - a.depth);
    const placementsHere = itemPlacements.filter((p) => p.zoneId === z.id);
    chests.forEach((c, i) => {
      const items = i === 0 ? placementsHere.map((p) => p.uniqueId) : [];
      z.features.push({ id: featureId(z.id, 'chest', i), kind: 'chest', x: c.x, y: c.y, lootTier: Math.round(z.levelRange[0] + (z.levelRange[1] - z.levelRange[0]) * c.depth) + (i === 0 ? 1 : 0), lockLevel: systems.lockpicking && !items.length && zrng.chance(0.3) ? z.levelRange[1] : undefined, items: items.length ? items : undefined, name: tilesets[z.tilesetId]!.roles.chest.name });
    });
    if (!chests.length && placementsHere.length) {
      const p = lay.map.randomFree(zrng) ?? lay.entry;
      z.features.push({ id: featureId(z.id, 'chest', 99), kind: 'chest', x: p.x, y: p.y, lootTier: z.levelRange[1], items: placementsHere.map((x) => x.uniqueId), name: tilesets[z.tilesetId]!.roles.chest.name });
    }
    // Traps.
    if (systems.traps) {
      const rate = s.kind === 'dungeon' ? 0.55 : 0.3;
      lay.trapSpots.forEach((t, i) => {
        if (!zrng.chance(rate) || exitsNear(t, 5)) return;
        const trap = zrng.pick(r.traps);
        if (trap) z.features.push({ id: featureId(z.id, 'trap', i), kind: 'trap', x: t.x, y: t.y, trapKind: trap.id, trapLevel: z.levelRange[1], name: trap.name });
      });
    }
    // Shrine, lore notes, interact objectives.
    const area = d.areas[s.slotId];
    const decor = [...lay.decorSpots];
    const takeSpot = () => {
      while (decor.length) {
        const p = decor.shift()!;
        if (lay.map.free(p.x, p.y) && !z.features.some((f) => f.x === p.x && f.y === p.y)) return p;
      }
      return lay.map.randomFree(zrng);
    };
    const shrineSpot = takeSpot();
    if (shrineSpot) z.features.push({ id: featureId(z.id, 'shrine', 0), kind: 'shrine', x: shrineSpot.x, y: shrineSpot.y, shrineEffect: zrng.pick(['heal', 'restore', 'empower'] as const), name: area?.shrineName ?? tilesets[z.tilesetId]!.roles.shrine.name });
    for (const note of area?.loreNotes ?? []) {
      const p = takeSpot();
      if (!p) break;
      const lid = `l${loreN++}`;
      lore.push({ id: lid, title: note.title, text: note.text });
      z.features.push({ id: featureId(z.id, 'lore', loreN), kind: 'lore', x: p.x, y: p.y, loreId: lid, name: note.title });
    }
    if ('gate' in lay && (lay as { gate?: { gates: Vec2[]; lever: Vec2 } }).gate) {
      const g = (lay as { gate: { gates: Vec2[]; lever: Vec2 } }).gate;
      const gids = g.gates.map((t, i) => {
        const gid = featureId(z.id, 'gate', i);
        z.features.push({ id: gid, kind: 'gate', x: t.x, y: t.y, name: 'Sealed Gate' });
        return gid;
      });
      z.features.push({ id: featureId(z.id, 'lever', 0), kind: 'lever', x: g.lever.x, y: g.lever.y, gateIds: gids, name: tilesets[z.tilesetId]!.roles.lever.name });
    }
  }
  // Interact-objective features (any zone kind).
  for (const f of interactFeatures) {
    const z = zoneById.get(f.zoneId);
    const lay = z && layouts.get(z.id);
    if (!z || !lay) continue;
    const p = lay.map.randomFree(rng, (x, y) => Math.hypot(x - lay.entry.x, y - lay.entry.y) > 8) ?? lay.map.randomFree(rng) ?? lay.entry;
    z.features.push({ id: f.featureId, kind: 'shrine', x: p.x, y: p.y, shrineEffect: 'restore', name: f.name.charAt(0).toUpperCase() + f.name.slice(1) });
  }
  // Boss drops.
  for (const p of itemPlacements) if (p.bossId) bosses.find((b) => b.id === p.bossId)?.drops.push(p.uniqueId);
  // Guarantee every quest item can actually be obtained somewhere.
  const obtainable = (u: string) => bosses.some((b) => b.drops.includes(u)) || zones.some((z) => z.features.some((f) => f.items?.includes(u))) || quests.some((q) => q.grantsOnStart?.includes(u));
  for (const p of itemPlacements) {
    if (obtainable(p.uniqueId)) continue;
    const want = p.zoneId ? zoneById.get(p.zoneId) : undefined;
    const target = want && want.kind !== 'town' && want.kind !== 'interior' ? want : zones.find((z) => z.kind === 'dungeon' && z.regionIndex === (want?.regionIndex ?? 0)) ?? zones.find((z) => z.kind === 'dungeon')!;
    const chest = target.features.filter((f) => f.kind === 'chest').sort((a, b) => (b.lootTier ?? 0) - (a.lootTier ?? 0))[0];
    if (chest) chest.items = [...(chest.items ?? []), p.uniqueId];
    else {
      const lay = layouts.get(target.id)!;
      const spot = lay.map.randomFree(rng) ?? lay.entry;
      target.features.push({ id: featureId(target.id, 'chest', 98), kind: 'chest', x: spot.x, y: spot.y, lootTier: target.levelRange[1], items: [p.uniqueId], name: tilesets[target.tilesetId]!.roles.chest.name });
    }
  }
  // Final boss is essential to the ending; quest items in their drops.

  // Encode maps (after all features placed so object clearing applies).
  for (const z of zones) {
    const lay = layouts.get(z.id)!;
    for (const f of z.features) lay.map.setO(f.x, f.y, 0);
    for (const s of z.spawns) lay.map.setO(s.x, s.y, 0);
    const enc = lay.map.encode();
    z.ground = enc.ground;
    z.objects = enc.objects;
    z.variation = enc.variation;
  }

  const worldFacts = [
    ...d.concept.worldFacts,
    ...d.atlas.regions.map((r) => `${r.name}: ${r.description}`),
    ...d.concept.factions.map((f) => `${f.name}: ${f.description}`),
  ];

  const world: WorldDefinition = {
    id: d.id,
    formatVersion: 1,
    ownerId: owner.id,
    ownerName: owner.name,
    public: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'ready',
    seed: d.seed,
    input: d.input,
    concept: {
      ...d.concept,
      palette: {
        primary: normColor(d.concept.palette?.primary) ?? '#c8a24a',
        secondary: normColor(d.concept.palette?.secondary) ?? '#3a4a6a',
        accent: normColor(d.concept.palette?.accent) ?? '#e0603a',
        ui: '#1a1a22',
      },
    } as WorldDefinition['concept'],
    ruleset: r,
    rulesIntent: d.rulesIntent,
    maxLevel: sk.maxLevel,
    origins: [],
    uniqueItems,
    families,
    bosses,
    tilesets,
    zones,
    npcs,
    quests,
    arcs,
    finalQuestId,
    ending: d.story.ending,
    lore,
    assets: {},
    startZoneId: zid(sk.startSlot),
    worldFacts,
    factions: d.concept.factions.map((f, i) => ({ id: `fac${i}`, name: f.name, description: f.description })),
    generationLog: d.log,
  };
  (world.concept as { palette: WorldDefinition['concept']['palette'] }).palette.ui ??= '#1a1a22';
  delete (world.concept as { _rules?: string })._rules;
  bindWorld(world, r, d.rulesIntent.classes);
  return world;
}

export { MONSTER_ARCHETYPES };
