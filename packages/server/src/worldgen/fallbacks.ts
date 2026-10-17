/** Procedural producers matching each LLM step's output shape. */
import {
  AFFIXES, ITEM_BASES, ORIGINS, PLAYER_SKILL_IDS, RECIPES, SKILLS, TRAP_INFO, TRAP_KINDS, MONSTER_ARCHETYPES, Rng,
  type MonsterArchetype, type NpcRole, type TilesetDef, type TileRole,
} from '@gd/shared';
import { BANKS, fallbackTileset, syllableName, type Genre, type GenreBank } from './genres';
import { normColor, normColors, type AffixOut, type AreaContentOut, type AtlasOut, type ConceptOut, type FamiliesOut, type ItemsOut, type NpcOut, type SkillsOut, type StoryOut, type TilesetOut, type TownContentOut } from './schemas';
import type { WorldSkeleton, ZoneSlot } from './structure';

const pick = <T>(rng: Rng, a: readonly T[]) => rng.pick(a);

export function fallbackConcept(genre: Genre, setting: string, rng: Rng): ConceptOut {
  const b = BANKS[genre];
  const title = `${pick(rng, b.title[0])} ${pick(rng, b.title[1])}`;
  const villainName = pick(rng, b.villain[0]);
  const villainTitle = pick(rng, b.villain[1]);
  const mac = pick(rng, b.macguffin);
  const threat = pick(rng, b.threat);
  const settingLine = setting.trim().split(/[.!?\n]/)[0]?.slice(0, 160) || 'a land at the edge of change';
  return {
    title,
    pitch: `${settingLine}. Something is wrong: ${threat} spreads, and only ${b.playerRole} can learn why.`,
    genre,
    tone: b.tone,
    artStyle: b.artStyle,
    playerRole: b.playerRole,
    intro: `They say every road leads home, but yours has led you here. ${settingLine}. For weeks there have been rumors of ${threat}, of travelers who never arrived and lights where no lights should be. You came for coin, or perhaps for answers you have not admitted to yourself. Now the first ${b.terminology.town ?? 'town'} lies ahead, and someone there is waiting for you.`,
    secret: `${villainName}, ${villainTitle}, is not the cause of ${threat} but its first victim — they seek ${mac} to undo what they once began, and the people who hired you want it for themselves.`,
    villain: { name: villainName, title: villainTitle, motive: `To claim ${mac} and remake the world in their image.` },
    terminology: { ...(b.terminology as ConceptOut['terminology']) },
    systems: { crafting: true, traps: true, dualEnergy: b.dualEnergy, lockpicking: true },
    factions: b.factions.slice(0, 3).map((f) => ({ name: f, description: `A faction with its own stake in ${mac}.` })),
    worldFacts: [
      `${mac} has been lost for generations.`,
      `People speak of ${threat} only in whispers.`,
      `${villainName} is known as ${villainTitle}.`,
      `${b.factions[0]} keeps order on the roads, for a price.`,
    ],
  };
}

export function fallbackAtlas(genre: Genre, sk: WorldSkeleton, rng: Rng, biomeFor: (s: ZoneSlot) => TilesetDef['style']): AtlasOut {
  const b = BANKS[genre];
  const used = new Set<string>();
  const unique = (fn: () => string) => {
    for (let i = 0; i < 20; i++) {
      const n = fn();
      if (!used.has(n)) {
        used.add(n);
        return n;
      }
    }
    return fn() + ` ${used.size}`;
  };
  return {
    regions: sk.regions.map((r) => ({ index: r.index, name: unique(() => `The ${syllableName(b, () => rng.next())} ${pick(rng, ['Reach', 'Marches', 'Lowlands', 'Expanse', 'Frontier', 'Basin'])}`), description: 'A region of the world.' })),
    zones: sk.slots.map((s) => ({
      slotId: s.slotId,
      name: unique(() =>
        s.kind === 'town'
          ? syllableName(b, () => rng.next())
          : s.kind === 'wilderness'
            ? `${pick(rng, b.wildNames[0])} ${pick(rng, b.wildNames[1])}`
            : `The ${pick(rng, b.dungeonNames[0])} ${pick(rng, b.dungeonNames[1])}`,
      ),
      description:
        s.kind === 'town'
          ? 'A settlement where travelers trade news and supplies.'
          : s.kind === 'wilderness'
            ? 'Wild country where the roads grow thin and danger grows thick.'
            : 'A dark place few return from.',
      biome: biomeFor(s),
    })),
  };
}

