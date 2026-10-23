/**
 * See how a world's places were made, from their saved steps (no model is asked anything): per map, a contact sheet
 * of the frame guide, the painted map with its view check, SAM's colouring, Qwen's walk plan, the arbitrated plan
 * (green open, red not) and the finished map after its repairs, with the reading's numbers.
 *
 * Usage: tsx src/cli/readpeek.ts <worldId> [zoneId ...] [--out <dir>, default data/readpeek]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { ROOT_DIR } from '../paths';
import { loadWorld, worldDir } from '../storage';
import { mapPixels } from '../worldgen/mapdraw';
import { CELL } from '../worldgen/mapgrid';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1]! : path.join(ROOT_DIR, 'data', 'readpeek');
const [worldId, ...only] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!worldId) throw new Error('usage: readpeek <worldId> [zoneId ...] [--out dir]');
const zones = new Map(loadWorld(worldId)?.zones.map((z) => [z.id, z]) ?? []);
const places = path.join(worldDir(worldId), 'draft', 'places');
fs.mkdirSync(out, { recursive: true });

/** Each panel is this wide on the sheet. */
const PW = 900;

async function panel(img: Buffer, label: string, overlay?: Buffer): Promise<Buffer> {
  let p = await sharp(img).resize({ width: PW }).png().toBuffer();
  if (overlay) {
    const meta = await sharp(p).metadata();
    const o = await sharp(overlay).resize(meta.width!, meta.height!, { fit: 'fill', kernel: 'nearest' }).greyscale().raw().toBuffer();
    const rgba = Buffer.alloc(o.length * 4);
    for (let i = 0; i < o.length; i++) rgba.set(o[i]! > 127 ? [40, 255, 90, 100] : [255, 40, 40, 90], i * 4);
    p = await sharp(p).composite([{ input: await sharp(rgba, { raw: { width: meta.width!, height: meta.height!, channels: 4 } }).png().toBuffer() }]).png().toBuffer();
  }
  const h = (await sharp(p).metadata()).height!;
  const t = `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${h}"><text x="10" y="30" font-size="24" font-family="Arial" font-weight="bold" fill="#fff" stroke="#000" stroke-width="5" paint-order="stroke">${label.replace(/[<&>]/g, '')}</text></svg>`;
  return sharp(p).composite([{ input: Buffer.from(t) }]).png().toBuffer();
}

for (const zone of fs.existsSync(places) ? fs.readdirSync(places) : []) {
  if (only.length && !only.includes(zone)) continue;
  const dir = path.join(places, zone);
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f)) : undefined);
  for (const f of fs.readdirSync(dir).filter((x) => /^map_\d+\.png$/.test(x)).sort()) {
    const seed = /\d+/.exec(f)![0];
    const map = read(f)!;
    const view = read(`view_${seed}.json`), made = read(`made_${seed}.json`);
    const v = view ? JSON.parse(view.toString()) : null;
    const rounds = fs.readdirSync(dir).filter((x) => new RegExp(`^map_${seed}_r\\d+\\.png$`).test(x)).sort();
    const panels: Buffer[] = [];
    const guide = read('guide.png');
    if (guide) panels.push(await panel(guide, 'frame guide'));
    panels.push(await panel(map, `map ${seed}: ${v ? `${v.angle}${v.detailed ? '' : ', not detailed'}` : 'not checked'}`));
    const classes = read(`classes_${seed}.jpg`);
    if (classes) panels.push(await panel(classes, 'SAM'));
    const qwen = read(`qwen_${seed}.png`), open = read(`open_${seed}.png`);
    if (qwen) panels.push(await panel(map, 'Qwen walk plan', qwen));
    if (open) panels.push(await panel(map, 'arbitrated', open));
    const last = rounds.at(-1);
    if (last) {
      const n = /_r(\d+)/.exec(last)![1];
      const plan = read(`open_${seed}_r${n}.bin`);
      const { X, Y } = mapPixels(zones.get(zone)?.kind ?? 'town');
      const cols = Math.round(X / CELL), rows = Math.round(Y / CELL);
      const mask = plan && cols * rows === plan.length ? await sharp(Buffer.from(plan.map((x) => (x ? 255 : 0))), { raw: { width: cols, height: rows, channels: 1 } }).png().toBuffer() : undefined;
      panels.push(await panel(read(last)!, `after repair round ${n}`, mask));
    }
    const hs = await Promise.all(panels.map(async (p) => (await sharp(p).metadata()).height!));
    const cols = 3, rowsN = Math.ceil(panels.length / cols);
    const rowH = Array.from({ length: rowsN }, (_, r) => Math.max(...hs.slice(r * cols, r * cols + cols)));
    const comp: OverlayOptions[] = [];
    let y = 0;
    for (let r = 0; r < rowsN; r++) {
      panels.slice(r * cols, r * cols + cols).forEach((p, i) => comp.push({ input: p, left: i * PW, top: y }));
      y += rowH[r]!;
    }
    const file = path.join(out, `${zone}_${seed}.jpg`);
    await sharp({ create: { width: cols * PW, height: y, channels: 3, background: '#111' } }).composite(comp).jpeg({ quality: 84 }).toFile(file);
    console.log(`${file}: ${zones.get(zone)?.name ?? zone}${made ? ` ${made.toString()}` : ''}`);
  }
}
