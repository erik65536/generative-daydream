/** Builds the list of art assets a world needs and generates them through the image pipeline. */
import type { AssetRecord, TileRole, WorldDefinition } from '@gd/shared';
import { produceAsset } from '../genai/images';
import { worldAssetDir } from '../storage';

const TEXTURE_ROLES: TileRole[] = ['floor', 'floorAlt', 'path', 'wall', 'water'];
const OBJECT_ROLES: TileRole[] = ['tree', 'rock', 'plant', 'light', 'furniture', 'pillar', 'chest', 'shrine', 'sign', 'lever', 'bed', 'rubble'];

export function planAssets(w: WorldDefinition, level: 'essential' | 'full'): AssetRecord[] {
  const out: AssetRecord[] = [];
  const add = (key: string, kind: AssetRecord['kind'], prompt: string) => {
    if (!w.assets[key] || w.assets[key]!.status !== 'ok') out.push({ key, kind, prompt, status: 'pending' });
  };
  for (const ts of Object.values(w.tilesets)) {
    for (const r of TEXTURE_ROLES) add(`tex_${ts.id}_${r}`, 'texture', `${ts.roles[r].prompt || ts.roles[r].name}`);
    if (level === 'full') for (const r of OBJECT_ROLES) add(`obj_${ts.id}_${r}`, 'object', `${ts.roles[r].prompt || ts.roles[r].name}`);
  }
  for (const o of w.origins) add(`spr_origin_${o.id}`, 'sprite', `${o.appearance}, ${o.name}, heroic adventurer`);
  for (const n of w.npcs) add(`spr_npc_${n.id}`, 'sprite', `${n.appearance}, ${n.title}`);
  for (const f of w.families) for (const m of f.members) add(`spr_mon_${f.id}_${m.archetype}`, 'sprite', `${m.appearance || m.name}, ${m.name}, hostile creature`);
  for (const b of w.bosses) add(`spr_boss_${b.id}`, 'sprite', `${b.appearance}, ${b.name} ${b.title}, imposing boss`);
  if (level === 'full') for (const [baseId, n] of Object.entries(w.itemNames)) add(`icon_${baseId}`, 'icon', `${n.names[0]}${n.description ? `, ${n.description}` : ''}`);
  return out;
}

/** Point world entities at generated assets. */
export function linkAssets(w: WorldDefinition) {
  const ok = (k: string) => (w.assets[k]?.status === 'ok' ? k : undefined);
  for (const ts of Object.values(w.tilesets)) for (const r of Object.keys(ts.roles) as TileRole[]) ts.roles[r].asset = ok(`tex_${ts.id}_${r}`) ?? ok(`obj_${ts.id}_${r}`);
  for (const o of w.origins) o.asset = ok(`spr_origin_${o.id}`);
  for (const n of w.npcs) n.asset = ok(`spr_npc_${n.id}`);
  for (const f of w.families) for (const m of f.members) m.asset = ok(`spr_mon_${f.id}_${m.archetype}`);
  for (const b of w.bosses) b.asset = ok(`spr_boss_${b.id}`);
}

export async function generateArt(w: WorldDefinition, level: 'essential' | 'full', report: (msg: string, frac: number) => void, onAsset?: () => void, shouldStop?: () => boolean): Promise<void> {
  const plan = planAssets(w, level);
  let done = 0;
  const outDir = worldAssetDir(w.id);
  // Textures first so worlds become visually coherent early; all requests share provider limiters.
  const queue = [...plan.filter((p) => p.kind === 'texture'), ...plan.filter((p) => p.kind !== 'texture')];
  const workers = Array.from({ length: 3 }, async () => {
    for (;;) {
      if (shouldStop?.()) return;
      const rec = queue.shift();
      if (!rec) return;
      const res = await produceAsset(rec, w.concept.artStyle, outDir, w.seed);
      w.assets[rec.key] = res;
      done++;
      report(`${res.status === 'ok' ? 'Painted' : res.status === 'skipped' ? 'Skipped' : 'Failed'} ${rec.key}${res.score !== undefined ? ` (score ${res.score.toFixed(1)})` : ''}${res.error ? ` — ${res.error.slice(0, 120)}` : ''}`, done / Math.max(1, plan.length));
      linkAssets(w);
      onAsset?.();
    }
  });
  await Promise.all(workers);
}