export function fallbackStory(genre: Genre, sk: WorldSkeleton, atlas: AtlasOut, concept: ConceptOut, rng: Rng): StoryOut {
  const b = BANKS[genre];
  const name = (slot: string) => atlas.zones.find((z) => z.slotId === slot)?.name ?? slot;
  const towns = sk.slots.filter((s) => s.kind === 'town');
  const dungeons = sk.slots.filter((s) => s.kind === 'dungeon');
  const arcs = sk.arcs;
  const mac = concept.worldFacts[0]?.split(' has')[0] ?? pick(rng, b.macguffin);
  const keyNpcs: StoryOut['keyNpcs'] = [];
  const bosses: StoryOut['bosses'] = [];
  const keyItems: StoryOut['keyItems'] = [];
  const outArcs: StoryOut['arcs'] = [];
  const person = () => `${pick(rng, b.firstNames)} ${pick(rng, b.lastNames)}`;
  for (let a = 0; a < arcs; a++) {
    const region = Math.min(sk.regions.length - 1, Math.floor((a * sk.regions.length) / arcs));
    const town = towns.find((t) => t.regionIndex === region) ?? towns[Math.min(a, towns.length - 1)]!;
    const regionDungeons = dungeons.filter((d) => d.regionIndex === region);
    const dungeon = (a === arcs - 1 ? dungeons[dungeons.length - 1] : regionDungeons[regionDungeons.length - 1]) ?? dungeons[Math.min(a, dungeons.length - 1)]!;
    const patronKey = `patron${a}`;
    keyNpcs.push({
      key: patronKey,
      name: person(),
      title: a === 0 ? 'Keeper of Old Records' : pick(rng, ['Captain of the Watch', 'Exiled Scholar', 'Elder', 'Quartermaster', 'Oracle']),
      role: a === 0 ? 'questgiver' : pick(rng, ['questgiver', 'noble', 'mystic'] as NpcRole[]),
      townSlot: town.slotId,
      personality: pick(rng, ['weary but kind', 'sharp-tongued and secretive', 'earnest and anxious', 'grandly theatrical', 'quietly calculating']),
      appearance: pick(rng, ['tall, grey-haired, in a patched long coat', 'small and wiry with ink-stained fingers', 'broad-shouldered with a scarred face', 'elegant, with rings on every finger']),
      backstory: `Has watched the signs of ${b.threat[a % b.threat.length]} for years and kept careful notes.`,
      secret: a === arcs - 1 ? `Once served ${concept.villain.name}.` : undefined,
    });
    const bossKey = `boss${a}`;
    const archetypes: MonsterArchetype[] = ['brute', 'caster', 'guardian', 'assassin'];
    bosses.push({
      key: bossKey,
      name: a === arcs - 1 ? concept.villain.name : `${pick(rng, b.firstNames)} the ${pick(rng, ['Hollow', 'Cruel', 'Ashen', 'Unbroken', 'Devourer'])}`,
      title: a === arcs - 1 ? concept.villain.title : pick(rng, ['Lieutenant of the Dark', 'Warden of the Deep', 'The Gatekeeper']),
      description: a === arcs - 1 ? concept.villain.motive : `A servant guarding the way forward.`,
      appearance: 'imposing, armored, wreathed in shadow',
      dungeonSlot: dungeon.slotId,
      archetype: a === arcs - 1 ? 'brute' : pick(rng, archetypes),
      taunt: a === arcs - 1 ? 'You were always going to end up here.' : 'Turn back while you still can.',
    });
    const itemKey = `relic${a}`;
    keyItems.push({ key: itemKey, name: a === arcs - 1 ? mac : `Fragment of ${mac}`, description: `A piece of the puzzle, warm to the touch.`, kind: 'relic' });
    const wild = sk.slots.find((s) => s.kind === 'wilderness' && s.regionIndex === region);
    const quests: StoryOut['arcs'][number]['quests'] = [];
    quests.push({
      title: a === 0 ? 'A Summons' : `Word from ${name(town.slotId)}`,
      summary: `Meet ${keyNpcs[keyNpcs.length - 1]!.name} in ${name(town.slotId)} and learn what they know.`,
      giverKey: patronKey,
      objectives: [{ type: 'talk', description: `Speak with ${keyNpcs[keyNpcs.length - 1]!.name}`, npcKey: patronKey }],
      completionText: 'There is more to this than anyone admitted.',
    });
    quests.push({
      title: `Into ${name(dungeon.slotId)}`,
      summary: `Something waits in ${name(dungeon.slotId)}. Recover the ${keyItems[keyItems.length - 1]!.name} and defeat its guardian.`,
      giverKey: patronKey,
      objectives: [
        ...(wild ? [{ type: 'reach' as const, description: `Travel to ${name(wild.slotId)}`, zoneSlot: wild.slotId }] : []),
        { type: 'reach', description: `Find the way into ${name(dungeon.slotId)}`, zoneSlot: dungeon.slotId },
        { type: 'kill_unique', description: `Defeat ${bosses[bosses.length - 1]!.name}`, bossKey },
        { type: 'collect', description: `Recover the ${keyItems[keyItems.length - 1]!.name}`, itemKey },
        { type: 'deliver', description: `Bring the ${keyItems[keyItems.length - 1]!.name} to ${keyNpcs[keyNpcs.length - 1]!.name}`, itemKey, npcKey: patronKey },
      ],
      completionText: `The ${keyItems[keyItems.length - 1]!.name} hums with a familiar voice.`,
    });
    outArcs.push({
      title: a === arcs - 1 ? 'The Last Door' : `${pick(rng, ['Whispers', 'Embers', 'Shadows', 'Echoes', 'Roots'])} of ${name(town.slotId)}`,
      summary: `The trail leads through ${name(town.slotId)} to ${name(dungeon.slotId)}.`,
      revelation: a === arcs - 1 ? concept.secret : `What you recovered was never meant to be found — and someone has been following your progress all along.`,
      quests,
    });
  }
  return { keyNpcs, bosses, keyItems, arcs: outArcs, ending: `With ${concept.villain.name} defeated, the ${b.threat[0]} recedes. The world does not become what it was — but it becomes something, and you helped decide what.` };
}

