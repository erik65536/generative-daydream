/**
 * Paint a few of a world's assets with the real pipeline into a scratch folder (the world is not changed), and draw
 * a contact sheet: each attempt's painting, its cutout on dark and on a loud colour, and its scores.
 *
 *   tsx src/cli/paintpeek.ts <worldId> [--only key1,key2] [--pick 3,2,2,3 (people, creatures, objects, icons)] [--out dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { ROOT_DIR } from '../paths';
import { loadWorld } from '../storage';
import { planAssets, writeImagePrompts } from '../worldgen/art';
import { produceAssets, type Attempt, type ImageRecord } from '../genai/images';
import { KEY_COLOURS } from '../genai/cutout';
import { genai } from '../genai/service';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const worldId = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!worldId) throw new Error('usage: paintpeek <worldId> [--only keys] [--pick people,creatures,objects,icons] [--out dir]');
const w = loadWorld(worldId);
if (!w) throw new Error(`world ${worldId} not found`);
const out = opt('out') ?? path.join(ROOT_DIR, 'data', 'paintpeek', worldId);
fs.mkdirSync(out, { recursive: true });

// Plan as if nothing were painted, then pick a few of each kind.
const plan = planAssets({ ...w, assets: {} }, 'full') as ImageRecord[];
const only = opt('only')?.split(',');
const [people, creatures, objects, icons] = (opt('pick') ?? '3,3,2,3').split(',').map(Number) as [number, number, number, number];
const spread = <T,>(xs: T[], n: number) => (n >= xs.length ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]!));
const recs = only
  ? plan.filter((r) => only.includes(r.key))
  : [
      ...spread(plan.filter((r) => r.key.startsWith('spr_npc_') || r.key.endsWith('_androgynous')), people),
      ...spread(plan.filter((r) => r.key.startsWith('spr_mon_') || r.key.startsWith('spr_boss_')), creatures),
      ...spread(plan.filter((r) => r.kind === 'object'), objects),
      ...spread(plan.filter((r) => r.kind === 'icon'), icons),
    ];
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
await writeImagePrompts({ ...w, assets: {} }, recs, log);
for (const r of recs) log(`${r.key}: ${r.backdrop}${r.view ? `, ${r.view}` : ''}: ${r.imagePrompt?.slice(0, 140)}…`);

const attempts = new Map<string, Attempt[]>();
const done = new Map<string, ImageRecord>();
for (const r of recs)
  await produceAssets([r], w.concept.artStyle, out, w.seed, (res) => {
    done.set(res.key, res);
    log(`${res.status} ${res.key} score ${res.score?.toFixed(1)} after ${res.attempts} tries on ${res.backdrop}${res.error ? ` (${res.error})` : ''}`);
  }, undefined, (rec, a) => {
    attempts.set(rec.key, [...(attempts.get(rec.key) ?? []), a]);
    log(`  attempt ${rec.key} on ${a.key}: score ${a.score.toFixed(1)}, cut ${a.cut.judgeable ? '' : 'unjudgeable, '}left ${(a.cut.leftover * 100).toFixed(1)}%, missing ${(a.cut.missing * 100).toFixed(1)}%${a.problems.length ? ` (${a.problems.join('; ')})` : ''}`);
  });
fs.writeFileSync(path.join(out, 'records.json'), JSON.stringify([...done.values()], null, 1));

// Sheet: one row per attempt: painting | cutout on dark | cutout on a loud colour far from the key | label.
const CELL = 260, LABEL = 420;
const loud = (k: keyof typeof KEY_COLOURS) => (k === 'magenta' ? '#38ff38' : '#ff30ff');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const rows = recs.flatMap((r) => (attempts.get(r.key) ?? []).map((a, i) => ({ r, a, i, kept: done.get(r.key)?.score === a.score })));
const comps: OverlayOptions[] = [];
for (const [y, { r, a, i, kept }] of rows.entries()) {
  const top = y * CELL;
  const fit = (b: Buffer, bg: string) => sharp(b).resize(CELL - 8, CELL - 8, { fit: 'contain', background: bg }).flatten({ background: bg }).png().toBuffer();
  comps.push({ input: await fit(await sharp(a.painting).removeAlpha().png().toBuffer(), '#000000'), left: 4, top: top + 4 });
  comps.push({ input: await fit(a.png, '#181818'), left: CELL + 4, top: top + 4 });
  comps.push({ input: await fit(a.png, loud(a.key)), left: 2 * CELL + 4, top: top + 4 });
  const lines = [
    `${r.key}${kept ? '  (kept)' : ''}`,
    `${r.kind}${r.view ? `, ${r.view} view` : ''}, attempt ${i + 1}, on ${a.key}`,
    `score ${a.score.toFixed(1)}   cut: ${a.cut.judgeable ? `left ${(a.cut.leftover * 100).toFixed(1)}%  missing ${(a.cut.missing * 100).toFixed(1)}%` : 'colours clash'}`,
    ...a.problems.slice(0, 4),
  ];
  comps.push({ input: Buffer.from(`<svg width="${LABEL}" height="${CELL}">${lines.map((l, j) => `<text x="6" y="${24 + j * 22}" font-size="${j ? 15 : 17}" font-family="sans-serif" fill="${j > 2 ? '#ff9a9a' : j ? '#dddddd' : '#ffffff'}">${esc(l.slice(0, 52))}</text>`).join('')}</svg>`), left: 3 * CELL, top });
}
const sheet = path.join(out, 'sheet.png');
await sharp({ create: { width: 3 * CELL + LABEL, height: Math.max(1, rows.length) * CELL, channels: 3, background: '#2c2c2c' } }).composite(comps).png().toFile(sheet);
log(`sheet: ${sheet}`);
process.exit(0);
