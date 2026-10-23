/**
 * Where everything goes in a read map: numbered candidate spots (entrances, ways out at the edge, landmarks, open
 * ground spread evenly), and Luna, looking at them on the map, decides where every building, way out, person and
 * thing goes.
 */
import sharp from 'sharp';
import { z } from 'zod';
import { genai } from '../genai/service';
import type { Grid } from './mapgrid';
import type { Spot } from './mapread';

/** What a place must hold. Ids are the world's own (feature, NPC ids); placement answers per id. */
export interface PlaceNeeds {
  name: string;
  description: string;
  buildings: { id: string; name: string; purpose: string }[];
  /** Ways out. `into`: a way through something in the map (a cave mouth, stairs down, a room's door), not across the edge. */
  exits: { id: string; to: string; into?: boolean }[];
  /** `works`: the building they work in (they stand outside its entrance). */
  people: { id: string; name: string; title: string; role: string; works?: string }[];
  things: { id: string; what: string }[];
}

/** A read map, ready to be furnished: the picture, its plan and its spots (picture px). */
export interface MapReading {
  /** Picture size (px) and the ground it covers (m). */
  width: number;
  height: number;
  X: number;
  Y: number;
  grid: Grid;
  /** Per plan cell: walkable (the main region, clearance included) and see-through. */
  walk: Uint8Array;
  sight: Uint8Array;
  doors: Spot[];
  /** Ways out at the edge, labelled by side. */
  edges: Spot[];
  landmarks: Spot[];
  /** Walkable ground (m²). */
  area: number;
}

/** Picture pixels per ground metre. */
export const pxPerMetre = (r: MapReading) => r.width / r.X;

/** A numbered spot Luna can choose: D entrance, E way out, L landmark, P open ground. */
export interface Candidate {
  id: string;
  x: number;
  y: number;
  what: string;
  building?: number;
}

/**
 * The spots: entrances, ways out and landmarks, plus open ground spread evenly over the walkable area (farthest-point
 * sampling). Markers must not cover each other in the view Luna sees.
 */
export function candidates(r: MapReading, open = 24): Candidate[] {
  const gap = (2.2 * r.width) / 55;
  const out: Candidate[] = [
    ...r.doors.map((d, i) => ({ id: `D${i + 1}`, x: d.x, y: d.y, what: `entrance (${d.label})${d.building ? `, building B${d.building}` : ''}`, building: d.building })),
    ...r.edges.map((e, i) => ({ id: `E${i + 1}`, x: e.x, y: e.y, what: `way out at the ${e.label} edge` })),
  ];
  let ln = 0;
  for (const l of r.landmarks) if (out.every((c) => Math.hypot(c.x - l.x, c.y - l.y) >= gap)) out.push({ id: `L${++ln}`, x: l.x, y: l.y, what: l.label });
  const kx = r.width / r.grid.cols, ky = r.height / r.grid.rows;
  const pts: [number, number][] = [];
  for (let i = 0; i < r.walk.length; i += 7) if (r.walk[i]) pts.push([((i % r.grid.cols) + 0.5) * kx, (Math.floor(i / r.grid.cols) + 0.5) * ky]);
  const dist = pts.map(([x, y]) => out.reduce((m, c) => Math.min(m, Math.hypot(x - c.x, y - c.y)), Infinity));
  for (let n = 1; n <= open && pts.length; n++) {
    let k = 0;
    for (let i = 1; i < pts.length; i++) if (dist[i]! > dist[k]!) k = i;
    if (dist[k]! < gap) break;
    const [x, y] = pts[k]!;
    out.push({ id: `P${n}`, x: Math.round(x), y: Math.round(y), what: 'open ground' });
    for (let i = 0; i < pts.length; i++) dist[i] = Math.min(dist[i]!, Math.hypot(pts[i]![0] - x, pts[i]![1] - y));
  }
  return out;
}

const SPOT_COLOUR: Record<string, string> = { D: '#ffd400', E: '#4db8ff', L: '#ff7ad9', P: '#ffffff' };

