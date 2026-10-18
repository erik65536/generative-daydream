/** Dev tool: contact sheet of PNGs on a magenta background (leftover background haze shows up). Usage: tsx src/cli/sheet.ts <dir> <regex> <out.png> [cell] */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
const [dir, pattern, out, cellArg] = process.argv.slice(2);
const cell = Number(cellArg ?? 200);
const files = fs.readdirSync(dir).filter((f) => new RegExp(pattern).test(f)).sort();
const cols = 8, rows = Math.ceil(files.length / cols);
const W = cols * cell, H = rows * (cell + 16);
// magenta/checker background so leftover haze is visible
const bg = await sharp({ create: { width: W, height: H, channels: 4, background: '#d0309a' } }).png().toBuffer();
const comps = [];
for (let i = 0; i < files.length; i++) {
  const img = await sharp(path.join(dir, files[i])).resize(cell - 8, cell - 8, { fit: 'inside' }).png().toBuffer();
  comps.push({ input: img, left: (i % cols) * cell + 4, top: Math.floor(i / cols) * (cell + 16) + 4 });
  const label = Buffer.from(`<svg width="${cell}" height="14"><text x="2" y="11" font-size="10" fill="white">${files[i].replace('.png','').slice(-30)}</text></svg>`);
  comps.push({ input: label, left: (i % cols) * cell, top: Math.floor(i / cols) * (cell + 16) + cell });
}
await sharp(bg).composite(comps).png().toFile(out);
console.log(files.length, 'files ->', out);
