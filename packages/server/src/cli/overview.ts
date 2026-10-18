/** Render a place's overview (and optionally have the vision model review it). Usage: tsx src/cli/overview.ts <worldId> <zoneId> <out.png> [--review] */
import fs from 'node:fs';
import { loadWorld } from '../storage';
import { renderOverview, reviewPlace } from '../worldgen/overview';

const [worldId, zoneId, out] = process.argv.slice(2);
const w = loadWorld(worldId!);
const z = w?.zones.find((x) => x.id === zoneId);
if (!w || !z || !out) throw new Error('usage: overview <worldId> <zoneId> <out.png> [--review]');
const png = await renderOverview(w, z);
fs.writeFileSync(out, png);
console.log(`Wrote ${out}`);
if (process.argv.includes('--review')) console.log(JSON.stringify(await reviewPlace(w, z, png), null, 2));