/** The map with every candidate as a large labelled marker (sized for a downscaled view). */
export async function candidateView(png: Buffer, cands: Candidate[], width = 1600): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const k = width / meta.width!, h = Math.round(meta.height! * k), R = width / 55;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}">${cands
    .map((c) => {
      const fs = c.id.length > 2 ? R * 0.75 : R * 0.9;
      return `<g><circle cx="${c.x * k}" cy="${c.y * k}" r="${R}" fill="${SPOT_COLOUR[c.id[0]!] ?? '#fff'}" stroke="#000" stroke-width="${R / 7}"/><text x="${c.x * k}" y="${c.y * k + fs * 0.36}" font-size="${fs}" font-family="Arial" font-weight="bold" text-anchor="middle" fill="#000">${c.id}</text></g>`;
    })
    .join('')}</svg>`;
  return sharp(png).resize(width).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toBuffer();
}

const PlacementSchema = z.object({
  assign: z.array(z.object({ id: z.string(), spot: z.string(), why: z.string().max(160) })),
  problems: z.array(z.string().max(200)).max(5).describe('Anything the place needs that this map cannot provide'),
});

export interface Placement {
  /** Need id → chosen candidate. */
  spots: Map<string, Candidate>;
  problems: string[];
}

/** Luna looks at the numbered spots and decides where every building, way out, person and thing goes. */
export async function place(png: Buffer, n: PlaceNeeds, cands: Candidate[]): Promise<Placement> {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const kind = (s: string) => s[0];
  const doorCount = cands.filter((c) => kind(c.id) === 'D').length;
  // Where a way out can go: the edge (E), or for a way through something in the map a doorway or landmark (D, L);
  // when the map has no such spot, the most fitting open ground will do.
  const has = (k: string) => cands.some((c) => kind(c.id) === k);
  const wayOut = (into?: boolean) => (into ? (has('D') || has('L') ? 'DLP' : 'P') : has('E') ? 'E' : 'EDLP');
  const list = (title: string, items: { id: string; text: string }[]) => (items.length ? `${title}\n${items.map((i) => `  ${i.id}: ${i.text}`).join('\n')}\n` : '');
  const out = await genai().structured('world.design', {
    system: 'You are the level designer of a 2D top-down RPG. Each place is one top-down map; you decide where the game puts things in it. Judge only what you see.',
    prompt: `This map is ${n.name}: ${n.description}
The numbered circles are the spots the game can use: D = an entrance into a building or room, E = a way out at the edge of the map, L = a landmark, P = open ground.
${cands.map((c) => `${c.id}: ${c.what}`).join('\n')}

Assign a spot to each of these, as a level designer would (answer with their ids):
${list('Buildings, each the workplace of someone who stands outside it (one D spot each, all different; entrances with the same B number belong to one building: use two of them only where the map clearly shows separate units; a big building for an inn, a small one for a shop or workshop):', n.buildings.map((b) => ({ id: b.id, text: `${b.name} (${b.purpose})` })))}${list('Ways out (all different spots, of the kinds in brackets; an E spot leaves across the edge, a D, L or P spot is a way in such as a door, a cave mouth or stairs down):', n.exits.map((e) => ({ id: e.id, text: `${e.into ? 'through' : 'to'} ${e.to} [${wayOut(e.into).split('').join('/')}]` })))}${list('People (near their work, home or a fitting landmark; never on a D or E spot; spread them out; those who work in a building stand by its entrance, so any spot near it):', n.people.map((p) => ({ id: p.id, text: `${p.name}, ${p.title} (${p.role})${p.works ? `, works at ${p.works}` : ''}` })))}${list('Things (an L or P spot that suits each):', n.things.map((t) => ({ id: t.id, text: t.what })))}If something cannot be placed sensibly, leave it out and say why in problems.`,
    schema: PlacementSchema,
    name: 'place_placement',
    images: [await candidateView(png, cands)],
    maxTokens: 3000,
    validate: (p) => {
      const errs: string[] = [];
      const need = new Map<string, 'b' | 'x' | 'p' | 't'>([...n.buildings.map((b) => [b.id, 'b'] as const), ...n.exits.map((e) => [e.id, 'x'] as const), ...n.people.map((x) => [x.id, 'p'] as const), ...n.things.map((t) => [t.id, 't'] as const)]);
      const used = new Map<string, string>();
      for (const a of p.assign) {
        const c = byId.get(a.spot), t = need.get(a.id);
        if (!t) errs.push(`${a.id} is not on the list`);
        else if (!c) errs.push(`${a.spot} is not one of the numbered spots`);
        else if (t === 'b' && kind(a.spot) !== 'D') errs.push(`building ${a.id} needs a D spot`);
        else if (t === 'x' && !wayOut(n.exits.find((e) => e.id === a.id)?.into).includes(kind(a.spot)!)) errs.push(`way out ${a.id} needs a ${wayOut(n.exits.find((e) => e.id === a.id)?.into).split('').join(' or ')} spot`);
        else if ((t === 'p' || t === 't') && /[DE]/.test(kind(a.spot)!)) errs.push(`${a.id} cannot stand on an entrance or way out`);
        if ((t === 'b' || t === 'x') && used.has(a.spot)) errs.push(`${a.id} and ${used.get(a.spot)} share ${a.spot}`);
        if (t === 'b' || t === 'x') used.set(a.spot, a.id);
      }
      const placed = new Set(p.assign.map((a) => a.id));
      const exits = n.exits.filter((e) => !placed.has(e.id));
      if (exits.length) errs.push(`every way out needs a spot; missing: ${exits.map((e) => e.id).join(', ')}`);
      const buildings = n.buildings.filter((b) => placed.has(b.id)).length;
      if (buildings < Math.min(n.buildings.length, doorCount)) errs.push(`place every building there is an entrance for (${Math.min(n.buildings.length, doorCount)})`);
      return errs.length ? errs.slice(0, 6).join('; ') : null;
    },
  });
  return { spots: new Map(out.assign.map((a) => [a.id, byId.get(a.spot)!])), problems: out.problems };
}
