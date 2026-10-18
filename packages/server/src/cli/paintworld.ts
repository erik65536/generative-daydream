/**
 * Paint (or repaint) a world's art outside the web server, so a long run survives server restarts.
 * Saves as it goes; the running server picks the changes up. Usage: tsx src/cli/paintworld.ts <worldId> [essential|full] [--only key1,key2,...]
 * (--only paints just those assets and their missing variants, e.g. new walk cycles for a few characters;
 * --redo <variant> first forgets that variant everywhere, e.g. --redo walk to repaint walk cycles.)
 */
import { loadWorld, saveWorld } from '../storage';
import { generateArt, linkAssets } from '../worldgen/art';
import { genai } from '../genai/service';

const [worldId, level = 'full'] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--only' && all[i - 1] !== '--redo');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1]!.split(',')) : undefined;
const redoArg = process.argv.indexOf('--redo');
if (!worldId) throw new Error('usage: paintworld <worldId> [essential|full]');
const w = loadWorld(worldId);
if (!w) throw new Error(`world ${worldId} not found`);
if (redoArg > 0) {
  const v = process.argv[redoArg + 1];
  for (const k of Object.keys(w.assets)) if (w.assets[k]!.variant === v && (!only || only.has(w.assets[k]!.ref ?? ''))) delete w.assets[k];
}
const t0 = Date.now();
let lastSave = Date.now();
let current = '';
await generateArt(
  w,
  level === 'essential' ? 'essential' : 'full',
  (msg) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] ${msg}`),
  {
    phase: (id, counts) => {
      current = id;
      console.log(`== ${id}${counts?.total ? ` (${counts.total})` : ''}`);
    },
    count: () => {},
  },
  () => {
    if (Date.now() - lastSave > 10_000) {
      saveWorld(w);
      lastSave = Date.now();
    }
  },
  undefined,
  only,
);
linkAssets(w);
saveWorld(w);
await genai().releaseGpu();
const assets = Object.values(w.assets);
console.log(`Done (${current}) in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${assets.filter((a) => a.status === 'ok').length} ok, ${assets.filter((a) => a.status === 'failed').length} failed of ${assets.length}.`);
