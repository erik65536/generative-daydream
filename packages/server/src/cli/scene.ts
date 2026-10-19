/** Render a place at game scale. Usage: tsx src/cli/scene.ts <worldId> <zoneId> <out.png> [all|low|none] [--crop x,y,w,h] */
import fs from 'node:fs';
import sharp from 'sharp';
import { loadWorld } from '../storage';
import { renderScene } from '../worldgen/scene';

const [worldId, zoneId, out, props = 'all'] = process.argv.slice(2);
const w = loadWorld(worldId!)!;
const z = w.zones.find((x) => x.id === zoneId)!;
const s = await renderScene(w, z, { props: props as 'all' });
const crop = process.argv.indexOf('--crop');
let png = s.png;
if (crop > 0) {
  const [left, top, width, height] = process.argv[crop + 1]!.split(',').map(Number) as [number, number, number, number];
  png = await sharp(png).extract({ left, top, width, height }).png().toBuffer();
}
fs.writeFileSync(out!, png);
console.log(`Wrote ${out} (${s.width}x${s.height}, origin ${s.ox},${s.oy})`);
