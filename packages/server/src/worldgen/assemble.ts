/**
 * Turns the generated text into a linked WorldDefinition: the cast, the quests, and what every place holds (its ways
 * in and out, buildings, people and things). Where things stand is decided later, when each place is painted.
 */
import {
  Rng, SIZE_PROFILES, slugify,
  type ArcDef, type BossDef, type FeatureDef, type LoreNote, type MonsterArchetype, type MonsterFamily, type NpcDef, type NpcRole,
  type QuestDef, type QuestObjective, type Ruleset, type UniqueItemDef, type WorldDefinition, type WorldInput, type ZoneDef, type ZoneLook,
} from '@gd/shared';
import { bindWorld, resolveElement, uniqueBase } from '../rules/bind';
import type { Genre } from '../rules/genre';
import type { RulesetIntent } from '../rules/intent';
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
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Best fuzzy match of a free-text reference against named things. */
export function fuzzy<T>(ref: string | undefined, items: T[], name: (t: T) => string): T | undefined {
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

/** The residents every town needs, as game functions (the town step is asked again until all are there). */
export function townRoles(companions: boolean): { role: NpcRole; merchantKind?: 'general' | 'weapons'; label: string }[] {
  return [
    { role: 'innkeeper', label: 'innkeeper' },
    { role: 'merchant', merchantKind: 'general', label: 'merchant (general goods)' },
    { role: 'merchant', merchantKind: 'weapons', label: 'merchant (weapons or armor)' },
    { role: 'trainer', label: 'trainer' },
    { role: 'guard', label: 'guard' },
    ...(companions ? [{ role: 'companion' as const, label: 'companion' }] : []),
  ];
}

/** Required roles the town's residents (and story characters living there) leave uncovered. */
export function missingRoles(residents: Pick<NpcOut, 'role' | 'merchantKind'>[], companions: boolean): string[] {
  const used = new Set<number>();
  const covers = (n: Pick<NpcOut, 'role' | 'merchantKind'>, req: ReturnType<typeof townRoles>[number]) =>
    n.role === req.role && (req.merchantKind !== 'weapons' || n.merchantKind === 'weapons' || n.merchantKind === 'armor');
  return townRoles(companions)
    .filter((req) => {
      const i = residents.findIndex((n, j) => !used.has(j) && covers(n, req));
      if (i < 0) return true;
      used.add(i);
      return false;
    })
    .map((r) => r.label);
}

/** People who work indoors get a building of their own (painted on the town's map; they stand outside it). */
const WORKS_INDOORS: NpcRole[] = ['innkeeper', 'merchant', 'trainer', 'crafter'];

/** How a place looks until its painting sets the light. */
function defaultLook(kind: ZoneDef['kind'], indoor: boolean): ZoneLook {
  return { ambient: kind === 'dungeon' ? 0.5 : indoor ? 0.8 : 0.92, lightColor: '#ffe8c0', fogColor: '#101418', outdoor: !indoor, weather: 'none' };
}

export function assembleWorld(d: Draft, owner: { id: string; name: string }): WorldDefinition {
  const rng = new Rng(`${d.seed}:assemble`);
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

  // Each wild place and dungeon gets the two families whose habitat best fits it (spread across places).
  const familyScore = (fam: MonsterFamily, slot: ZoneSlot) => {
    const zi = zoneInfo(slot.slotId);
    const words = new Set(norm(`${slot.kind} ${zi?.name ?? ''} ${zi?.description ?? ''}`).split(' '));
    return norm(fam.habitat).split(' ').filter((w) => words.has(w)).length + rng.next() * 0.9;
  };
  const familyUse = new Map<string, number>();
  const zoneFamilies = new Map<string, string[]>();
  for (const s of sk.slots) {
    if (s.kind === 'town') {
      zoneFamilies.set(s.slotId, []);
      continue;
    }
    const weight = (f: MonsterFamily) => familyScore(f, s) - (familyUse.get(f.id) ?? 0) * 0.6;
    const chosen = [...families].sort((a, b) => weight(b) - weight(a)).slice(0, 2).map((f) => f.id);
    chosen.forEach((id) => familyUse.set(id, (familyUse.get(id) ?? 0) + 1));
    zoneFamilies.set(s.slotId, chosen);
  }

  // ------------------------------------------------------------------ unique items, bosses, cast
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
  /** Two people of the same name are told apart by where they live. */
  const uniqueName = (name: string, slot: string) => {
    let n = name;
    for (let i = 2; usedNames.has(n.toLowerCase()); i++) n = i === 2 ? `${name} of ${zoneInfo(slot)?.name ?? 'elsewhere'}` : `${name} ${i}`;
    usedNames.add(n.toLowerCase());
    return n;
  };
  const makeNpc = (o: NpcOut & { secret?: string }, zoneSlot: string, idx: number, extra?: Partial<NpcDef>): NpcDef => {
    const name = uniqueName(o.name, zoneSlot);
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
      { name: k.name, title: k.title, role: k.role, pronouns: k.pronouns, personality: k.personality, appearance: k.appearance, backstory: k.backstory, knowledge: [], secrets: [], greeting: '', barks: [], secret: k.secret },
      slot,
      i,
      { essential: true },
    );
    npcs.push(n);
    npcKey.set(k.key, n.id);
  });

  // Town residents, and who they talk to.
  const townSlots = sk.slots.filter((s) => s.kind === 'town');
  for (const t of townSlots) (d.towns[t.slotId]?.npcs ?? []).forEach((o, i) => npcs.push(makeNpc(o, t.slotId, 100 + npcs.length + i)));
  for (const t of townSlots) {
    for (const o of d.towns[t.slotId]?.npcs ?? []) {
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
      // Introduce the giver unless the player has just spoken to them (the story opens by meeting the first one).
      if (giverId && (prevMain as QuestDef | null)?.turnInNpcId !== giverId && !(objectives[0]!.type === 'talk' && objectives[0]!.npcId === giverId)) {
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


  // ------------------------------------------------------------------ places and what they hold
  const zones: ZoneDef[] = sk.slots.map((s) => {
    const zi = zoneInfo(s.slotId)!;
    return {
      id: zid(s.slotId),
      name: zi.name,
      kind: s.kind,
      description: zi.description,
      regionIndex: s.regionIndex,
      levelRange: s.levelRange,
      look: defaultLook(s.kind, zi.indoor),
      width: 0,
      height: 0,
      features: [],
      spawns: [],
      indoor: zi.indoor || undefined,
      mapPos: s.mapPos,
      links: s.links.map(zid),
      entry: { x: 0, y: 0 },
      lore: zi.lore,
      familyIds: zoneFamilies.get(s.slotId) ?? [],
    };
  });
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  /** Things are placed when the place is painted. */
  const add = (z: ZoneDef, f: Omit<FeatureDef, 'x' | 'y'>) => z.features.push({ ...f, x: 0, y: 0 });

  // Every link between places is a pair of ways out that lead to each other.
  for (const s of sk.slots)
    for (const link of s.links)
      add(zoneById.get(zid(s.slotId))!, { id: `${zid(s.slotId)}_exit_${link}`, kind: 'exit', targetZoneId: zid(link), targetFeatureId: `${zid(link)}_exit_${s.slotId}`, name: `To ${zoneInfo(link)?.name}` });

  // Towns: a building for everyone who works indoors (painted on the map, not entered: they stand outside it), the
  // waypoint, a sign and a workbench (health comes back outside combat, so there are no beds).
  for (const t of townSlots) {
    const z = zoneById.get(zid(t.slotId))!;
    const content = d.towns[t.slotId];
    const named = [...(content?.buildings ?? [])];
    const here = npcs.filter((n) => n.zoneId === z.id);
    const workers = here.filter((n) => WORKS_INDOORS.includes(n.role));
    const purposeOf = (n: NpcDef) => (n.role === 'innkeeper' ? 'inn' : n.role === 'merchant' ? `${n.merchantKind ?? 'general'} shop` : n.role === 'trainer' ? 'training hall' : 'workshop');
    const nameFor = (n: NpcDef, purpose: string) => {
      const first = norm(n.name).split(' ')[0]!;
      const i = named.findIndex((b) => norm(b.name).includes(first) || norm(b.purpose).split(' ').some((w) => w.length > 2 && purpose.includes(w)));
      if (i >= 0) return named.splice(i, 1)[0]!.name;
      return `${n.name.split(' ')[0]}'s ${purpose === 'inn' ? 'Inn' : capital(purpose.replace(/^\w+ shop$/, 'shop'))}`;
    };
    z.buildings = workers.map((n, bi) => {
      const purpose = purposeOf(n);
      if (n.role === 'crafter' && systems.crafting) add(z, { id: `${z.id}_craft${bi}`, kind: 'craft_station', name: 'Workbench' });
      n.wanders = false;
      return { id: `${z.id}_b${bi}`, name: nameFor(n, purpose), purpose, npcId: n.id };
    });
    add(z, { id: `${z.id}_waypoint`, kind: 'waypoint', name: `${z.name} Waypoint` });
    add(z, { id: `${z.id}_sign`, kind: 'sign', text: content?.signText ?? `Welcome to ${z.name}.`, name: 'Sign' });
    if (systems.crafting && !workers.some((n) => n.role === 'crafter')) add(z, { id: `${z.id}_craft`, kind: 'craft_station', name: 'Workbench' });
  }

  // Wild places and dungeons: treasure and the notes left behind.
  const lore: LoreNote[] = [];
  for (const s of sk.slots.filter((x) => x.kind !== 'town')) {
    const z = zoneById.get(zid(s.slotId))!;
    const crng = rng.fork(`${z.id}:chests`);
    const chests = s.kind === 'dungeon' ? 3 : 2;
    const [lo, hi] = z.levelRange;
    for (let i = 0; i < chests; i++)
      add(z, { id: `${z.id}_chest${i}`, kind: 'chest', name: 'Chest', lootTier: Math.round(lo + ((hi - lo) * i) / Math.max(1, chests - 1)), lockLevel: systems.lockpicking && crng.chance(0.3) ? hi : undefined });
    for (const [i, note] of (d.areas[s.slotId]?.loreNotes ?? []).entries()) {
      const id = `l${lore.length}`;
      lore.push({ id, title: note.title, text: note.text });
      add(z, { id: `${z.id}_lore${i}`, kind: 'lore', loreId: id, name: note.title });
    }
  }

  // Things quest objectives ask the player to use.
  for (const f of interactFeatures) {
    const z = zoneById.get(f.zoneId);
    if (z) add(z, { id: f.featureId, kind: 'object', name: capital(f.name) });
  }

  // Quest items: carried by a boss, or in a chest of their own in a wild place or dungeon.
  for (const p of itemPlacements) {
    if (p.bossId) {
      bosses.find((b) => b.id === p.bossId)?.drops.push(p.uniqueId);
      continue;
    }
    const want = p.zoneId ? zoneById.get(p.zoneId) : undefined;
    const z = want && want.kind !== 'town' && want.kind !== 'interior' ? want : zones.find((x) => x.kind === 'dungeon' && x.regionIndex === (want?.regionIndex ?? 0)) ?? zones.find((x) => x.kind === 'dungeon')!;
    const chest = z.features.find((f) => f.id === `${z.id}_chest_quest`);
    if (chest) chest.items!.push(p.uniqueId);
    else add(z, { id: `${z.id}_chest_quest`, kind: 'chest', name: 'Chest', lootTier: z.levelRange[1] + 1, items: [p.uniqueId] });
  }

  const worldFacts = [
    ...d.concept.worldFacts,
    ...d.atlas.regions.map((x) => `${x.name}: ${x.description}`),
    ...d.concept.factions.map((f) => `${f.name}: ${f.description}`),
  ];

  const world: WorldDefinition = {
    id: d.id,
    formatVersion: 2,
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
  delete (world.concept as { _rules?: string })._rules;
  bindWorld(world, r, d.rulesIntent.classes);
  return world;
}
