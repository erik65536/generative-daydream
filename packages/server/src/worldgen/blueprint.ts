/**
 * Floor plans: the level designer (an LLM) plans each place as areas with a purpose (a server room, a break
 * room, a campsite), the specific props that furnish them and how they are set out. The architect builds the
 * map from it; the art pipeline paints each prop and surface.
 */
import { z } from 'zod';
import { MAX_PROPS, MAX_SURFACES, slugify, type Blueprint, type GroundDef, type PropDef, type WorldDefinition, type ZoneDef } from '@gd/shared';
import { genai } from '../genai/service';
import { conceptSummary, SYSTEM } from './prompts';
import { normColors } from './schemas';

const str = (max: number, min = 1) => z.string().trim().min(min).max(max);
const id = z.string().trim().min(1).max(40).describe('short lowercase id, e.g. "desk"');
const PATTERNS = ['rows', 'grid', 'along_walls', 'around', 'cluster', 'scatter', 'center', 'corners', 'line', 'ring'] as const;
const AMOUNTS = ['few', 'some', 'many'] as const;

const Arrangement = z.object({
  prop: id,
  pattern: z.enum(PATTERNS),
  amount: z.enum(AMOUNTS),
  with: id.optional().describe('a second prop set beside each copy, e.g. a chair at each desk'),
});

export const BlueprintSchema = z.object({
  summary: str(400).describe('One or two sentences: how this place is organised and why'),
  style: z.enum(['built', 'natural']),
  surfaces: z.array(z.object({ id, name: str(50), colors: z.array(z.string().max(24)).max(3), prompt: str(220) })).max(4),
  props: z.array(z.object({
    id,
    name: str(50),
    colors: z.array(z.string().max(24)).max(3),
    prompt: str(240),
    size: z.enum(['1', '2']).describe('footprint in tiles: 1 (a desk, a barrel, a tree) or 2 (2x2: a big table, a car, a fountain)'),
    height: z.enum(['low', 'mid', 'tall']).describe('low: knee height or less (a chair, a crate, a bin); mid: waist to chest (a desk, a counter, a water cooler, a barrel); tall: taller than a person (a server rack, a bookcase, a tree, a lamp post)'),
    blocks: z.boolean(),
    light: z.boolean().optional(),
  })).min(5).max(22),
  corridors: id.describe('ground of corridors, lanes or trails: "path" or one of your surface ids'),
  corridorProps: z.array(Arrangement).max(3),
  groundCover: z.array(id).max(4).describe('ids of small walkable props (low, blocks false) scattered thinly over all the ground: reeds, grass tufts, pebbles, fallen leaves, litter, loose papers'),
  between: z.enum(['filler', 'water', 'open']).optional().describe('natural places: what lies between the areas: dense filler (forest, rock), water (islands, a flooded marsh: trails become causeways), or open ground with a little filler'),
  filler: id.optional().describe('natural places: the prop that fills the ground between areas (trees, rocks); built places outdoors: what lines the edge'),
  areas: z.array(z.object({
    id,
    name: str(60),
    purpose: str(200),
    count: z.number().int().min(1).max(6),
    size: z.enum(['small', 'medium', 'large']),
    floor: id.describe('"floor", "floorAlt", "path", "water" (a pond, pool or flooded area: impassable) or one of your surface ids'),
    enclosure: z.enum(['walled', 'open']),
    where: z.enum(['entrance', 'center', 'edge', 'deep', 'any']),
    building: str(80).optional().describe('towns: the exact name of the enterable building this area holds'),
    gathering: z.boolean().optional(),
    arrangements: z.array(Arrangement).max(5),
  })).min(3).max(14),
});
export type BlueprintOut = z.infer<typeof BlueprintSchema>;

