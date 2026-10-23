/**
 * Make a built world's places again with the place pipeline as it is now, and settle them: each place's map is made
 * from its saved steps (draft/places/<zone>/: plan, maps, view checks, names, readings, repair rounds), so only what
 * is missing is painted, read or repaired, then everything is placed anew (a saved placement for that map is
 * reused), the map is brought to game scale and the navigation grid, people, things, monster packs and traps are laid
 * out again. Building interiors are removed first (buildings are only painted now: removeInteriors). Places with no
 * saved top-down map (a world from the old isometric pipeline) are left as they are unless --paint is given: then they
 * are painted from scratch.
 *
 * The world file and the place images are backed up first (data/worlds/<id>/backup/<time>/). Reveries keep their
 * players, conversations and quests; positions that are off a place's new ground move to its way in when loaded.
 * A running reverie picks the change up when it next loads (30 s after everyone leaves, or the dev menu's reload).
 *
 * Usage: tsx src/cli/resettle.ts <worldId> [zoneId ...] [--paint] [--dry]   (--dry: only list what would happen)
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadWorld, saveWorld, worldAssetDir, worldDir } from '../storage';
import { GpuQueue } from '../worldgen/gpu';
import { paintAndRead, removeInteriors, settlePlace, sketchOf, worldLook } from '../worldgen/zones';

const args = process.argv.slice(2);
const dry = args.includes('--dry'), paint = args.includes('--paint');
const [worldId, ...only] = args.filter((a) => !a.startsWith('--'));
if (!worldId) throw new Error('usage: resettle <worldId> [zoneId ...] [--paint] [--dry]');
const w = loadWorld(worldId);
if (!w) throw new Error(`no world ${worldId}`);
const places = path.join(worldDir(worldId), 'draft', 'places');

if (!dry) {
  const backup = path.join(worldDir(worldId), 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(path.join(backup, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(worldDir(worldId), 'world.json'), path.join(backup, 'world.json'));
  const assets = worldAssetDir(worldId);
  for (const f of fs.existsSync(assets) ? fs.readdirSync(assets) : []) if (f.startsWith('place_')) fs.copyFileSync(path.join(assets, f), path.join(backup, 'assets', f));
  console.log(`backed up to ${backup}`);
}

// Buildings are only painted now: a world's rooms become buildings of their towns (removeInteriors).
if (!dry) {
  const rooms = removeInteriors(w);
  if (rooms) {
    saveWorld(w);
    console.log(`removed ${rooms} building interiors (their people stand outside their buildings)`);
  }
}

const gpu = new GpuQueue();
const seedOf = (id: string) => [...`${w.seed}:${id}`].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 1_000_000;
const order = w.zones.map((z) => z.id);
for (const id of order) {
  const z = w.zones.find((x) => x.id === id);
  if (!z || (only.length && !only.includes(id))) continue;
  const dir = path.join(places, id);
  const made = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^map_\d+\.png$/.test(f)) : [];
  if (!made.length && !paint) {
    console.log(`${z.name} (${id}): no saved top-down map, left as it is (--paint paints one)`);
    continue;
  }
  console.log(`${z.name} (${id}): ${made.length ? `${made.length} saved map(s)` : 'painting a map'}`);
  if (dry) continue;
  const seed = made.length ? Math.min(...made.map((f) => Number(/\d+/.exec(f)![0]))) : seedOf(id);
  const ctx = { gpu, priority: 0, seed, report: (m: string) => console.log(`  ${m}`) };
  const painted = await paintAndRead(worldLook(w), sketchOf(w, z), ctx);
  // What the last settling added is laid out again.
  z.spawns = [];
  z.features = z.features.filter((f) => !(f.kind === 'trap' && f.id.startsWith(`${z.id}_trap`)));
  await settlePlace(w, z, painted, ctx);
  saveWorld(w);
  console.log(`  settled: ${Math.round(z.width)}×${Math.round(z.height)} m, ${z.features.length} features, ${z.spawns.length} monsters`);
}
process.exit(0);
