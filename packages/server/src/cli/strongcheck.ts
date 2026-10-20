/**
 * Try the stronger-model fallback of reading a painted place on a saved painting: what the saved read falls short
 * of, the strong model's check told why, and the read it leads to. Nothing is saved. ComfyUI must be running.
 *
 * Usage: tsx src/cli/strongcheck.ts <worldId> <zoneId>:<seed> [--model gpt-6.1-sol]
 */
import fs from 'node:fs';
import path from 'node:path';
import { openaiCost, openaiUsage } from '../genai/providers';
import { genai } from '../genai/service';
import { loadWorld, worldDir } from '../storage';
import { analyse, applyCheck, checkChanges, checkReading, colouring, type PaintingRead } from '../worldgen/reading';
import { MIN_AREA, readScore, shortfall, sketchOf } from '../worldgen/zones';

const args = process.argv.slice(2);
const mi = args.indexOf('--model');
const model = mi >= 0 ? args[mi + 1] : genai().strongModel('world.design');
const [worldId, place] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--model');
if (!worldId || !place?.includes(':') || !model) throw new Error('usage: strongcheck <worldId> <zoneId>:<seed> [--model name]');
const [zoneId, seed] = place.split(':');
const w = loadWorld(worldId);
const z = w?.zones.find((x) => x.id === zoneId);
if (!w || !z) throw new Error(`no zone ${zoneId} in ${worldId}`);
const s = sketchOf(w, z);
const outward = s.exits.filter((e) => !e.into).length;
const minArea = MIN_AREA[s.kind];
const dir = path.join(worldDir(worldId), 'draft', 'places', zoneId!);
const canvas = fs.readFileSync(path.join(dir, `canvas_${seed}.png`));
const read = JSON.parse(fs.readFileSync(path.join(dir, `read_${seed}.json`), 'utf8')) as PaintingRead;

const line = (label: string, r: PaintingRead, a: Awaited<ReturnType<typeof analyse>>) =>
  console.log(`${label}: ${Math.round(a.area)} m², ${a.edges.length}/${outward} ways out, ${a.doors.length} entrances, score ${readScore(r, a, outward, minArea).toFixed(2)}\n  walkable ${r.walkable.join(', ')} | connectors ${r.connectors.join(', ')} | blocked ${r.notWalkable.join(', ')}`);

const before = await analyse(canvas, read, s.kind);
line('saved read', read, before);
const failure = shortfall(read, before, outward, minArea);
console.log(`shortfall: ${failure ?? 'none'}`);
if (!failure) process.exit(0);

const t0 = performance.now();
const check = await checkReading(canvas, await colouring(canvas, before), read, { model, failure });
console.log(`\n${model} check (${((performance.now() - t0) / 1000).toFixed(0)}s, ~$${openaiCost(true).toFixed(3)} at Luna prices, ${openaiUsage.input} in / ${openaiUsage.output} out tokens):`);
console.log(JSON.stringify(check, null, 2));
if (check.correct || !checkChanges(check)) process.exit(0);
const read2 = applyCheck(read, check);
const after = await analyse(canvas, read2, s.kind);
line('\ncorrected read', read2, after);
console.log(`still short: ${shortfall(read2, after, outward, minArea) ?? 'no — usable'}`);
process.exit(0);
