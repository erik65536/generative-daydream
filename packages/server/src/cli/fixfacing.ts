/**
 * Turn every character sprite of a daydream to face left, as the game expects (it mirrors them to go right).
 * Art painted before facing was checked can have frames facing the other way; this asks the art checker and
 * mirrors those files in place.
 *
 *   tsx src/cli/fixfacing.ts <worldId> [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadWorld, worldAssetDir } from '../storage';
import { facingOf } from '../genai/images';
import { genai } from '../genai/service';

const [worldId] = process.argv.slice(2);
const dry = process.argv.includes('--dry');
const w = worldId ? loadWorld(worldId) : null;
if (!w) throw new Error('usage: fixfacing <worldId> [--dry]');
const dir = worldAssetDir(w.id);
let flipped = 0, checked = 0;
for (const a of Object.values(w.assets)) {
  if (a.kind !== 'sprite' || a.status !== 'ok' || !a.file) continue;
  const file = path.join(dir, a.file);
  if (!fs.existsSync(file)) continue;
  const png = fs.readFileSync(file);
  const facing = await facingOf(png);
  checked++;
  if (facing !== 'right') continue;
  flipped++;
  console.log(`${dry ? 'would mirror' : 'mirrored'} ${a.key}`);
  if (!dry) fs.writeFileSync(file, await sharp(png).flop().png().toBuffer());
}
console.log(`${checked} sprites checked, ${flipped} ${dry ? 'facing right' : 'mirrored'}.`);
await genai().releaseGpu();
process.exit(0);
