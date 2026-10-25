/**
 * See a settled place as the game has it: its map, where people can walk (green), and everything placed in it
 * (ways out, people, things, monsters). Usage: tsx src/cli/placepeek.ts <worldId> [zoneId ...] [--out <dir>] [--mark x,y]
 * (--mark: a ground position to show, such as a player's)
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { NAV_CELL, Nav, PX_PER_METRE, groundToPicture } from '@gd/shared';
import { loadWorld, worldAssetDir } from '../storage';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1]! : '.';
const markAt = args.indexOf('--mark');
const here = markAt >= 0 ? args[markAt + 1]!.split(',').map(Number) : undefined;
const [worldId, ...only] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--mark');
const w = loadWorld(worldId!);
if (!w) throw new Error(`no world ${worldId}`);
const COLOR: Record<string, string> = { exit: '#40c8ff', chest: '#ffe040', sign: '#ffffff', lore: '#c0a0ff', waypoint: '#40ffd0', craft_station: '#ff9060', object: '#ffe28c', trap: '#ff3030' };
fs.mkdirSync(out, { recursive: true });
for (const z of w.zones) {
  if ((only.length && !only.includes(z.id)) || !z.painting || !z.nav) continue;
  const asset = w.assets[z.painting.image];
  if (!asset?.file) continue;
  const { width: W, height: H, ox, oy } = z.painting;
  const nav = new Nav(z.nav);
  const at = (x: number, y: number) => groundToPicture(x, y, ox, oy);
  const cells: string[] = [];
  const half = (PX_PER_METRE * NAV_CELL) / 2;
  for (let cy = 0; cy < nav.rows; cy++)
    for (let cx = 0; cx < nav.cols; cx++) {
      if (!nav.walkableCell(cx, cy)) continue;
      const c = at((cx + 0.5) * NAV_CELL, (cy + 0.5) * NAV_CELL);
      cells.push(`M${c.x - half},${c.y - half}h${2 * half}v${2 * half}h${-2 * half}Z`);
    }
  const mark = (x: number, y: number, color: string, r = 9, label = '') => {
    const p = at(x, y);
    return `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${color}" stroke="#000" stroke-width="3"/>${label ? `<text x="${p.x + r + 4}" y="${p.y + 6}" font-size="22" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="4" paint-order="stroke">${label.replace(/[<&]/g, '')}</text>` : ''}`;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<path d="${cells.join('')}" fill="rgba(40,230,80,0.28)"/>
${z.features.map((f) => mark(f.x, f.y, COLOR[f.kind] ?? '#fff', 10, f.kind === 'exit' ? f.name ?? '' : '')).join('')}
${w.npcs.filter((n) => n.zoneId === z.id).map((n) => mark(n.x, n.y, '#ffffff', 8, n.name)).join('')}
${z.spawns.map((s) => mark(s.x, s.y, s.bossId ? '#ff0000' : '#e06040', s.bossId ? 12 : 6)).join('')}
${mark(z.entry.x, z.entry.y, '#00ff00', 14, 'entry')}
${here ? mark(here[0]!, here[1]!, '#ff00ff', 14, 'here') : ''}
</svg>`;
  const file = path.join(out, `${z.id}.jpg`);
  const marked = await sharp(path.join(worldAssetDir(w.id), asset.file)).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  await sharp(marked).resize({ width: Math.min(W, 2400) }).jpeg({ quality: 82 }).toFile(file);
  console.log(`${file}: ${z.name} (${z.kind}) ${Math.round(z.width)}×${Math.round(z.height)} m, ${z.features.length} features, ${z.spawns.length} monsters`);
}
