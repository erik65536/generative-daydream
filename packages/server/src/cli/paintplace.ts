/**
 * Paint a place as one illustration (a painted backdrop) and save it with the world.
 * Usage: tsx src/cli/paintplace.ts <worldId> <zoneId> [--detail] [--no-sharpen] [--seed n] [--mp 2.9] [--guide 1]
 *   [--strength s] [--section WxH] [--debug prefix] [--recut]
 *   --detail adds full-scale detail tiles (experimental); --recut only cuts the existing painting out again.
 */
import { loadWorld, saveWorld } from '../storage';
import { genai } from '../genai/service';
import { paintBackdrop, recutBackdrop } from '../worldgen/backdrops';

const args = process.argv.slice(2);
const opt = (n: string) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : undefined);
const [worldId, zoneId] = args;
const w = loadWorld(worldId!);
const z = w?.zones.find((x) => x.id === zoneId);
if (!w || !z) throw new Error('usage: paintplace <worldId> <zoneId> [--detail]');
const t0 = Date.now();
if (args.includes('--recut')) {
  await recutBackdrop(w, z);
  saveWorld(w);
  console.log(`Re-cut ${z.name}: ${z.backdrop!.pieces.length} cut-outs.`);
  process.exit(0);
}
const section = opt('section')?.split('x').map(Number) as [number, number] | undefined;
await paintBackdrop(w, z, { detail: args.includes('--detail') ? 1 : 0, seed: Number(opt('seed') ?? 7), debugPrefix: opt('debug'), section: section ? { width: section[0], height: section[1] } : undefined, mp: opt('mp') ? Number(opt('mp')) : undefined, strength: opt('strength') ? Number(opt('strength')) : undefined, sharpen: !args.includes('--no-sharpen'), guideStrength: opt('guide') ? Number(opt('guide')) : undefined, report: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`) });
saveWorld(w);
await genai().releaseGpu();
console.log(`Painted ${z.name} in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${z.backdrop!.pieces.length} cut-outs.`);