const BLUEPRINT_SYSTEM = `${SYSTEM}

You are now the level designer of one place. You plan it as a real architect, set dresser or landscape designer would: what parts it has, what each part is for, and exactly which things furnish each part and how they are set out, so the place reads at a glance as what it is and tells a little of its story.

The map is a square grid of tiles seen from above at an angle (isometric); a person fills one tile. The engine builds your plan:
- "built" style: the floor is cut into rectangular areas by straight corridors; every area opens onto a corridor. Use it for buildings, offices, ships, stations, dungeons, streets and yards.
- "natural" style: areas are organic regions (clearings, groves, banks, camps) in a mass of "filler" (dense trees, rock), joined by winding trails. Use it for wild country.
- Each area has its own floor ("floor", "floorAlt", "path" are the place's own ground; or define up to 4 extra "surfaces": carpet for offices, tiles for a kitchen, gravel for a yard), and is "walled" (walls with doorways: a room) or "open" (set apart only by its floor and furniture).
- "where" places the area: near the entrance, in the center, at the edge, deep inside (far from the entrance), or anywhere.
- Arrangements set out copies of a prop in the area: rows (parallel rows with aisles: desks, pews, shelving, beds in a ward, crops), grid (evenly spaced: columns, tables in a hall), along_walls (lining the walls: shelves, cabinets, crates), around (a centrepiece with "with" props around it: a table with chairs, a fire with logs), cluster (a few clumps), scatter (spread out), center (one centrepiece), corners, line (a counter or bar across the area), ring (around the inside: columns of a hall). "with" adds a second prop beside each copy (a chair at each desk, a stool at the bar). "few" is one to three pieces (centrepieces, special items), "some" is a fair number for the area's size, "many" fills the area in its pattern (an office's desks, a library's shelves, a forest's trees).
- Props are specific, physical things that stand in this place, each painted as its own image, seen from above at an angle. Size 1 is one tile; size 2 is a 2x2 block for big things. "blocks": people must walk around it (furniture, machines, trees) or not (a chair, a pile of papers, a rug-like thing). "tall" things above head height also block sight. "light": it gives off light (lamps, braziers, glowing screens).

Good plans:
- 6-12 areas (count copies: four identical meeting rooms are one area with count 4). Every area has a clear purpose for the place; mix big working areas with small special rooms. On a map of about 60 tiles across, a small area is roughly 8x8 tiles, a medium one 12x12, a large one 18x18 or more: furnish them for that size.
- Furnish every area fully, the way the real thing looks in use: 2-4 arrangements per area, its main furniture usually "many" or "some" (an office is full of desks, a warehouse of racks, a camp of tents), supporting pieces "some", centrepieces "few". An area with only one or two things in it reads as empty.
- 10-20 props, each specific to this place (never generic "furniture"), described by their look: shape, materials, colours, wear. No text, letters or logos on anything.
- Leave about half of every area walkable: people meet, talk and fight there. A room is never solid furniture.
- Water belongs where the place has it: a harbour's basin, a river, a canal, a pond, a flooded hall is an area with floor "water" (people cross it on the corridors, trails or causeways the engine lays).
- Give 2-3 kinds of ground cover (small walkable props: reeds, tufts, pebbles, litter, loose papers) so no ground looks bare; outdoors this matters most.
- Corridors and lanes get a few corridor props (planters, bins, benches, lamp posts) at most.
- Light comes from things that stand on the ground in this place (a floor lamp, a lamp post, a brazier, a glowing terminal, a campfire). Ceiling and wall fixtures cannot be shown, so never make them props. A few lights per place are enough.
- A tile is about one metre across. Size 2 (2x2 metres) is only for big things: a car, a large table, a fountain, a big machine, a tent. A fridge, a desk, a bookcase or a bed is size 1.
- Surfaces are materials the engine tiles across whole areas: describe one continuous material seen from above with fine, even detail and mid-tone colours (marble with soft veining, low-pile carpet, packed sand). Never lines, strips, borders, markings, grids of large tiles, arrows or shapes across it, and never objects on it.
- Every prop stands on the ground by itself. Things that sit on or hang from other things (a monitor on a desk, books on a shelf, a lamp on a table, a sign on a wall) are part of that thing's look, described in its prompt, never props of their own.
- Use each prop where it belongs: a water cooler or a lamp in one or two spots, not in every area. Landmarks (a reception desk, an elevator bank, a stage, a fountain) are what make an area recognisable: give important areas one.
- "around" puts the "with" props around the centre prop: give a table "with" chairs; never make the chairs the centre.
- Areas that are mostly open floor (halls, lobbies, landings, clearings) are small or medium; only areas full of furniture are large.
- Prefer variety between areas: their floors, furniture and layout should make each one recognisable.`;