export function fallbackSkills(genre: Genre, systems: { traps: boolean; lockpicking: boolean }): SkillsOut {
  const b = BANKS[genre];
  const skills = PLAYER_SKILL_IDS.filter((id) => (id !== 'disarm_trap' || systems.traps) && (id !== 'pick_lock' || systems.lockpicking) && (id !== 'keen_eye' || systems.traps)).map((id) => ({
    id,
    name: b.skills[id] ?? SKILLS[id]!.defaultName,
    description: SKILLS[id]!.summary,
  }));
  return { skills, origins: ORIGINS.map((o) => ({ id: o.id, name: b.origins[o.id] ?? o.defaultName, description: `A ${b.origins[o.id] ?? o.defaultName} who has seen hard roads.`, appearance: `${b.origins[o.id] ?? o.defaultName}, practical travel gear` })) };
}

export function fallbackItems(genre: Genre): ItemsOut {
  const b = BANKS[genre];
  return {
    items: ITEM_BASES.filter((x) => x.category !== 'quest' && x.category !== 'key').map((x) => ({
      baseId: x.id,
      names: b.items[x.id] ?? [x.defaultName],
      description: `A dependable ${(b.items[x.id]?.[0] ?? x.defaultName).toLowerCase()}.`,
    })),
  };
}

export function fallbackAffixes(): AffixOut {
  return {
    affixes: AFFIXES.map((a) => ({ id: a.id, prefix: a.defaultPrefix, suffix: a.defaultSuffix })),
    traps: TRAP_KINDS.map((k) => ({ kind: k, name: TRAP_INFO[k].defaultName })),
    recipes: RECIPES.map((r) => ({ id: r.id, name: r.defaultName })),
  };
}

