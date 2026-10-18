/** Prompt text for each world-generation step. */
import { LENGTH_PROFILES, MONSTER_ARCHETYPES, ROLE_VISUAL, SIZE_PROFILES, type Ruleset, type WorldInput } from '@gd/shared';
import type { ConceptOut, AtlasOut } from './schemas';
import type { WorldSkeleton, ZoneSlot } from './structure';

export const SYSTEM = `You are the lead world designer for "Generative Daydream", an engine for 2D isometric RPGs in the spirit of Baldur's Gate 2 and Diablo 2, with turn-based combat like Divinity: Original Sin 2.
The world's rules (health, resources, classes, skills, items) are designed in a separate step; your job here is the world itself: places, characters and story that fit the user's setting perfectly — whether that is high fantasy, a space adventure, a cozy animal tale, a surreal wonderland or an office comedy.
Rules:
- Honor the user's setting, story ideas and notes above everything else, including any meta instructions they give.
- Be specific, vivid and original. Prefer concrete details over generic fantasy filler. Give characters distinct voices and wants.
- Stay consistent with everything already decided (names, facts, tone).
- In-world text never mentions game mechanics, JSON, or the engine.
- Output only the requested JSON.`;

export function userBrief(input: WorldInput): string {
  const s = SIZE_PROFILES[input.size];
  const l = LENGTH_PROFILES[input.length];
  return [
    `USER'S SETTING:\n${input.setting.trim()}`,
    input.story?.trim() ? `USER'S STORY / LORE / QUEST IDEAS:\n${input.story.trim()}` : '',
    input.notes?.trim() ? `USER'S ADDITIONAL NOTES (follow these):\n${input.notes.trim()}` : '',
    `SCALE (for your planning only; never mention these counts, levels, arcs or other game structure in anything the player reads, such as the pitch, intro, descriptions, quests or dialogue): ${input.size} world (${s.towns} towns, ${s.wilds} wilderness areas, ${s.dungeons} dungeons across ${s.regions} regions); ${input.length} game (max level ${l.maxLevel}, ${l.arcs} story arcs).`,
    `NPC COMMUNICATION: ${['NPCs keep to themselves', 'news spreads to friends and family', 'news spreads through whole towns', 'news spreads across the world'][input.communication]}.`,
    `PARTY: ${input.combatMode === 'solo' ? 'the player adventures alone' : input.combatMode === 'party_manual' ? 'the player controls a party of up to four' : 'the player can recruit NPC companions'}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Rules context attached to the concept once the ruleset exists (names the prompts should use). */
export type ConceptWithRules = ConceptOut & { _rules?: string };

export function rulesContext(r: Ruleset): string {
  const t = r.terminology;
  return `Terms: health="${r.health.name}", currency="${t.currency}", town="${t.town}", dungeon="${t.dungeon}", wilderness="${t.wilderness}", quest="${t.quest}", party="${t.party}". Classes: ${r.classes.map((c) => c.name).join(', ')}. Damage kinds: ${[...r.damageTypes.map((x) => x.name), ...r.subtypes.map((x) => x.name)].join(', ')}.`;
}

export function conceptSummary(c: ConceptWithRules): string {
  return [
    `WORLD: "${c.title}" — ${c.pitch}`,
    `Genre: ${c.genre}. Tone: ${c.tone}. The player is ${c.playerRole}.`,
    `Antagonist: ${c.villain.name}, ${c.villain.title} — ${c.villain.motive}`,
    `Hidden truth (for consistency, never state openly): ${c.secret}`,
    c._rules ?? '',
    c.factions.length ? `Factions: ${c.factions.map((f) => `${f.name} (${f.description})`).join('; ')}` : '',
    c.worldFacts.length ? `Facts: ${c.worldFacts.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function conceptPrompt(input: WorldInput): string {
  return `${userBrief(input)}

Design the core concept of this world.
- "artStyle": comma-separated keywords for a consistent illustrated look (medium, palette, lighting, mood).
- "intro": 80-150 words of second-person opening narration that hooks the player without revealing the secret.
- "secret": the twist the main story slowly reveals.
- 6-12 "worldFacts" NPCs might know (history, customs, rumors).`;
}

function slotLine(s: ZoneSlot, sk: WorldSkeleton): string {
  return `- ${s.slotId}: ${s.kind}, region ${s.regionIndex}, levels ${s.levelRange[0]}-${s.levelRange[1]}, connects to ${s.links.join(', ')}`;
}

/** How a zone's level design is described (shared by world creation and the studio). */
export const LAYOUT_HELP = `"layout" is your level design for the zone, in neutral terms the engine builds from. Picture the place and choose what makes it feel like itself:
- "structure": "open" (free-form ground), "grid" (blocks between straight lanes or aisles), "hub" (a centre with enterable structures around it), "rooms" (chambers joined by corridors), "caves" (irregular connected hollows). Towns use hub or grid; wildernesses use open or grid; dungeons use rooms or caves.
- "enclosed": true when it is under a roof or ceiling (no sky, no weather), false under the open sky.
- "blockers": the large impassable things that shape movement there: "amount" (sparse, some, dense) and "arrangement" (scattered, clusters, rows, edges).
- "hazard": impassable liquid, chasm or void: none, pools, river or channels.
- "structures": how a town's enterable places look from outside: "roofed" (buildings with roofs) or "walled" (rooms and enclosures seen from above, like suites, stalls or tents).
- "clutter": sparse, some or dense small objects.
Every zone is its own place: within one world, one zone might be a dense grid of rows under a roof and the next an open expanse with a river. Think about what this specific zone is, not the genre.`;

export function atlasPrompt(input: WorldInput, concept: ConceptOut, sk: WorldSkeleton): string {
  return `${conceptSummary(concept)}

${userBrief(input)}

The engine has laid out the world map. Name and describe every region and every zone slot below (use the exact slotIds). Regions get harder from 0 to ${sk.regions.length - 1}.
Regions: ${sk.regions.map((r) => `${r.index} (levels ${r.levelRange[0]}-${r.levelRange[1]})`).join(', ')}
Zone slots:
${sk.slots.map((s) => slotLine(s, sk)).join('\n')}

"town" = a safe settlement/hub (in this setting it could be a village, station, burrow, office floor...). "wilderness" = open travel country between places. "dungeon" = a dangerous enclosed place (cave, derelict ship, crypt, server room...).
"biome" sets the ground look: grass, dirt, stone, sand, snow, wood, metal, crystal, flesh, void.
${LAYOUT_HELP}
"lore" is a private note about the zone's history and secrets that NPCs may reference.`;
}

export function storyPrompt(input: WorldInput, concept: ConceptOut, atlas: AtlasOut, sk: WorldSkeleton, familyNames: string[]): string {
  const zoneName = (id: string) => atlas.zones.find((z) => z.slotId === id)?.name ?? id;
  return `${conceptSummary(concept)}

${userBrief(input)}

ZONES (slotId: name — kind, region, levels):
${sk.slots.map((s) => `- ${s.slotId}: ${zoneName(s.slotId)} — ${s.kind}, region ${s.regionIndex}, levels ${s.levelRange[0]}-${s.levelRange[1]}`).join('\n')}
MONSTER FAMILIES: ${familyNames.join(', ')}

Write the MAIN STORYLINE as exactly ${sk.arcs} arcs. Arc i should mostly take place in region ${sk.regions.length > 1 ? `round(i*${sk.regions.length}/${sk.arcs})` : '0'} so difficulty rises with the story. The story must evolve: early arcs should seem like one kind of problem, and each arc's "revelation" reframes what came before, building to the hidden truth. The final arc ends by defeating the final boss (the antagonist or what they became).

Define the cast first, then reference them by "key":
- keyNpcs (3-8): story characters who live in towns (townSlot must be a town slot). The first quest's giver should live in ${zoneName(sk.startSlot)} (${sk.startSlot}).
- bosses (one per arc, the last is the final boss): each lives in a dungeon slot.
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

${userBrief(input)}

Create ${count} distinct families of hostile creatures/opponents for this world (in a comedy they can be silly; in a cozy tale they are mischievous rather than gory).
Each family has 2-5 members, each with a different combat archetype: ${MONSTER_ARCHETYPES.map((a) => `${a} (${ROLE_VISUAL[a].name.toLowerCase()})`).join(', ')}.
"element" is the family's damage affinity — one of: ${damageKinds.join(', ')}; "habitat" lists where they live (words like town, forest, cave, swamp, ruins, mountain, snow, desert, station, derelict, lab...); "colors" are 1-4 hex colors for their look; "appearance" is a short visual description used to draw each member.`;
}

export const TILESET_HELP = `A tileset describes how a zone looks. "style" is the base material: grass, dirt, stone, sand, snow, wood, metal, crystal, flesh, void. "ambient" is brightness 0-1 (dungeons ~0.3, indoors ~0.7, outdoors 1). "weather": none, rain, snow, ash, spores, embers, dust, fireflies.
"roles" gives each fixed tile role a setting-appropriate name, 1-3 hex colors and a short visual prompt (no art-style words):
floor (main ground), floorAlt (secondary ground patches), path (lanes, roads or corridors), water (impassable liquid, chasm or void), wall (the walls of structures, rooms or caves), tree (the large impassable thing that shapes movement here), rock (a smaller blocking object), plant (small walkable decoration), light (light source), furniture (furnishing or equipment), rubble (debris), pillar (column or post), door, chest (a container that holds loot), exit (way to another area), shrine (where the weary are restored), sign, lever (a switch or control), bed (somewhere to rest). Name each for what it is in this place: a forest's tree is a tree, an office's could be a cubicle partition, a garage's a parked car, a bathroom's a row of stalls.`;

export function townPrompt(
  input: WorldInput,
  concept: ConceptOut,
  town: { name: string; description: string; lore?: string; level: number; region: string },
  ctx: { npcCount: number; sideQuests: number; keyNpcs: string[]; nearbyZones: string[]; families: string[]; companions: boolean; requiredRoles: string[] },
): string {
  return `${conceptSummary(concept)}

${userBrief(input)}

TOWN: ${town.name} (region ${town.region}, around level ${town.level}) — ${town.description}${town.lore ? `\nPrivate lore: ${town.lore}` : ''}
Story characters already living here: ${ctx.keyNpcs.length ? ctx.keyNpcs.join('; ') : 'none'}.
Nearby places: ${ctx.nearbyZones.join(', ')}. Local threats: ${ctx.families.join(', ')}.

Create:
1. "npcs": ${ctx.npcCount} additional residents (do not repeat the story characters). These roles are required, each as its own resident (one person per role): ${ctx.requiredRoles.join(', ')}${ctx.companions ? ', companion' : ''} (these are game functions; give them titles, trades and greetings that fit this world, e.g. a capsule-hotel manager rather than an innkeeper on a space station); fill the rest with commoners, guards, crafters, nobles or mystics. Merchants need a merchantKind (general, weapons, armor, alchemy, magic, materials).${ctx.companions ? ' Mark 1-2 adventurous characters canJoinParty=true (role companion).' : ''} Give each a real personality, a want, 1-4 things they know ("knowledge", gossip that connects to the world), optional secrets, a speaking "voice", a greeting line and 2-3 short ambient barks. "friends" lists names of other residents they talk to.
2. "buildings": names for the town's buildings (inn, shops, homes) with their purpose.
3. "sideQuests": ${ctx.sideQuests} local side quests given by residents (giverName must be one of your npcs or story characters). Objective types: talk/persuade (target = person's name), kill (target = monster family name, with count), collect (target = item name to find, it will be hidden nearby), deliver (target = person to give the collected item to), reach (target = place name), interact (target = place name; describe the thing). Make them human and specific; some should have a twist or a choice in the final conversation.
4. "tileset": the look of the town's main area (its streets and squares, or its concourse, lobby or deck if it is indoors). "interiorTileset": how its rooms, shops and buildings look inside.
5. "signText": the text on the sign at the town entrance.

${TILESET_HELP}`;
}

export function areaPrompt(input: WorldInput, concept: ConceptOut, zone: { name: string; kind: string; description: string; lore?: string; level: [number, number]; families: string[] }, loreCount: number): string {
  return `${conceptSummary(concept)}

ZONE: ${zone.name} — a ${zone.kind}, levels ${zone.level[0]}-${zone.level[1]}. ${zone.description}${zone.lore ? `\nPrivate lore: ${zone.lore}` : ''}
Creatures here: ${zone.families.join(', ')}.

Create:
1. "tileset" for this zone's look.
2. "loreNotes": ${loreCount} readable documents found here (journals, carvings, logs, letters...) that hint at the world's history and the main story without spelling out the secret. 60-160 words each, in-world voice.
3. "shrineName": what the restorative shrine/altar here is called.

${TILESET_HELP}`;
}
