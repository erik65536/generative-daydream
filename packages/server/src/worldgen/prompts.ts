/** Prompt text for each world-generation step. */
import {
  AFFIXES, ITEM_BASES, LENGTH_PROFILES, MONSTER_ARCHETYPES, ORIGINS, PLAYER_SKILL_IDS, RECIPES, SIZE_PROFILES, SKILLS, TRAP_KINDS, ARCHETYPES,
  type WorldInput,
} from '@gd/shared';
import type { ConceptOut, AtlasOut } from './schemas';
import type { WorldSkeleton, ZoneSlot } from './structure';

export const SYSTEM = `You are the lead world designer for "Generative Daydream", an engine for 2D isometric RPGs in the spirit of Baldur's Gate 2 and Diablo 2, with turn-based combat like Divinity: Original Sin 2.
The engine's mechanics are FIXED (zones, towns, dungeons, health, energy, skills, items, traps, quests). Your job is to give them names, descriptions, characters and story that fit the user's setting perfectly — whether that is high fantasy, a space adventure, a cozy animal tale, a surreal wonderland or an office comedy.
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
    `SCALE: ${input.size} world (${s.towns} towns, ${s.wilds} wilderness areas, ${s.dungeons} dungeons across ${s.regions} regions); ${input.length} game (max level ${l.maxLevel}, ${l.arcs} story arcs).`,
    `NPC COMMUNICATION: ${['NPCs keep to themselves', 'news spreads to friends and family', 'news spreads through whole towns', 'news spreads across the world'][input.communication]}.`,
    `PARTY: ${input.combatMode === 'solo' ? 'the player adventures alone' : input.combatMode === 'party_manual' ? 'the player controls a party of up to four' : 'the player can recruit NPC companions'}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function conceptSummary(c: ConceptOut): string {
  const t = c.terminology ?? {};
  return [
    `WORLD: "${c.title}" — ${c.pitch}`,
    `Genre: ${c.genre}. Tone: ${c.tone}. The player is ${c.playerRole}.`,
    `Antagonist: ${c.villain.name}, ${c.villain.title} — ${c.villain.motive}`,
    `Hidden truth (for consistency, never state openly): ${c.secret}`,
    `Terms: health="${t.health ?? 'Health'}", currency="${t.gold ?? 'Gold'}", town="${t.town ?? 'Town'}", dungeon="${t.dungeon ?? 'Dungeon'}", wilderness="${t.wilderness ?? 'Wilds'}", quest="${t.quest ?? 'Quest'}".`,
    c.factions.length ? `Factions: ${c.factions.map((f) => `${f.name} (${f.description})`).join('; ')}` : '',
    c.worldFacts.length ? `Facts: ${c.worldFacts.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function conceptPrompt(input: WorldInput): string {
  return `${userBrief(input)}

Design the core concept of this world.
- "terminology": rename the fixed mechanics so they feel native to the setting (1-3 words each). health/stamina/focus are the character's three bars (stamina powers physical skills, focus powers mental/magical ones); physArmor and magArmor are two protective pools that absorb physical and non-physical damage before health; gold is the currency; town/dungeon/wilderness are the three kinds of places; attributes are might, finesse, intellect, vitality, spirit, wits; schools are the 7 skill families; damageTypes are the 8 damage kinds.
- "systems": enable crafting / traps / lockpicking only if they fit; set dualEnergy=false if one energy bar suits the setting better.
- "artStyle": comma-separated keywords for a consistent illustrated look (medium, palette, lighting, mood).
- "intro": 80-150 words of second-person opening narration that hooks the player without revealing the secret.
- "secret": the twist the main story slowly reveals.
- 6-12 "worldFacts" NPCs might know (history, customs, rumors).`;
}

function slotLine(s: ZoneSlot, sk: WorldSkeleton): string {
  return `- ${s.slotId}: ${s.kind}, region ${s.regionIndex}, levels ${s.levelRange[0]}-${s.levelRange[1]}, connects to ${s.links.join(', ')}`;
}

export function atlasPrompt(input: WorldInput, concept: ConceptOut, sk: WorldSkeleton): string {
  return `${conceptSummary(concept)}

${userBrief(input)}

The engine has laid out the world map. Name and describe every region and every zone slot below (use the exact slotIds). Regions get harder from 0 to ${sk.regions.length - 1}.
Regions: ${sk.regions.map((r) => `${r.index} (levels ${r.levelRange[0]}-${r.levelRange[1]})`).join(', ')}
Zone slots:
${sk.slots.map((s) => slotLine(s, sk)).join('\n')}

"town" = a safe settlement/hub (in this setting it could be a village, station, burrow, office floor...). "wilderness" = open travel country between places. "dungeon" = a dangerous enclosed place (cave, derelict ship, crypt, server room...).
"biome" sets the ground look: grass, dirt, stone, sand, snow, wood, metal, crystal, flesh, void. Towns and wildernesses are outdoors; dungeons are enclosed.
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

export function skillsPrompt(concept: ConceptOut): string {
  return `${conceptSummary(concept)}

The engine has these pre-balanced skills (id — school — effect). Choose the ${Math.min(30, PLAYER_SKILL_IDS.length)} or fewer that make sense in this world (at least 16, keep all of them if they fit) and give each a setting-appropriate name and one-sentence flavor description. Do not change what they do.
${PLAYER_SKILL_IDS.map((id) => `- ${id} — ${SKILLS[id]!.school} — ${SKILLS[id]!.summary}`).join('\n')}

Also rename the six starting origins (id — default — combat style) for this setting and describe how such a character looks (appearance is used to draw them):
${ORIGINS.map((o) => `- ${o.id} — ${o.defaultName} — ${ARCHETYPES[o.archetype].defaultName.toLowerCase()} style`).join('\n')}`;
}

export function itemsPrompt(concept: ConceptOut): string {
  const bases = ITEM_BASES.filter((b) => b.category !== 'quest' && b.category !== 'key');
  return `${conceptSummary(concept)}

Rename every item base below so it fits this world (stats are fixed by the engine). For gear give 1-3 names from humble to impressive (used as the item gets higher level). Add a one-sentence description.
${bases.map((b) => `- ${b.id} (${b.category}${b.slot ? `, ${b.slot}` : ''}) default "${b.defaultName}"`).join('\n')}`;
}

export function affixPrompt(concept: ConceptOut): string {
  return `${conceptSummary(concept)}

Give setting-appropriate names to these item enchantment effects. "prefix" is an adjective placed before the item name, "suffix" starts with "of" and goes after it (e.g. prefix "Blazing", suffix "of Embers").
${AFFIXES.map((a) => `- ${a.id} (default "${a.defaultPrefix}" / "${a.defaultSuffix}")`).join('\n')}

Also name the trap kinds: ${TRAP_KINDS.join(', ')}.
And name the crafting recipes: ${RECIPES.map((r) => `${r.id} ("${r.defaultName}")`).join(', ')}.`;
}

export function familiesPrompt(input: WorldInput, concept: ConceptOut, count: number): string {
  return `${conceptSummary(concept)}

${userBrief(input)}

Create ${count} distinct families of hostile creatures/opponents for this world (in a comedy they can be silly; in a cozy tale they are mischievous rather than gory).
Each family has 2-5 members, each with a different combat archetype: ${MONSTER_ARCHETYPES.map((a) => `${a} (${ARCHETYPES[a].defaultName.toLowerCase()})`).join(', ')}.
"element" is the family's damage affinity; "habitat" lists where they live (words like town, forest, cave, swamp, ruins, mountain, snow, desert, station, derelict, lab...); "colors" are 1-4 hex colors for their look; "appearance" is a short visual description used to draw each member.`;
}

export const TILESET_HELP = `A tileset describes how a zone looks. "style" is the base material: grass, dirt, stone, sand, snow, wood, metal, crystal, flesh, void. "ambient" is brightness 0-1 (dungeons ~0.3, indoors ~0.7, outdoors 1). "weather": none, rain, snow, ash, spores, embers, dust, fireflies.
"roles" gives each fixed tile role a setting-appropriate name, 1-3 hex colors and a short visual prompt (no art-style words):
floor (main ground), floorAlt (secondary ground patches), path (roads/corridors), water (impassable liquid or chasm), wall (building/cave walls), tree (large blocking growth or structure), rock (small blocking object), plant (small walkable decoration), light (light source), furniture, rubble (debris), pillar, door, chest (container), exit (way to another area), shrine (restorative altar), sign, lever (switch), bed.`;

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
1. "npcs": ${ctx.npcCount} additional residents (do not repeat the story characters). Include these roles: ${ctx.requiredRoles.join(', ')}; fill the rest with commoners, guards, crafters, nobles or mystics. Merchants need a merchantKind (general, weapons, armor, alchemy, magic, materials).${ctx.companions ? ' Mark 1-2 adventurous characters canJoinParty=true (role companion).' : ''} Give each a real personality, a want, 1-4 things they know ("knowledge", gossip that connects to the world), optional secrets, a speaking "voice", a greeting line and 2-3 short ambient barks. "friends" lists names of other residents they talk to.
2. "buildings": names for the town's buildings (inn, shops, homes) with their purpose.
3. "sideQuests": ${ctx.sideQuests} local side quests given by residents (giverName must be one of your npcs or story characters). Objective types: talk/persuade (target = person's name), kill (target = monster family name, with count), collect (target = item name to find, it will be hidden nearby), deliver (target = person to give the collected item to), reach (target = place name), interact (target = place name; describe the thing). Make them human and specific; some should have a twist or a choice in the final conversation.
4. "tileset": the town's outdoor look. "interiorTileset": how its buildings look inside.
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