export function fallbackFamilies(genre: Genre, count: number, rng: Rng): FamiliesOut {
  const b = BANKS[genre];
  const fams = rng.shuffle([...b.families]).slice(0, Math.max(2, count));
  while (fams.length < count) fams.push(...BANKS.fantasy.families.filter((f) => !fams.includes(f)).slice(0, count - fams.length));
  return {
    families: fams.slice(0, count).map((f) => ({
      name: f.name,
      description: f.description,
      element: f.element,
      habitat: f.habitat,
      colors: f.colors,
      members: (Object.entries(f.members) as [MonsterArchetype, string][]).map(([archetype, name]) => ({ archetype, name, description: `${name}: one of the ${f.name.toLowerCase()}.`, appearance: `${name}, ${f.description.toLowerCase()}` })),
    })),
  };
}

export function tilesetFromOut(id: string, out: TilesetOut | undefined, fb: TilesetDef): TilesetDef {
  if (!out) return fb;
  const roles = { ...fb.roles };
  for (const [k, v] of Object.entries(out.roles ?? {})) {
    if (!v) continue;
    const role = k as TileRole;
    roles[role] = {
      name: v.name || fb.roles[role].name,
      colors: normColors(v.colors).length ? normColors(v.colors) : fb.roles[role].colors,
      prompt: v.prompt || fb.roles[role].prompt,
    };
  }
  return { ...fb, id, name: out.name || fb.name, style: out.style ?? fb.style, ambient: out.ambient ?? fb.ambient, weather: out.weather ?? fb.weather, lightColor: normColor(out.lightColor) ?? fb.lightColor, roles };
}

const ROLE_PLAN: { role: NpcRole; merchantKind?: NpcOut['merchantKind']; title: string }[] = [
  { role: 'innkeeper', title: 'Innkeeper' },
  { role: 'merchant', merchantKind: 'general', title: 'Trader' },
  { role: 'merchant', merchantKind: 'weapons', title: 'Smith' },
  { role: 'trainer', title: 'Trainer' },
  { role: 'guard', title: 'Guard' },
  { role: 'merchant', merchantKind: 'alchemy', title: 'Alchemist' },
  { role: 'commoner', title: 'Local' },
  { role: 'merchant', merchantKind: 'armor', title: 'Armorer' },
  { role: 'companion', title: 'Wandering Adventurer' },
  { role: 'commoner', title: 'Farmer' },
  { role: 'merchant', merchantKind: 'magic', title: 'Curio Dealer' },
  { role: 'crafter', title: 'Tinker' },
  { role: 'guard', title: 'Gate Warden' },
  { role: 'commoner', title: 'Gossip' },
];

export function fallbackNpc(b: GenreBank, rng: Rng, plan: { role: NpcRole; merchantKind?: NpcOut['merchantKind']; title: string }, townName: string): NpcOut {
  const name = `${pick(rng, b.firstNames)} ${pick(rng, b.lastNames)}`;
  const personality = pick(rng, ['cheerful and talkative', 'gruff but fair', 'nervous and kind', 'proud of their work', 'suspicious of outsiders', 'dreamy and distracted', 'blunt and practical']);
  const greetings: Record<string, string[]> = {
    innkeeper: ['Come in, come in! A bed and a hot meal won\'t cost you much.', 'Rooms upstairs, ale down here. What\'ll it be?'],
    merchant: ['Looking to buy? Everything here is honest work.', 'Coin talks. What are you after?'],
    trainer: ['You have the look of someone who could learn a thing or two.', 'Skill is earned, not given. Want to earn some?'],
    guard: ['Keep your weapons sheathed in town.', 'Move along, traveler. Unless you have business.'],
    companion: ['Heading out? Could use the company, and you look like you could use a sword arm.', 'The road is lonely. I\'m not picky about whose side I\'m on — as long as it\'s the winning one.'],
    commoner: [`Welcome to ${townName}. Mind the mud.`, 'Strange times. Strange times.'],
    crafter: ['If it\'s broken, I can fix it. If it isn\'t, I can improve it.'],
    questgiver: ['Ah, you came. Good.'],
    noble: ['You may approach.'],
    mystic: ['I dreamed you would come.'],
  };
  return {
    name,
    title: plan.title,
    role: plan.role,
    merchantKind: plan.merchantKind,
    pronouns: pick(rng, ['she/her', 'he/him', 'they/them']),
    personality,
    appearance: `${pick(rng, ['weathered', 'young', 'elderly', 'stout', 'lanky'])} ${plan.title.toLowerCase()} in ${pick(rng, ['simple work clothes', 'a stained apron', 'well-kept finery', 'travel-worn leathers'])}`,
    backstory: `Has lived in ${townName} ${pick(rng, ['all their life', 'for a few uneasy years', 'since the last war'])}.`,
    knowledge: [`Things have been odd around ${townName} lately.`],
    secrets: [],
    voice: personality,
    greeting: pick(rng, greetings[plan.role] ?? greetings.commoner!),
    barks: [pick(rng, ['Fine weather, if it lasts.', 'Heard wolves again last night.', 'Prices keep going up.', 'Did you see those lights?']), pick(rng, ['Watch yourself out there.', 'Busy day.', 'Hm.'])],
    canJoinParty: plan.role === 'companion',
  };
}

