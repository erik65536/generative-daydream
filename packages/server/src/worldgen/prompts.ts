/** Prompt text for each world-generation step. */
import { LENGTH_PROFILES, MONSTER_ARCHETYPES, ROLE_VISUAL, SIZE_PROFILES, type PromptTopic, type Ruleset, type WorldInput } from '@gd/shared';
import type { ConceptOut, AtlasOut } from './schemas';
import type { WorldSkeleton, ZoneSlot } from './structure';
import { TILE, PAINT_PXM, TILE_RANGE } from './mapdraw';

export const SYSTEM = `You are the lead world designer for "Generative Daydream", an engine for 2D top-down RPGs in the spirit of Baldur's Gate 2 and Diablo 2, with turn-based combat like Divinity: Original Sin 2.
The world's rules (health, resources, classes, skills, items) are designed in a separate step; your job here is the world itself: places, characters and story that fit the user's theme perfectly — whether that is high fantasy, a space adventure, a cozy animal tale, a surreal wonderland or an office comedy.
Rules:
- Honor the user's theme and prompts above everything else, including any meta instructions they give.
- Be specific, vivid and original. Prefer concrete details over generic fantasy filler. Give characters distinct voices and wants.
- Stay consistent with everything already decided (names, facts, tone).
- In-world text never mentions game mechanics, JSON, or the engine.
- Output only the requested JSON.`;

const TOPIC_LABEL: Record<PromptTopic, string> = {
  story: 'the story', places: 'the places', people: 'the people', monsters: 'the monsters and foes', rules: 'the rules and their words', art: 'the art',
};

