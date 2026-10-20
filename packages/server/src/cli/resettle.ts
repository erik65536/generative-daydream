/**
 * Settle a built world's places again from their saved paintings, with the reader as it is now: each place keeps the
 * painting it shows (found by comparing the saved paintings with its image; --repick chooses as a build would: the
 * first that works, else the best), then everything is placed anew (Luna
 * places each painting once; a saved placement for that painting is reused), the painting is brought to game scale
 * and the navigation grid, people, things, monster packs and traps are laid out again. Nothing is painted and no
 * painting is read by Luna again: places without saved paintings are left as they are.
 *
 * The world file and the place images are backed up first (data/worlds/<id>/backup/<time>/). Reveries keep their
 * players, conversations and quests; positions that are off a place's new ground move to its way in when loaded.
 * A running reverie picks the change up when it next loads (30 s after everyone leaves, or the dev menu's reload).
 *
 * Usage: tsx src/cli/resettle.ts <worldId> [zoneId ...] [--dry] [--repick]   (--dry: only show the choices)
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadWorld, saveWorld, worldAssetDir, worldDir } from '../storage';
import { GpuQueue } from '../worldgen/gpu';
import type { PaintPlan } from '../worldgen/outpaint';
import { analyse, type PaintingRead, type Reading } from '../worldgen/reading';
import { MIN_AREA, readScore, settlePlace, shortfall, sketchOf } from '../worldgen/zones';

const args = process.argv.slice(2);
const dry = args.includes('--dry'), repick = args.includes('--repick');
const [worldId, ...only] = args.filter((a) => !a.startsWith('--'));
if (!worldId) throw new Error('usage: resettle <worldId> [zoneId ...] [--dry]');
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

const gpu = new GpuQueue();
const thumb = async (img: Buffer | string) => sharp(img).resize(96, 40, { fit: 'fill' }).removeAlpha().raw().toBuffer();
/** Which saved painting a place shows now: the one most like its image. */
async function shown(id: string, seeds: number[], dir: string): Promise<number | undefined> {
  const file = w!.assets[`place_${id}`]?.file;
  if (!file || !fs.existsSync(path.join(worldAssetDir(worldId!), file))) return undefined;
  const now = await thumb(path.join(worldAssetDir(worldId!), file));
  let best: number | undefined, bd = Infinity;
  for (const seed of seeds) {
    const t = await thumb(path.join(dir, `canvas_${seed}.png`));
    let d = 0;
    for (let i = 0; i < t.length; i++) d += Math.abs(t[i]! - now[i]!);
    if (d < bd) (bd = d), (best = seed);
  }
  return best;
}
// Towns before their rooms: settling a town drops the rooms whose building has no entrance in its painting.
const order = [...w.zones].sort((a, b) => (a.kind === 'interior' ? 1 : 0) - (b.kind === 'interior' ? 1 : 0)).map((z) => z.id);
for (const id of order) {
  const z = w.zones.find((x) => x.id === id);
  if (!z || (only.length && !only.includes(id))) continue;
  const dir = path.join(places, id);
  const seeds = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => /^read_(\d+)\.json$/.exec(f)?.[1]).filter((s): s is string => !!s).map(Number).sort((a, b) => a - b) : [];
  if (!seeds.length || !fs.existsSync(path.join(dir, 'plan.json'))) {
    console.log(`${z.name} (${id}): no saved paintings, left as it is`);
    continue;
  }
  const s = sketchOf(w, z);
  const outward = s.exits.filter((e) => !e.into).length, minArea = MIN_AREA[z.kind];
  const current = repick ? undefined : await shown(id, seeds, dir);
  let pick: { seed: number; canvas: Buffer; reading: Reading; score: number } | undefined;
  for (const seed of current !== undefined ? [current] : seeds) {
    const canvas = fs.readFileSync(path.join(dir, `canvas_${seed}.png`));
    const read = JSON.parse(fs.readFileSync(path.join(dir, `read_${seed}.json`), 'utf8')) as PaintingRead;
    const reading = await gpu.run('reader', 0, () => analyse(canvas, read, z.kind));
    const score = readScore(read, reading, outward, minArea), short = shortfall(read, reading, outward, minArea);
    console.log(`${z.name} (${id}) painting ${seed}: ${Math.round(reading.area)} m², ${reading.edges.length}/${outward} ways out, ${reading.doors.length} entrances${short ? ` — short: ${short}` : ''}`);
    if (!pick || score > pick.score) pick = { seed, canvas, reading, score };
    if (!short) {
      pick = { seed, canvas, reading, score };
      break;
    }
  }
  console.log(`  → painting ${pick!.seed}${current !== undefined ? ' (the one it shows)' : ''}`);
  if (dry) continue;
  // What the last settling added is laid out again.
  z.spawns = [];
  z.features = z.features.filter((f) => !(f.kind === 'trap' && f.id.startsWith(`${z.id}_trap`)));
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')) as PaintPlan;
  await settlePlace(w, z, { plan, seed: pick!.seed, canvas: pick!.canvas, reading: pick!.reading }, { gpu, priority: 0, seed: seeds[0]!, report: (m) => console.log(`  ${m}`) });
  saveWorld(w);
  console.log(`  settled: ${Math.round(z.width)}×${Math.round(z.height)} m grid, ${z.features.length} features, ${z.spawns.length} monsters`);
}
process.exit(0);