export function fallbackTownContent(genre: Genre, rng: Rng, townName: string, npcCount: number, fbTileset: TilesetDef, fbInterior: TilesetDef, nearby: { families: string[]; zones: string[] }, sideQuests: number): TownContentOut {
  const b = BANKS[genre];
  const npcs: NpcOut[] = [];
  for (let i = 0; i < npcCount; i++) npcs.push(fallbackNpc(b, rng, ROLE_PLAN[i % ROLE_PLAN.length]!, townName));
  const sq: TownContentOut['sideQuests'] = [];
  for (let i = 0; i < sideQuests; i++) {
    const giver = npcs[(i * 3 + 6) % npcs.length]!;
    const fam = nearby.families[i % Math.max(1, nearby.families.length)] ?? 'monsters';
    const zone = nearby.zones[i % Math.max(1, nearby.zones.length)];
    const kind = i % 3;
    if (kind === 0)
      sq.push({ title: `Trouble with ${fam}`, summary: `${giver.name} wants the ${fam.toLowerCase()} near town thinned out.`, giverName: giver.name, objectives: [{ type: 'kill', description: `Defeat ${fam}`, target: fam, count: 4 + (i % 3) }, { type: 'talk', description: `Return to ${giver.name}`, target: giver.name }], completionText: 'Thank you. We can sleep a little easier.' });
    else if (kind === 1)
      sq.push({ title: 'A Lost Keepsake', summary: `${giver.name} lost a family keepsake${zone ? ` in ${zone}` : ''}.`, giverName: giver.name, objectives: [{ type: 'collect', description: `Find ${giver.name.split(' ')[0]}'s keepsake`, target: `${giver.name.split(' ')[0]}'s Keepsake`, count: 1 }, { type: 'deliver', description: `Return the keepsake to ${giver.name}`, target: giver.name }], rewardItem: undefined, completionText: 'You found it! I never thought I would see it again.' });
    else {
      const other = npcs[(i * 5 + 1) % npcs.length]!;
      sq.push({ title: 'Words Left Unsaid', summary: `${giver.name} needs someone to carry a message to ${other.name}.`, giverName: giver.name, objectives: [{ type: 'talk', description: `Speak with ${other.name} on ${giver.name.split(' ')[0]}'s behalf`, target: other.name }, { type: 'talk', description: `Tell ${giver.name} what ${other.name} said`, target: giver.name }], completionText: 'So that\'s how it is. Thank you for being honest with me.' });
    }
  }
  return {
    npcs,
    buildings: [],
    sideQuests: sq,
    tileset: { name: fbTileset.name, style: fbTileset.style, roles: {} },
    interiorTileset: { name: fbInterior.name, style: fbInterior.style, roles: {} },
    signText: `Welcome to ${townName}.`,
  };
}

export function fallbackAreaContent(fb: TilesetDef, name: string, rng: Rng, genre: Genre): AreaContentOut {
  const b = BANKS[genre];
  return {
    tileset: { name: fb.name, style: fb.style, roles: {} },
    loreNotes: [
      { title: 'A Torn Journal Page', text: `...the deeper we went into ${name}, the quieter it became. ${pick(rng, b.firstNames)} swears the walls were whispering about ${pick(rng, b.macguffin)}. I told them it was the wind. There is no wind down here.` },
    ],
    shrineName: undefined,
  };
}
