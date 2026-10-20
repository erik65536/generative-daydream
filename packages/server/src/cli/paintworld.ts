/**
 * Paint (or repaint) a world's art outside the web server, so a long run survives server restarts.
 * Saves as it goes; the running server picks the changes up. Usage: tsx src/cli/paintworld.ts <worldId> [essential|full] [--only key1,key2,...]
 * (--only paints just those assets when they are missing, failed, changed or made by an older pipeline.)
 */
import { loadWorld, saveWorld } from '../storage';
import { generateArt, linkAssets } from '../worldgen/art';
import { genai } from '../genai/service';

const [worldId, level = 'full'] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--only');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1]!.split(',')) : undefined;
if (!worldId) throw new Error('usage: paintworld <worldId> [essential|full]');
const w = loadWorld(worldId);
if (!w) throw new Error(`world ${worldId} not found`);
const t0 = Date.now();
let lastSave = Date.now();
await generateArt(w, level === 'essential' ? 'essential' : 'full', {
  only,
  report: (msg) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] ${msg}`),
  onAsset: () => {
    if (Date.now() - lastSave > 10_000) {
      saveWorld(w);
      lastSave = Date.now();
    }
  },
});
linkAssets(w);
saveWorld(w);
await genai().releaseGpu();
const assets = Object.values(w.assets);
console.log(`Done in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${assets.filter((a) => a.status === 'ok').length} ok, ${assets.filter((a) => a.status === 'failed').length} failed of ${assets.length}.`);