/** What the plan must work with: the place, its size, its buildings. */
export function blueprintPrompt(w: WorldDefinition, z: ZoneDef, opts: { size: number; buildings: string[]; guidance?: string; revise?: { design: PlaceDesign; notes: string[] } }): string {
  const ts = w.tilesets[z.tilesetId];
  const enclosed = z.kind === 'dungeon' || !!z.indoor || !!z.layout?.enclosed;
  const linked = z.links.map((l) => w.zones.find((x) => x.id === l)?.name).filter(Boolean);
  const people = w.npcs.filter((n) => n.zoneId === z.id).map((n) => `${n.name} (${n.title})`);
  return `${conceptSummary(w.concept as never)}

PLACE: ${z.name}, a ${z.kind === 'wilderness' ? 'travel area between places' : z.kind}: ${z.description}
${z.lore ? `Its history: ${z.lore}\n` : ''}${enclosed ? 'It is enclosed (under a roof or underground); its outer edge is wall.' : 'It is under the open sky.'}
Its ground: floor is "${ts?.roles.floor.name ?? 'floor'}", floorAlt is "${ts?.roles.floorAlt.name ?? 'worn floor'}", path is "${ts?.roles.path.name ?? 'path'}", walls are "${ts?.roles.wall.name ?? 'wall'}".
The map is ${opts.size}x${opts.size} tiles.${linked.length ? ` It leads to: ${linked.join(', ')}.` : ''}
${z.kind === 'dungeon' ? 'It is a dangerous place full of hostile creatures: its areas are chambers joined by corridors (built style, all walled); the deepest one holds its master. Give it an entrance area and a deep area.\n' : ''}${z.kind === 'wilderness' ? 'Monsters roam it in packs; it may hold a way down to a dungeon (give one area that would hold it: a stairwell, a hatch, a cave mouth).\n' : ''}${opts.buildings.length ? `ENTERABLE BUILDINGS (each must be the "building" of exactly one area, with its exact name; the area around it is its frontage or yard): ${opts.buildings.join('; ')}\nAlso give the town a central gathering area where people spend their time.\n` : ''}${people.length ? `People here: ${people.slice(0, 12).join(', ')}.\n` : ''}${opts.guidance ? `\nTHE OWNER'S DIRECTION FOR THIS PLACE (follow it closely): ${opts.guidance}\n` : ''}${opts.revise ? revision(opts.revise) : "\nDesign the place's floor plan."}`;
}

/** The plan as built and what a review of it found, for a revision that keeps what is already painted. */
function revision(r: { design: PlaceDesign; notes: string[] }): string {
  const current = {
    ...r.design.blueprint,
    props: r.design.props.map(({ asset: _a, ...p }) => ({ ...p, size: String(p.size) })),
    surfaces: r.design.surfaces.map(({ asset: _a, ...s }) => s),
  };
  return `
ITS CURRENT FLOOR PLAN (already built and painted):
${JSON.stringify(current)}

A REVIEW OF HOW IT LOOKS IN THE GAME found these problems:
${r.notes.map((n) => `- ${n}`).join('\n')}

Revise the floor plan to fix them. Keep the props and surfaces that work exactly as they are (same id, name and prompt: they are already painted); change or add only what the fixes need.`;
}

