/**
 * Preview a daydream's painted walk cycles as looping GIFs (and a contact sheet) in data/animtest/<worldId>/.
 *
 *   tsx src/cli/walkgif.ts <worldId> [key filter]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadWorld, worldAssetDir } from '../storage';
import { DATA_DIR } from '../paths';

const [worldId, filter] = process.argv.slice(2);
const w = worldId ? loadWorld(worldId) : null;
if (!w) throw new Error('usage: walkgif <worldId> [key filter]');
const out = path.join(DATA_DIR, 'animtest', w.id);
fs.mkdirSync(out, { recursive: true });
const strips = Object.values(w.assets).filter((a) => a.variant === 'walk' && a.status === 'ok' && a.file && a.frames && (!filter || a.key.includes(filter)));
const rows: Buffer[] = [];
for (const a of strips) {
  const png = fs.readFileSync(path.join(worldAssetDir(w.id), a.file!));
  const m = await sharp(png).metadata();
  const n = a.frames!, fw = Math.floor((m.width ?? 0) / n), h = m.height ?? 0;
  const frames = await Promise.all(Array.from({ length: n }, (_, i) => sharp(png).extract({ left: i * fw, top: 0, width: fw, height: h }).flatten({ background: '#4a4a4a' }).png().toBuffer()));
  // Two loops side by side: as painted (facing left) and mirrored, as the game shows walking right.
  const both = await Promise.all(frames.map(async (f) => sharp({ create: { width: fw * 2 + 20, height: h, channels: 3, background: '#4a4a4a' } }).composite([{ input: f, left: 0, top: 0 }, { input: await sharp(f).flop().png().toBuffer(), left: fw + 20, top: 0 }]).png().toBuffer()));
  await sharp(both, { join: { animated: true } }).gif({ delay: both.map(() => 100), loop: 0 }).toFile(path.join(out, `${a.key.replace(/[@]/g, '_')}.gif`));
  rows.push(await sharp({ create: { width: fw * n, height: h, channels: 3, background: '#4a4a4a' } }).composite(frames.map((f, i) => ({ input: f, left: i * fw, top: 0 }))).png().toBuffer().then((b) => sharp(b).resize({ height: 180 }).png().toBuffer()));
}
if (rows.length) {
  const metas = await Promise.all(rows.map((r) => sharp(r).metadata()));
  const W = Math.max(...metas.map((m) => m.width ?? 0));
  await sharp({ create: { width: W, height: 180 * rows.length, channels: 3, background: '#4a4a4a' } }).composite(rows.map((r, i) => ({ input: r, left: 0, top: i * 180 }))).png().toFile(path.join(out, 'walk_sheets.png'));
}
console.log(`${strips.length} walk cycles → ${out}`);
