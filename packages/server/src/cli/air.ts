/**
 * Give a built world's places their air: the mist tile (Luna designs it, Krea paints it, saved with the place's
 * steps) and the light measured from each painting. Places that have it are skipped unless named; a named place
 * reuses its saved mist (delete data/worlds/<id>/draft/places/<zone>/mist.* to design and paint it anew).
 *
 * The world file is backed up first (data/worlds/<id>/backup/<time>/). A running reverie picks the change up when it
 * next loads (30 s after everyone leaves, or the dev menu's reload).
 *
 * Usage: tsx src/cli/air.ts <worldId> [zoneId ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadWorld, saveWorld, worldDir } from '../storage';
import { GpuQueue } from '../worldgen/gpu';
import { addAir } from '../worldgen/zones';

const [worldId, ...only] = process.argv.slice(2);
if (!worldId) throw new Error('usage: air <worldId> [zoneId ...]');
const w = loadWorld(worldId);
if (!w) throw new Error(`no world ${worldId}`);

const backup = path.join(worldDir(worldId), 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup, { recursive: true });
fs.copyFileSync(path.join(worldDir(worldId), 'world.json'), path.join(backup, 'world.json'));
console.log(`backed up to ${backup}`);

const gpu = new GpuQueue();
for (const [i, z] of w.zones.entries()) {
  if ((only.length && !only.includes(z.id)) || !z.painting || (z.look.mist && !only.length)) continue;
  const t0 = Date.now();
  await addAir(w, z, { gpu, priority: i, seed: 7100 + i });
  saveWorld(w);
  console.log(`${z.name} (${z.id}): mist ${z.look.mist}, light ${JSON.stringify(z.look.painted)} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
process.exit(0);
