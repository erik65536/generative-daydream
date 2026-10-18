/**
 * Paint one character's walk strip with the production painter and write it with a preview GIF to
 * data/animtest/strip/ (nothing in the daydream changes).
 *
 *   tsx src/cli/walkstrip.ts <worldId> <spriteKey> [seed]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadWorld, worldAssetDir } from '../storage';
import { DATA_DIR } from '../paths';
import { genai } from '../genai/service';
import { contrastingBackground, paintWalkStrip } from '../genai/poses';

const [worldId, key, seedArg] = process.argv.slice(2);
const w = worldId ? loadWorld(worldId) : null;
const rec = w && key ? w.assets[key] : undefined;
if (!w || !rec?.file) throw new Error('usage: walkstrip <worldId> <spriteKey> [seed]');
const sprite = fs.readFileSync(path.join(worldAssetDir(w.id), rec.file));
const out = path.join(DATA_DIR, 'animtest', 'strip');
fs.mkdirSync(out, { recursive: true });
const t0 = performance.now();
console.log(`background ${(await contrastingBackground(sprite)).hex}`);
const strip = await paintWalkStrip(sprite, rec.prompt, Number(seedArg ?? 99));
console.log(`${((performance.now() - t0) / 1000).toFixed(1)}s ${strip.problems.join('; ') || 'no problems'}`);
fs.writeFileSync(path.join(out, `${key}.png`), strip.png);
const n = strip.frames!, fw = Math.floor(strip.width / n);
const frames = await Promise.all(Array.from({ length: n }, (_, i) => sharp(strip.png).extract({ left: i * fw, top: 0, width: fw, height: strip.height }).flatten({ background: '#4a4a4a' }).png().toBuffer()));
await sharp({ create: { width: fw * n, height: strip.height, channels: 3, background: '#4a4a4a' } }).composite(frames.map((f, i) => ({ input: f, left: i * fw, top: 0 }))).png().toFile(path.join(out, `${key}_sheet.png`));
await sharp(frames, { join: { animated: true } }).gif({ delay: frames.map(() => 100), loop: 0 }).toFile(path.join(out, `${key}.gif`));
await genai().releaseGpu();
process.exit(0);
