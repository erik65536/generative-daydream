/**
 * Give one place of a world a floor plan (designed by the level designer model) and rebuild its map from it;
 * optionally paint its new props and surfaces. Saves the world; reload the daydream in the game to see it.
 * Usage: tsx src/cli/redesign.ts <worldId> <zoneId> [--guidance "..."] [--plan design.json] [--seed s] [--paint] [--save-plan out.json] [--review [--revise] --out prefix]
 *   --plan reuses a saved design instead of asking the model; --save-plan writes the design for reuse.
 */
import fs from 'node:fs';
import { GROUND, PROP_COVER, PROP_COVER_TALL, SURFACE_BASE, base64ToBytes, propIndex } from '@gd/shared';
import { loadWorld, saveWorld } from '../storage';
import { designBlueprint, type PlaceDesign } from '../worldgen/blueprint';
import { applyDesign, buildingNames, zoneSize } from '../worldgen/rezone';
import { generateArt, linkAssets, propKey, surfaceKey } from '../worldgen/art';
import { genai } from '../genai/service';
import { renderOverview, reviewPlace } from '../worldgen/overview';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [worldId, zoneId] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!worldId || !zoneId) throw new Error('usage: redesign <worldId> <zoneId> [--guidance "..."] [--plan file] [--seed s] [--paint]');
const w = loadWorld(worldId);
if (!w) throw new Error(`world ${worldId} not found`);
const z = w.zones.find((x) => x.id === zoneId);
if (!z || z.kind === 'interior') throw new Error(`no outer place ${zoneId}`);

const t0 = Date.now();
let design: PlaceDesign;
if (opt('plan')) design = JSON.parse(fs.readFileSync(opt('plan')!, 'utf8')) as PlaceDesign;
else {
  console.log(`Designing ${z.name}…`);
  design = await designBlueprint(w, z, { size: zoneSize(w, z.kind as 'town'), buildings: z.kind === 'town' ? buildingNames(w, z) : [], guidance: opt('guidance') });
  console.log(`Designed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
if (opt('save-plan')) fs.writeFileSync(opt('save-plan')!, JSON.stringify(design, null, 2));
console.log(design.blueprint.summary);
for (const a of design.blueprint.areas) console.log(`  ${a.count}× ${a.name} (${a.size}, ${a.enclosure}, ${a.where}, floor ${a.floor})${a.building ? ` [${a.building}]` : ''}: ${a.arrangements.map((r) => `${r.amount} ${r.prop} ${r.pattern}${r.with ? ` + ${r.with}` : ''}`).join(', ')}`);
console.log(`  props: ${design.props.map((p) => `${p.id} (${p.height}${p.size === 2 ? ' 2x2' : ''}${p.blocks ? '' : ' walkable'})`).join(', ')}`);
console.log(`  surfaces: ${design.surfaces.map((s) => s.id).join(', ') || 'none'}`);

const res = applyDesign(w, zoneId, design, opt('seed'));
console.log(`Rebuilt ${z.name}: ${res.width}x${res.height}${res.droppedPacks ? `, ${res.droppedPacks} packs dropped` : ''}`);

// An ASCII overview: letters are props, # walls, = corridors, symbols for surfaces.
const ts = w.tilesets[z.tilesetId]!;
const g = base64ToBytes(z.ground), o = base64ToBytes(z.objects);
const glyph = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
for (let y = 0; y < z.height; y++) {
  let row = '';
  for (let x = 0; x < z.width; x++) {
    const i = y * z.width + x, ob = o[i]!, gr = g[i]!, pi = propIndex(ob);
    const f = z.features.find((ff) => ff.x === x && ff.y === y);
    row += f ? (f.kind === 'exit' ? '@' : f.kind === 'door' ? 'D' : '*') : pi >= 0 ? glyph[pi] : ob === PROP_COVER || ob === PROP_COVER_TALL ? '%' : ob ? 'T' : gr === GROUND.wall ? '#' : gr === GROUND.water ? '~' : gr === GROUND.path ? '=' : gr === GROUND.floorAlt ? '.' : gr >= SURFACE_BASE ? '-+:;'[(gr - SURFACE_BASE) % 4] : gr === GROUND.void ? ' ' : ' ';
  }
  console.log(row);
}
console.log((ts.props ?? []).map((p, i) => `${glyph[i]}=${p.name}`).join('  '));
saveWorld(w);

async function paint() {
  const only = new Set([...(ts.props ?? []).map((p) => propKey(ts.id, p.id)), ...(ts.surfaces ?? []).map((s) => surfaceKey(ts.id, s.id))]);
  await generateArt(w!, 'full', (msg) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] ${msg}`), { phase: (id) => console.log(`== ${id}`), count: () => {} }, () => saveWorld(w!), undefined, only);
  linkAssets(w!);
  saveWorld(w!);
  await genai().releaseGpu();
}
if (args.includes('--paint') || args.includes('--review')) await paint();

// Review the painted place; with --revise, let the designer fix what the review found (up to two rounds).
if (args.includes('--review')) {
  const out = opt('out') ?? `${zoneId}-overview`;
  for (let round = 0; ; round++) {
    const png = await renderOverview(w, z);
    fs.writeFileSync(`${out}-${round}.png`, png);
    const r = await reviewPlace(w, z, png);
    console.log(`Review ${round}: ${r.score}/10, reads as: ${r.reads_as}`);
    for (const p of r.problems) console.log(`  - ${p}`);
    if (!args.includes('--revise') || r.score >= 7 || round >= 2) break;
    const d = await designBlueprint(w, z, { size: zoneSize(w, z.kind as 'town'), buildings: z.kind === 'town' ? buildingNames(w, z) : [], revise: { design: { blueprint: z.blueprint!, props: ts.props ?? [], surfaces: ts.surfaces ?? [] }, notes: r.problems } });
    if (opt('save-plan')) fs.writeFileSync(opt('save-plan')!.replace(/\.json$/, `-r${round + 1}.json`), JSON.stringify(d, null, 2));
    console.log(`Revised: ${d.blueprint.summary}`);
    applyDesign(w, zoneId, d, opt('seed'));
    saveWorld(w);
    await paint();
  }
}
console.log(`Done in ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