/** The user's theme, the prompts aimed at these parts of the build, and the world's scale. */
export function brief(input: WorldInput, topics: PromptTopic[]): string {
  const s = SIZE_PROFILES[input.size];
  const l = LENGTH_PROFILES[input.length];
  const prompts = (input.prompts ?? []).filter((p) => topics.includes(p.topic) && p.text.trim());
  return [
    `THE USER'S THEME:\n${input.theme.trim()}`,
    prompts.length ? `THE USER'S PROMPTS (follow these):\n${prompts.map((p) => `- about ${TOPIC_LABEL[p.topic]}: ${p.text.trim()}`).join('\n')}` : '',
    `SCALE (for your planning only; never mention these counts, levels, arcs or other game structure in anything the player reads, such as the pitch, intro, descriptions, quests or dialogue): ${s.towns} ${s.towns === 1 ? 'town' : 'towns'}, ${s.wilds} stretches of wild country and ${s.dungeons} dungeons; a ${input.length} story (max level ${l.maxLevel}, ${l.arcs} story arcs).`,
    `PARTY: ${input.combatMode === 'solo' ? 'the player adventures alone' : input.combatMode === 'party_manual' ? 'the player makes and controls a party of four' : 'the player travels with three companions, heroes of this world who join them from the start'}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function conceptSummary(c: ConceptOut): string {
  return [
    `WORLD: "${c.title}" — ${c.pitch}`,
    `Genre: ${c.genre}. Tone: ${c.tone}. The player is ${c.playerRole}.`,
    `Antagonist: ${c.villain.name}, ${c.villain.title} — ${c.villain.motive}`,
    `Hidden truth (for consistency, never state openly): ${c.secret}`,
    c.factions.length ? `Factions: ${c.factions.map((f) => `${f.name} (${f.description})`).join('; ')}` : '',
    c.worldFacts.length ? `Facts: ${c.worldFacts.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The rule words the world's text should use. */
export function rulesWords(r: Ruleset): string {
  const t = r.terminology;
  return `Rule words to use: health "${r.health.name}", currency "${t.currency}", ${t.quest.toLowerCase()} for quest, ${t.party.toLowerCase()} for party. Classes: ${r.classes.map((c) => c.name).join(', ')}. Kins: ${r.kins.map((k) => k.name).join(', ')}.`;
}

export function conceptPrompt(input: WorldInput): string {
  return `${brief(input, ['story', 'art'])}

Design the core concept of this world.
- "artStyle": comma-separated keywords for a consistent illustrated look (medium, palette, lighting, mood).
- "intro": 80-150 words of second-person opening narration that hooks the player without revealing the secret.
- "secret": the twist the main story slowly reveals.
- 6-12 "worldFacts" NPCs might know (history, customs, rumors).`;
}

const METRES_PER_TILE = Math.round(TILE / PAINT_PXM);
const range = (k: keyof typeof TILE_RANGE) => `${TILE_RANGE[k].min.join('×')} to ${TILE_RANGE[k].max.join('×')}`;

function slotLine(s: ZoneSlot, sk: WorldSkeleton): string {
  return `- ${s.slotId}: ${s.kind}, region ${s.regionIndex}, levels ${s.levelRange[0]}-${s.levelRange[1]}, connects to ${s.links.join(', ')}${s.slotId === sk.startSlot ? ' (where the hero starts)' : ''}`;
}

/** The world plan: every place named and described, sized in map tiles, and given its part in the story. */
export function atlasPrompt(input: WorldInput, concept: ConceptOut, sk: WorldSkeleton): string {
  return `${conceptSummary(concept)}

${brief(input, ['story', 'places'])}

The engine has laid out the world map. Plan every region and every place below (use the exact slotIds). Regions get harder from 0 to ${sk.regions.length - 1}; the story's ${sk.arcs} arcs move through them in order.
Regions: ${sk.regions.map((r) => `${r.index} (levels ${r.levelRange[0]}-${r.levelRange[1]})`).join(', ')}
Places:
${sk.slots.map((s) => slotLine(s, sk)).join('\n')}

"town" = a safe settlement where people live and work (in this setting it could be a village, station, burrow, office floor...). "wilderness" = open country between places. "dungeon" = a dangerous enclosed place (cave, derelict ship, crypt, server room...).
For each place:
- "name", "description" (what it is and looks like), "lore" (a private note on its history and secrets that people there may refer to).
- "indoor": true when the place is inside a structure (under a roof or ceiling, no sky), false under the open sky. Every place is its own place: within one world one might be a vast hall and the next an open marsh. Think about what this specific place is, not the genre.
- "role": what this place is for in the story: what the hero comes here for, which arc's turning point or revelation happens here, which foe makes its lair here (a boss lair is a dungeon or wild place), what the side quests of a town point at. Spread the story over the places so every place matters, and the strongest moments land in the places that suit them.
- "tiles": the size of its map, in tiles of about ${METRES_PER_TILE} m square (columns × rows): towns ${range('town')}, wilderness ${range('wilderness')}, dungeons ${range('dungeon')}. The whole world may use at most ${SIZE_PROFILES[input.size].tiles} tiles together, so choose where the space goes: big for the places the story lingers in and for open country, small for a single lair or a cramped hideout.`;
}

export function storyPrompt(input: WorldInput, concept: ConceptOut, atlas: AtlasOut, sk: WorldSkeleton, familyNames: string[]): string {
  const zone = (id: string) => atlas.zones.find((z) => z.slotId === id);
  return `${conceptSummary(concept)}

${brief(input, ['story', 'people', 'monsters'])}

PLACES (slotId: name — kind, region, levels; its part in the story):
${sk.slots.map((s) => `- ${s.slotId}: ${zone(s.slotId)?.name ?? s.slotId} — ${s.kind}, region ${s.regionIndex}, levels ${s.levelRange[0]}-${s.levelRange[1]}; ${zone(s.slotId)?.role ?? ''}`).join('\n')}
MONSTER FAMILIES: ${familyNames.join(', ')}

Write the MAIN STORYLINE as exactly ${sk.arcs} arcs, following the parts the world plan gave each place. Arc i should mostly take place in region ${sk.regions.length > 1 ? `round(i*${sk.regions.length}/${sk.arcs})` : '0'} so difficulty rises with the story. The story must evolve: early arcs should seem like one kind of problem, and each arc's "revelation" reframes what came before, building to the hidden truth. The final arc ends by defeating the final boss (the antagonist or what they became).

Define the cast first, then reference them by "key":
- keyNpcs (3-8): story characters who live in towns (townSlot must be a town slot). The first quest's giver should live in ${zone(sk.startSlot)?.name ?? sk.startSlot} (${sk.startSlot}).
- bosses (one per arc, the last is the final boss): each makes its lair in a dungeon or wild place ("lairSlot"), the one the plan chose for it where it did.
- keyItems: story objects the player must find, carry or deliver.
- Each arc has 2-4 quests. Each quest has 1-6 objectives in order. Objective types:
  talk (npcKey) — speak to someone; kill_unique (bossKey) — defeat a boss; kill (familyHint, count, optional zoneSlot) — defeat monsters of a family;
  collect (itemKey, optional zoneSlot where it is found) — obtain an item; deliver (itemKey + npcKey) — hand an item to someone;
  reach (zoneSlot) — travel somewhere; interact (zoneSlot) — activate something there (describe it); persuade (npcKey) — convince someone of something in conversation (describe what).
- Use the quest giver's key for "giverKey" (it must be a keyNpc). Make quests feel like a story, not a checklist: vary objective types, include at least one persuade objective somewhere, and let later quests pay off earlier ones.
- "ending": the epilogue narration after the final boss falls.`;
}

export function familiesPrompt(input: WorldInput, concept: ConceptOut, count: number, damageKinds: string[]): string {
  return `${conceptSummary(concept)}

${brief(input, ['monsters'])}

Create ${count} distinct families of hostile creatures/opponents for this world (in a comedy they can be silly; in a cozy tale they are mischievous rather than gory).
Each family has 2-5 members, each with a different combat archetype: ${MONSTER_ARCHETYPES.map((a) => `${a} (${ROLE_VISUAL[a].name.toLowerCase()})`).join(', ')}.
"element" is the family's damage affinity — one of: ${damageKinds.join(', ')}; "habitat" lists where they live (words like town, forest, cave, swamp, ruins, mountain, snow, desert, station, derelict, lab...); "appearance" is a short visual description used to draw each member.`;
}

export function townPrompt(
  input: WorldInput,
  concept: ConceptOut,
  town: { name: string; description: string; lore?: string; role?: string; level: number; region: string },
  ctx: { npcCount: number; sideQuests: number; keyNpcs: string[]; nearbyZones: string[]; families: string[]; requiredRoles: string[] },
): string {
  return `${conceptSummary(concept)}

${brief(input, ['people', 'story'])}

TOWN: ${town.name} (region ${town.region}, around level ${town.level}) — ${town.description}${town.lore ? `\nPrivate lore: ${town.lore}` : ''}${town.role ? `\nIts part in the story: ${town.role}` : ''}
Story characters already living here: ${ctx.keyNpcs.length ? ctx.keyNpcs.join('; ') : 'none'}.
Nearby places: ${ctx.nearbyZones.join(', ')}. Local threats: ${ctx.families.join(', ')}.

Create:
1. "npcs": ${ctx.npcCount} additional residents (do not repeat the story characters). These roles are required, each as its own resident (one person per role): ${ctx.requiredRoles.join(', ')} (these are game functions; give them titles, trades and greetings that fit this world, e.g. a capsule-hotel manager rather than an innkeeper on a space station); fill the rest with commoners, guards, nobles or mystics. Merchants need a merchantKind (general, weapons, armor, alchemy, magic, materials). Give each a real personality, a want, 1-4 things they know ("knowledge", gossip that connects to the world), optional secrets, a speaking "voice", a greeting line and 2-3 short ambient barks. "friends" lists names of other residents they talk to.
2. "buildings": names for the town's buildings (inn, shops, workshops, homes) with their purpose.
3. "sideQuests": ${ctx.sideQuests} local side quests given by residents (giverName must be one of your npcs or story characters). Objective types: talk/persuade (target = person's name), kill (target = monster family name, with count), collect (target = item name to find, it will be hidden nearby), deliver (target = person to give the collected item to), reach (target = place name), interact (target = place name; describe the thing). Make them human and specific; some should have a twist or a choice in the final conversation.
4. "signText": the text on the sign at the town entrance.`;
}

export function areaPrompt(input: WorldInput, concept: ConceptOut, zone: { name: string; kind: string; description: string; lore?: string; role?: string; level: [number, number]; families: string[] }, loreCount: number): string {
  return `${conceptSummary(concept)}

${brief(input, ['story', 'places'])}

PLACE: ${zone.name} — a ${zone.kind}, levels ${zone.level[0]}-${zone.level[1]}. ${zone.description}${zone.lore ? `\nPrivate lore: ${zone.lore}` : ''}${zone.role ? `\nIts part in the story: ${zone.role}` : ''}
Creatures here: ${zone.families.join(', ')}.

Create "loreNotes": ${loreCount} readable documents found here (journals, carvings, logs, letters...) that hint at the world's history and the main story without spelling out the secret. 60-160 words each, in-world voice.`;
}

/** The three heroes who travel with the player (a world played with companions). */
export function companionsPrompt(input: WorldInput, concept: ConceptOut, r: Ruleset, start: { name: string; description: string }, people: string[]): string {
  return `${conceptSummary(concept)}

${brief(input, ['people', 'story'])}

${rulesWords(r)}
CLASSES: ${r.classes.map((c) => `${c.name} (${c.role}): ${c.description}`).join('; ')}.
KINS: ${r.kins.map((k) => `${k.name} (${k.presentation === 'feminine' ? 'women' : k.presentation === 'masculine' ? 'men' : 'androgynous'}): ${k.description}`).join('; ')}.

PEOPLE OF ${start.name.toUpperCase()}: ${people.join('; ') || 'none yet'}.

Create the three COMPANIONS who travel with the player from the start, setting out from ${start.name} (${start.description}). Where the world above already names the heroes who set out with the player, or some of these people are clearly meant to, make those the companions under the same names; the rest are new people. They are heroes of this world with their own reasons to join this journey, and they fight beside the player. Give the three different classes that make a well-rounded party (a front-liner, a damage dealer and a healer or support where the classes allow), and each a kin. Each needs a name, a short title, a personality with a want and a flaw, a backstory that ties them to the world and the story, a speaking voice, a greeting for when the player first talks to them, 2-3 short barks, 1-3 things they know, and an "appearance": what they look like and wear, in the style of their class, as a person of their kin (and so as that kin's gender).`;
}
