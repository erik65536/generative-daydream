/**
 * See how the reader reads saved paintings, without asking Luna anything (SAM and MoGe answers are disk-cached, so a
 * re-read takes seconds). For each painting: a contact sheet (candidate spots, colouring, every detection, MoGe
 * normals, height above the floor, structures/stairs/portals) and a text report of every detection and what became
 * of it. ComfyUI must be running.
 *
 * Usage: tsx src/cli/readpeek.ts <worldId> [zoneId[:seed] ...] [--out <dir>, default data/readpeek] [--edit <json>] [--save <run>] [--compare <run>]
 *   --edit '{"notWalkable":["water","tabletop"]}'  try other detector terms (fields replace the saved read's)
 *   --save before / --compare before              keep a run's numbers and colourings, then show what changed
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT_DIR } from '../paths';
import { loadWorld, worldDir } from '../storage';
import { normals } from '../worldgen/comfy';
import { Nav, pictureToGround } from '@gd/shared';
import { analyse, candidateView, candidates, colouring, type PaintingRead, type Reading } from '../worldgen/reading';
import { gameScale, groundOf } from '../worldgen/zones';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = opt('out') ?? path.join(ROOT_DIR, 'data', 'readpeek');
const edit = opt('edit') ? (JSON.parse(opt('edit')!) as Partial<PaintingRead>) : {};
const save = opt('save'), compare = opt('compare');
const [worldId, ...only] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!worldId) throw new Error('usage: readpeek <worldId> [zoneId[:seed] ...] [--out dir] [--edit json] [--save run] [--compare run]');
const places = path.join(worldDir(worldId), 'draft', 'places');
const kindOf = new Map(loadWorld(worldId)?.zones.map((z) => [z.id, z.kind]) ?? []);
fs.mkdirSync(out, { recursive: true });

/** Each panel is this wide on the sheet. */
const PW = 1200;
const KIND_COLOUR = { walkable: '#3cff6e', connector: '#ffa020', blocked: '#ff3c3c' } as const;

interface Summary {
  area: number;
  edges: number;
  doors: number;
  portals: number;
  landmarks: number;
  pxPerMetre: number;
}
const summarise = (r: Reading): Summary => ({ area: Math.round(r.area), edges: r.edges.length, doors: r.doors.length, portals: r.portals, landmarks: r.landmarks.length, pxPerMetre: +r.pxPerMetre.toFixed(1) });
const runDir = (run: string) => path.join(out, 'runs', run);
const saved: Record<string, Summary> = compare ? JSON.parse(fs.readFileSync(path.join(runDir(compare), 'summary.json'), 'utf8')) : {};
const summaries: Record<string, Summary> = {};

const svgText = (x: number, y: number, t: string, size = 26, fill = '#fff') =>
  `<text x="${x}" y="${y}" font-size="${size}" font-family="Arial" font-weight="bold" fill="${fill}" stroke="#000" stroke-width="${size / 6}" paint-order="stroke">${t.replace(/[<&>]/g, '')}</text>`;

async function panel(img: Buffer, caption: string, overlay = ''): Promise<Buffer> {
  const base = await sharp(img).resize(PW).png().toBuffer();
  const h = (await sharp(base).metadata()).height!;
  return sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${h}">${overlay}${svgText(12, 34, caption)}</svg>`) }]).png().toBuffer();
}

/** An RGBA raster over the analysis grid, scaled to the panel. */
async function raster(r: Reading, paint: (i: number) => [number, number, number, number] | undefined): Promise<Buffer> {
  const rgba = Buffer.alloc(r.aw * r.ah * 4);
  for (let i = 0; i < r.aw * r.ah; i++) {
    const c = paint(i);
    if (c) rgba.set(c, i * 4);
  }
  return sharp(rgba, { raw: { width: r.aw, height: r.ah, channels: 4 } }).resize(r.width, r.height).png().toBuffer();
}