/** Problems with a plan the model must fix (unknown ids, missing buildings). */
export function blueprintProblems(out: BlueprintOut, buildings: string[]): string | null {
  const props = new Set(out.props.map((p) => p.id));
  const grounds = new Set(['floor', 'floorAlt', 'path', 'water', ...out.surfaces.map((s) => s.id)]);
  const bad: string[] = [];
  for (const a of out.areas) {
    if (!grounds.has(a.floor)) bad.push(`area "${a.id}" floor "${a.floor}" is not a surface`);
    for (const r of a.arrangements) {
      if (!props.has(r.prop)) bad.push(`area "${a.id}" uses unknown prop "${r.prop}"`);
      if (r.with && !props.has(r.with)) bad.push(`area "${a.id}" uses unknown prop "${r.with}"`);
    }
  }
  if (!grounds.has(out.corridors)) bad.push(`corridors "${out.corridors}" is not a surface`);
  if (out.filler && !props.has(out.filler)) bad.push(`filler "${out.filler}" is not a prop`);
  for (const g of out.groundCover) if (!props.has(g)) bad.push(`ground cover "${g}" is not a prop`);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const missing = buildings.filter((b) => !out.areas.some((a) => a.building && norm(a.building) === norm(b)));
  if (missing.length) bad.push(`these buildings have no area: ${missing.join('; ')}`);
  return bad.length ? bad.slice(0, 8).join('; ') : null;
}

export interface PlaceDesign {
  blueprint: Blueprint;
  props: PropDef[];
  surfaces: GroundDef[];
}

/** Turn the model's plan into the world's data (ids made safe, sizes in range, references kept consistent). */
export function toDesign(out: BlueprintOut, kind: ZoneDef['kind']): PlaceDesign {
  const safe = (s: string) => slugify(s).slice(0, 30) || 'x';
  const props: PropDef[] = [];
  const seen = new Set<string>();
  for (const p of out.props.slice(0, MAX_PROPS)) {
    const pid = safe(p.id);
    if (seen.has(pid)) continue;
    seen.add(pid);
    props.push({ id: pid, name: p.name, prompt: p.prompt, colors: normColors(p.colors).length ? normColors(p.colors) : ['#808080'], size: p.size === '2' ? 2 : 1, height: p.height, blocks: p.blocks, ...(p.light ? { light: true } : {}) });
  }
  const surfaces: GroundDef[] = out.surfaces.slice(0, MAX_SURFACES).map((s) => ({ id: safe(s.id), name: s.name, prompt: s.prompt, colors: normColors(s.colors).length ? normColors(s.colors) : ['#808080'] }));
  const g = (v: string) => (v === 'floor' || v === 'floorAlt' || v === 'path' || v === 'water' ? v : safe(v));
  const arr = (r: BlueprintOut['corridorProps'][number]) => ({ prop: safe(r.prop), pattern: r.pattern, amount: r.amount, ...(r.with ? { with: safe(r.with) } : {}) });
  return {
    props,
    surfaces,
    blueprint: {
      summary: out.summary,
      style: kind === 'dungeon' || kind === 'town' ? 'built' : out.style,
      corridors: g(out.corridors),
      ...(out.filler ? { filler: safe(out.filler) } : {}),
      ...(out.between ? { between: out.between } : {}),
      corridorProps: out.corridorProps.map(arr),
      groundCover: out.groundCover.map(safe).filter((x) => props.some((p) => p.id === x)),
      areas: out.areas.map((a) => ({
        id: safe(a.id), name: a.name, purpose: a.purpose, count: a.count, size: a.size, floor: g(a.floor), enclosure: a.enclosure, where: a.where,
        arrangements: a.arrangements.map(arr),
        ...(a.building ? { building: a.building } : {}),
        ...(a.gathering ? { gathering: true } : {}),
      })),
    },
  };
}

/** Ask the level designer for a place's floor plan. */
export async function designBlueprint(w: WorldDefinition, z: ZoneDef, opts: { size: number; buildings: string[]; guidance?: string; revise?: { design: PlaceDesign; notes: string[] } }): Promise<PlaceDesign> {
  const base = blueprintPrompt(w, z, opts);
  let problem = '';
  for (let attempt = 1; ; attempt++) {
    const out = await genai().structured('world.design', {
      system: BLUEPRINT_SYSTEM,
      prompt: problem ? `${base}\n\nAN EARLIER ANSWER WAS REJECTED: ${problem}\nAnswer again in full, fixing that.` : base,
      schema: BlueprintSchema,
      name: 'floor_plan',
      maxTokens: 7000,
    });
    const bad = blueprintProblems(out, opts.buildings);
    if (!bad || attempt >= 3) return toDesign(out, z.kind);
    problem = bad;
  }
}
