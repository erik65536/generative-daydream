/**
 * Art tuning harness: repaint a small selection of a world's assets into a scratch folder (the world is not
 * changed) and write a labelled contact sheet, so prompts and checks can be tuned on quick patches.
 *
 *   tsx src/cli/arttune.ts <worldId> <outDir> [--keys <regex>] [--limit N] [--direct] [--no-variants]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import type { AssetRecord, WorldDefinition } from '@gd/shared';
import { loadWorld } from '../storage';
import { directTilesets, planAssets, writeImagePrompts } from '../worldgen/art';
import { produceAssets } from '../genai/images';
import { genai } from '../genai/service';

const args = process.argv.slice(2);
const [worldId, outDir] = args;
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!worldId || !outDir) throw new Error('usage: arttune <worldId> <outDir> [--keys regex] [--limit N] [--direct] [--no-variants]');
const original = loadWorld(worldId);
if (!original) throw new Error(`world ${worldId} not found`);
const w = JSON.parse(JSON.stringify(original)) as WorldDefinition;
fs.mkdirSync(outDir, { recursive: true });
const log = (m: string) => console.log(m);

if (args.includes('--direct')) {
  for (const ts of Object.values(w.tilesets)) ts.directed = false;
  await directTilesets(w, log);
}
// Plan as if nothing existed, then narrow down.
w.assets = {};
const re = new RegExp(opt('keys') ?? '.');
let plan = planAssets(w, 'full').filter((r) => !r.ref && re.test(r.key));
plan = plan.slice(0, Number(opt('limit') ?? 12));
if (!args.includes('--no-variants')) {
  const all = planAssets(w, 'full');
  plan.push(...all.filter((r) => r.ref && plan.some((b) => b.key === r.ref)));
}
log(`Painting ${plan.length} assets: ${plan.map((r) => r.key).join(', ')}`);
await writeImagePrompts(w, plan, log);
const results: AssetRecord[] = [];
const t0 = Date.now();
await produceAssets(plan, w.concept.artStyle, outDir, w.seed, (r) => {
  results.push(r);
  log(`${r.status} ${r.key} score=${r.score?.toFixed(1)} tries=${r.attempts}${r.error ? ` (${r.error})` : ''}`);
});
await genai().releaseGpu();
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results.map((r) => ({ key: r.key, status: r.status, score: r.score, attempts: r.attempts, error: r.error, prompt: r.prompt, imagePrompt: plan.find((p) => p.key === r.key)?.imagePrompt })), null, 2));

// Contact sheet: each asset on magenta, labelled with key, score and tries.
const cell = 220;
const ok = results.filter((r) => r.file);
const cols = 6, rows = Math.ceil(ok.length / cols);
const comps: OverlayOptions[] = [];
for (let i = 0; i < ok.length; i++) {
  const r = ok[i]!;
  const img = await sharp(path.join(outDir, r.file!)).resize(cell - 8, cell - 8, { fit: 'inside' }).png().toBuffer();
  const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + 30);
  comps.push({ input: img, left: x + 4, top: y + 4 });
  const label = `${r.key.slice(-34)}  ${r.score?.toFixed(1) ?? '-'} (${r.attempts}x)`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  comps.push({ input: Buffer.from(`<svg width="${cell}" height="28"><text x="2" y="11" font-size="10" fill="white">${esc(label)}</text><text x="2" y="24" font-size="9" fill="#ffd0f0">${esc((r.error ?? '').slice(0, 44))}</text></svg>`), left: x, top: y + cell });
}
if (ok.length) {
  await sharp({ create: { width: cols * cell, height: rows * (cell + 30), channels: 4, background: '#d0309a' } }).composite(comps).png().toFile(path.join(outDir, 'sheet.png'));
}
log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s. Sheet: ${path.join(outDir, 'sheet.png')}`);
