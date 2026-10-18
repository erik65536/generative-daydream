/**
 * Try pose-guided walk frames on one character: draws the eight walk skeletons, repaints the character in each
 * with Qwen Image Edit (character + skeleton as references), cuts out and aligns the frames, and writes the
 * frames, a contact sheet and an animated preview to data/animtest/<key>/.
 *
 *   tsx src/cli/animtest.ts <worldId> <spriteKey> [--seed N]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadWorld, worldAssetDir } from '../storage';
import { DATA_DIR } from '../paths';
import { genai } from '../genai/service';
import { processSprite, referenceFrame } from '../genai/matte';
import { alignFrames, drawSkeleton, skeletonLeak, walkSkeleton, WALK_FRAMES } from '../genai/poses';

const [worldId, key] = process.argv.slice(2);
const seedArg = process.argv.indexOf('--seed');
const seed = seedArg > 0 ? Number(process.argv[seedArg + 1]) : 1234;
const w = worldId ? loadWorld(worldId) : null;
const rec = w && key ? w.assets[key] : undefined;
if (!w || !rec?.file) throw new Error('usage: animtest <worldId> <spriteKey>');
const out = path.join(DATA_DIR, 'animtest', key!);
fs.mkdirSync(out, { recursive: true });

const base = fs.readFileSync(path.join(worldAssetDir(w.id), rec.file));
const W = 832, H = 1216;
const ref = await referenceFrame(base, W, H);
const refPng = await sharp(ref.png).resize(W, H, { fit: 'contain', background: '#d6d6d6' }).png().toBuffer();
fs.writeFileSync(path.join(out, 'ref.png'), refPng);
// The reference frame puts the figure at 80% of the height with its feet at 92%.
const figure = { height: H * ref.figureRatio, footY: H * 0.92, centerX: W / 2 };
const desc = rec.prompt;
const g = genai();
const frames: { png: Buffer; rel: number }[] = [];
if (process.argv.includes('--sheet')) {
  // All eight poses in one picture (4 x 2 cells): one generation keeps props, facing and details consistent.
  const CW = 416, CH = 608, SW = CW * 4, SH = CH * 2;
  const cellFig = { height: CH * ref.figureRatio, footY: CH * 0.92 };
  const cells = await Promise.all(Array.from({ length: WALK_FRAMES }, (_, i) => drawSkeleton(walkSkeleton(i), CW, CH, { ...cellFig, centerX: CW / 2 })));
  const sheet = await sharp({ create: { width: SW, height: SH, channels: 3, background: '#000' } })
    .composite(cells.map((c, i) => ({ input: c, left: (i % 4) * CW, top: Math.floor(i / 4) * CH })))
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(out, 'skel_sheet.png'), sheet);
  let raw: Buffer = Buffer.alloc(0);
  for (let attempt = 0; attempt < 4; attempt++) {
    raw = await g.image('image.sprite', {
      prompt: `Picture 1 shows a game character: ${desc}. Picture 2 is a sheet of eight pose skeletons (coloured OpenPose stick figures on black) in a grid of 4 columns and 2 rows: the frames of a walk cycle toward the left. Draw a walk-cycle sprite sheet: the character from picture 1 eight times, one in each cell of the same grid, each in exactly the pose of the skeleton in that cell. Every copy is the same character with the same face, hair, clothing, colours, gear (held in the same hand every time), proportions, art style and size, full body visible, on one plain light grey background with nothing between the cells. The skeletons are only a guide: draw no lines, dots or coloured sticks.`,
      seed: seed + attempt * 7919,
      transparent: true,
      width: SW,
      height: SH,
      references: [refPng, sheet],
    });
    const leak = await skeletonLeak(raw);
    if (leak < 0.0005) break;
    console.log(`sheet: skeleton painted in (${(leak * 100).toFixed(2)}%), again`);
  }
  fs.writeFileSync(path.join(out, 'raw_sheet.png'), raw);
  const meta = await sharp(raw).metadata();
  const cw = Math.round((meta.width ?? SW) / 4), ch = Math.round((meta.height ?? SH) / 2);
  for (let i = 0; i < WALK_FRAMES; i++) {
    const cell = await sharp(raw).extract({ left: (i % 4) * cw, top: Math.floor(i / 4) * ch, width: cw, height: ch }).png().toBuffer();
    const img = await processSprite(cell, 512);
    frames.push({ png: img.png, rel: (img.figureRatio ?? ref.figureRatio) / ref.figureRatio });
    console.log(`cell ${i}: rel ${frames[i]!.rel.toFixed(3)} ${img.problems.join('; ')}`);
  }
}
for (let i = 0; i < WALK_FRAMES && frames.length < WALK_FRAMES && !process.argv.includes('--sheet'); i++) {
  const skel = await drawSkeleton(walkSkeleton(i), W, H, figure);
  fs.writeFileSync(path.join(out, `skel_${i}.png`), skel);
  const t0 = performance.now();
  let raw: Buffer = Buffer.alloc(0);
  for (let attempt = 0; attempt < 4; attempt++) {
  raw = await g.image('image.sprite', {
    prompt: `Picture 1 shows a game character: ${desc}. Picture 2 is a pose skeleton (coloured OpenPose stick figure on black). Draw the character from picture 1 in exactly the pose of the skeleton in picture 2: walking toward the left, mid-step, the legs and arms placed as the skeleton shows. Keep everything else the same as picture 1: the same face, hair, clothing, colours, proportions, art style and size, the same place in the frame, full body visible, on the same plain light grey background. The skeleton is only a guide: draw no lines, dots or coloured sticks — only the character.`,
    seed: seed + attempt * 7919,
    transparent: true,
    width: W,
    height: H,
    references: [refPng, skel],
  });
    const leak = await skeletonLeak(raw);
    if (leak < 0.0005) break;
    console.log(`frame ${i}: skeleton painted in (${(leak * 100).toFixed(2)}%), again`);
  }
  fs.writeFileSync(path.join(out, `raw_${i}.png`), raw);
  const img = await processSprite(raw, 512);
  frames.push({ png: img.png, rel: (img.figureRatio ?? ref.figureRatio) / ref.figureRatio });
  console.log(`frame ${i}: ${((performance.now() - t0) / 1000).toFixed(1)}s rel ${frames[i]!.rel.toFixed(3)} ${img.problems.join('; ')}`);
}
const aligned = await alignFrames(frames, 360);
aligned.frames.forEach((f, i) => fs.writeFileSync(path.join(out, `frame_${i}.png`), f));
const onGrey = await Promise.all(aligned.frames.map((f) => sharp(f).flatten({ background: '#5a5a5a' }).png().toBuffer()));
// Contact sheet and an animated preview at walking speed.
await sharp({ create: { width: aligned.width * onGrey.length, height: aligned.height, channels: 3, background: '#5a5a5a' } })
  .composite(onGrey.map((f, i) => ({ input: f, left: i * aligned.width, top: 0 })))
  .png()
  .toFile(path.join(out, 'sheet.png'));
await sharp(onGrey, { join: { animated: true } }).gif({ delay: onGrey.map(() => 110), loop: 0 }).toFile(path.join(out, 'walk.gif'));
console.log(`wrote ${out}`);
await g.releaseGpu();
process.exit(0);