async function sheet(png: Buffer, r: Reading): Promise<Buffer> {
  const k = PW / r.aw;
  const dim = await sharp(png).modulate({ brightness: 0.55, saturation: 0.4 }).png().toBuffer();
  const t = r.trace;

  // Detections: boxes coloured by kind, dashed where the detection was ignored (scene) or lost as a top.
  const dets = t.detections
    .map((d, n) => {
      const dash = typeof d.fate === 'number' ? (d.fate < 0.05 ? '4,6' : '') : '14,8';
      return `<rect x="${d.box.x * k}" y="${d.box.y * k}" width="${d.box.w * k}" height="${d.box.h * k}" fill="none" stroke="${KIND_COLOUR[d.kind]}" stroke-width="2.5" ${dash ? `stroke-dasharray="${dash}"` : ''}/>${svgText(d.box.x * k + 4, d.box.y * k + 18, `${n}`, 16, KIND_COLOUR[d.kind])}`;
    })
    .join('');

  // Height above the floor: blue below, red above, white level (±4 m of the reading's scale).
  const lift = await raster(r, (i) => {
    const v = Math.max(-1, Math.min(1, t.lift[i]! / 4));
    return v >= 0 ? [255, Math.round(255 * (1 - v)), Math.round(255 * (1 - v)), 255] : [Math.round(255 * (1 + v)), Math.round(255 * (1 + v)), 255, 255];
  });

  // Structures (purple), stairs and ramps (orange), entrances (yellow boxes) and the portals they made (cyan).
  const layers = await sharp(dim).composite([{ input: await raster(r, (i) => (t.ramp[i] ? [255, 150, 0, 170] : t.structures[i] ? [170, 60, 255, 80] : undefined)) }]).png().toBuffer();
  const doors = t.entrances
    .map((e) => `<rect x="${e.box.x * k}" y="${e.box.y * k}" width="${e.box.w * k}" height="${e.box.h * k}" fill="none" stroke="#ffe000" stroke-width="2.5"/>${e.portal ? `<line x1="${e.portal.x * k}" y1="${e.portal.y0 * k}" x2="${e.portal.x * k}" y2="${e.portal.y1 * k}" stroke="#00f0ff" stroke-width="6"/>` : ''}`)
    .join('');

  const panels = await Promise.all([
    panel(await candidateView(png, candidates(r), PW), 'candidate spots (D entrance, E edge, L landmark, P open)'),
    panel(await colouring(png, r, PW), 'colouring: green walk, yellow cut off, blue not flat, red blocked'),
    panel(dim, 'detections (# in the .txt): green walk, orange connector, red blocked; long dash ignored/top, short dash won nothing', dets),
    panel(await normals(png), 'MoGe normals'),
    panel(lift, 'height above floor (MoGe depth): red raised, blue sunk, ±4 m (tops ≥ 1.5)'),
    panel(layers, 'purple structure, orange stairs/ramps, yellow entrances, cyan portals', doors),
  ]);
  const hs = await Promise.all(panels.map(async (p) => (await sharp(p).metadata()).height!));
  const rowH = Math.max(...hs), gap = 8;
  return sharp({ create: { width: PW * 2 + gap, height: rowH * 3 + gap * 2, channels: 3, background: '#202020' } })
    .composite(panels.map((p, n) => ({ input: p, left: (n % 2) * (PW + gap), top: Math.floor(n / 2) * (rowH + gap) })))
    .jpeg({ quality: 84 })
    .toBuffer();
}

function report(name: string, r: Reading): string {
  const S = r.width / r.aw, m2 = (px: number) => (px * S * S) / r.pxPerMetre ** 2;
  const lines = [
    `${name}: ${Math.round(r.area)} m² walkable, ${r.edges.length} edge exits, ${r.doors.length} entrances, ${r.portals} portals, ${r.landmarks.length} landmarks`,
    `scale ${r.pxPerMetre.toFixed(1)} px/m (measured ${r.trace.measuredPxPerMetre ? r.trace.measuredPxPerMetre.toFixed(1) : 'nothing'} on "${r.read.scale.object}")`,
    `read: ${JSON.stringify(r.read)}`,
    '',
    '  #  kind       term                          m²   box (painting px)        fate',
  ];
  r.trace.detections.forEach((d, n) => {
    const fate = typeof d.fate === 'number' ? `won ${Math.round(d.fate * 100)}%` : d.fate === 'scene' ? 'IGNORED (covers the scene)' : 'LOST (top of a blocker)';
    const box = `${d.box.x * S | 0},${d.box.y * S | 0} ${d.box.w * S | 0}×${d.box.h * S | 0}`;
    lines.push(`${String(n).padStart(3)}  ${d.kind.padEnd(10)} ${d.term.slice(0, 28).padEnd(28)} ${m2(d.area).toFixed(0).padStart(5)}   ${box.padEnd(24)} ${fate}${d.slope !== undefined ? `, slope ${Math.round(d.slope * 100)}%${d.slope >= 0.25 ? ' (stairs/ramp)' : ''}` : ''}`);
  });
  lines.push('', 'entrances:');
  for (const e of r.trace.entrances) lines.push(`  ${e.box.x * S | 0},${e.box.y * S | 0} ${e.box.w * S | 0}×${e.box.h * S | 0}${e.portal ? `  portal x ${e.portal.x * S | 0}, y ${e.portal.y1 * S | 0} → ${e.portal.y0 * S | 0}` : ''}`);
  const spots = reach(r);
  lines.push('', `spots (on the game's navigation grid, game scale ${gameScale(r).toFixed(2)}; ${Math.round(spots.share * 100)}% of its walkable cells joined to the first):`, ...spots.map((s) => `  ${s.id} ${s.x},${s.y} ${s.what} ${s.ok}`));
  return lines.join('\n') + '\n';
}

