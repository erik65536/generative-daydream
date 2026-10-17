import sharp from 'sharp';
import { makeSeamless } from '../genai/images';
const d = process.argv[2]!;
const f = process.argv[3]!;
async function seam(buf: Buffer) {
  const { data, info } = await sharp(buf).resize(256, 256).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, c = info.channels;
  const px = (x: number, y: number, k: number) => data[(y * W + x) * c + k]!;
  let edge = 0, inner = 0;
  for (let i = 0; i < W; i++) for (let k = 0; k < 3; k++) {
    edge += Math.abs(px(0, i, k) - px(W - 1, i, k)) + Math.abs(px(i, 0, k) - px(i, W - 1, k));
    inner += Math.abs(px(127, i, k) - px(128, i, k)) + Math.abs(px(i, 127, k) - px(i, 128, k));
  }
  return { edge: edge / (W * 6), inner: inner / (W * 6) };
}
const raw = await sharp(`${d}/${f}`).toBuffer();
const blended = await makeSeamless(raw, 256);
console.log('raw', await seam(raw), 'blended', await seam(blended));
for (const [name, b] of [['raw', await sharp(raw).resize(256, 256).png().toBuffer()], ['blend', blended]] as const)
  await sharp({ create: { width: 512, height: 512, channels: 3, background: '#000' } }).composite([0, 1, 2, 3].map((i) => ({ input: b, left: (i % 2) * 256, top: Math.floor(i / 2) * 256 }))).png().toFile(`${d}/tile_${name}.png`);