/**
 * Doors, edge exits and landmarks as the game has them: on the navigation grid it walks on, each reachable from the
 * first (or how far off the grid it is).
 */
function reach(r: Reading) {
  const k = gameScale(r), g = groundOf(r, k), nav = new Nav(g.nav);
  const spots = candidates(r).filter((c) => c.id[0] !== 'P').map((c) => ({ ...c, at: nav.nearestWalkable(pictureToGround(c.x * k, c.y * k, g.ox, g.oy), 2) }));
  const from = spots.find((s) => s.at);
  const costs = from ? nav.reach(from.at!, 1e6) : new Map<number, number>();
  let cells = 0;
  for (let i = 0; i < nav.cols * nav.rows; i++) if (nav.walkableCell(i % nav.cols, Math.floor(i / nav.cols))) cells++;
  const out = spots.map((s) => {
    if (!s.at) return { ...s, ok: 'OFF the grid (no walkable cell within 2 m)' };
    const [cx, cy] = nav.cellOf(s.at.x, s.at.y);
    return { ...s, ok: costs.has(cy * nav.cols + cx) ? `reachable${s === from ? ' (start)' : ` (${Math.round(costs.get(cy * nav.cols + cx)!)} m)`}` : `NOT reachable from ${from!.id}` };
  });
  return Object.assign(out, { share: cells ? costs.size / cells : 0 });
}

const wanted = only.length ? only : fs.readdirSync(places);
for (const w of wanted) {
  const [zone, seedOnly] = w.split(':') as [string, string?];
  const dir = path.join(places, zone);
  if (!fs.existsSync(dir)) {
    console.log(`${zone}: no draft`);
    continue;
  }
  for (const f of fs.readdirSync(dir).filter((f) => /^read_\d+\.json$/.test(f))) {
    const seed = f.slice(5, -5);
    if (seedOnly && seedOnly !== seed) continue;
    const name = `${zone}_${seed}`;
    const read = { ...(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as PaintingRead), ...edit };
    const png = fs.readFileSync(path.join(dir, `canvas_${seed}.png`));
    const kind = kindOf.get(zone);
    if (!kind) {
      console.log(`${zone}: not in the world any more (its kind of place is unknown)`);
      break;
    }
    const r = await analyse(png, read, kind);
    fs.writeFileSync(path.join(out, `${name}.jpg`), await sheet(png, r));
    fs.writeFileSync(path.join(out, `${name}.txt`), report(name, r));
    const s = (summaries[name] = summarise(r));
    const grid = reach(r), stuck = grid.filter((x) => !x.ok.startsWith('reachable')).map((x) => x.id);
    const before = saved[name];
    const diff = before ? (Object.keys(s) as (keyof Summary)[]).filter((key) => s[key] !== before[key]).map((key) => `${key} ${before[key]}→${s[key]}`).join(', ') : '';
    console.log(`${name}: ${s.area} m², ${s.edges} edges, ${s.doors} entrances, ${s.portals} portals, ${s.landmarks} landmarks  grid ${Math.round(grid.share * 100)}% joined${stuck.length ? `  UNREACHABLE: ${stuck.join(' ')}` : ''}${compare ? (!before ? '  [not in that run]' : diff ? `  [changed: ${diff}]` : '  [same]') : ''}`);
    if (save) {
      fs.mkdirSync(runDir(save), { recursive: true });
      fs.writeFileSync(path.join(runDir(save), `${name}.jpg`), await colouring(png, r, PW));
    }
    // Before over after, for every reading that changed.
    const old = compare && path.join(runDir(compare), `${name}.jpg`);
    if (old && diff && fs.existsSync(old)) {
      const a = await sharp(old).resize(PW).png().toBuffer(), b = await panel(await colouring(png, r, PW), 'now');
      const ha = (await sharp(a).metadata()).height!, hb = (await sharp(b).metadata()).height!;
      const top = await panel(a, `run "${compare}"`);
      await sharp({ create: { width: PW, height: ha + hb + 8, channels: 3, background: '#202020' } }).composite([{ input: top, top: 0, left: 0 }, { input: b, top: ha + 8, left: 0 }]).jpeg({ quality: 84 }).toFile(path.join(out, `${name}_vs_${compare}.jpg`));
    }
  }
}
if (save) {
  const file = path.join(runDir(save), 'summary.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...summaries }, null, 1));
}
process.exit(0);
