/** Builds the list of art assets a world needs and generates them through the image pipeline. */
import type { AssetRecord, TileRole, WorldDefinition } from '@gd/shared';
import { z } from 'zod';
import { produceAssets, assetBrief, IMAGE_PROMPT_SYSTEM } from '../genai/images';
import { genai } from '../genai/service';
import { worldAssetDir } from '../storage';

const TEXTURE_ROLES: TileRole[] = ['floor', 'floorAlt', 'path', 'wall', 'water'];
const OBJECT_ROLES: TileRole[] = ['tree', 'rock', 'plant', 'light', 'furniture', 'pillar', 'chest', 'shrine', 'sign', 'lever', 'bed', 'rubble'];

export function planAssets(w: WorldDefinition, level: 'essential' | 'full'): AssetRecord[] {
  const out: AssetRecord[] = [];
  const add = (key: string, kind: AssetRecord['kind'], prompt: string) => {
    const prev = w.assets[key];
    if (!prev || prev.status !== 'ok') out.push({ key, kind, prompt, status: 'pending', imagePrompt: prev?.prompt === prompt ? prev.imagePrompt : undefined });
  };
  for (const ts of Object.values(w.tilesets)) {
    for (const r of TEXTURE_ROLES) add(`tex_${ts.id}_${r}`, 'texture', `${ts.roles[r].prompt || ts.roles[r].name}`);
    if (level === 'full') for (const r of OBJECT_ROLES) add(`obj_${ts.id}_${r}`, 'object', `${ts.roles[r].prompt || ts.roles[r].name}`);
  }
  for (const o of w.origins) add(`spr_origin_${o.id}`, 'sprite', `${o.appearance}, ${o.name}, heroic adventurer`);
  for (const n of w.npcs) add(`spr_npc_${n.id}`, 'sprite', `${n.appearance}, ${n.title}`);
  for (const f of w.families) for (const m of f.members) add(`spr_mon_${f.id}_${m.archetype}`, 'sprite', `${m.appearance || m.name}, ${m.name}, hostile creature`);
  for (const b of w.bosses) add(`spr_boss_${b.id}`, 'sprite', `${b.appearance}, ${b.name} ${b.title}, imposing boss`);
  if (level === 'full') for (const b of w.ruleset.items) if (b.category !== 'quest' && b.category !== 'key') add(`icon_${b.id}`, 'icon', `${b.name}${b.description ? `, ${b.description}` : ''}`);
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

const PromptBatch = z.object({ prompts: z.array(z.object({ key: z.string(), prompt: z.string().min(40).max(2400) })) });

/** Does any image purpose want long descriptive prompts written by the image.prompt LLM? */
function wantsDescriptive(): boolean {
  const g = genai();
  if (g.isProcedural('image.prompt')) return false;
  return (['image.texture', 'image.sprite', 'image.icon'] as const).some((p) => !g.isProcedural(p) && g.providerConfig(g.purpose(p).provider).promptStyle === 'descriptive');
}

/**
 * Turn short asset briefs into full descriptive prompts, in batches, while the text model is still resident
 * (so a local GPU swaps to the image model once). Assets without a written prompt fall back to a template.
 */
export async function writeImagePrompts(w: WorldDefinition, plan: AssetRecord[], report: (msg: string) => void, shouldStop?: () => boolean): Promise<void> {
  if (!wantsDescriptive()) return;
  const todo = plan.filter((r) => !r.imagePrompt);
  const BATCH = 8;
  let written = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    if (shouldStop?.()) return;
    const batch = todo.slice(i, i + BATCH);
    const briefs = batch.map((r) => `[${r.key}] ${assetBrief(r, w.concept.artStyle)}`).join('\n\n');
    try {
      const out = await genai().structured('image.prompt', {
        system: IMAGE_PROMPT_SYSTEM,
        prompt: `World: ${w.concept.title} — ${w.concept.pitch}
Write one prompt per brief below. Return each with the key shown in brackets.

${briefs}`,
        schema: PromptBatch,
        name: 'image_prompts',
        maxTokens: 400 * batch.length + 200,
      });
      for (const p of out.prompts) {
        const rec = batch.find((r) => r.key === p.key);
        if (rec) {
          rec.imagePrompt = p.prompt.trim();
          written++;
        }
      }
    } catch (e) {
      report(`Image prompts batch failed (${(e as Error).message.slice(0, 120)}); using template prompts`);
    }
    report(`Wrote ${written}/${todo.length} image prompts`);
  }
  for (const r of plan) if (r.imagePrompt) w.assets[r.key] = { ...(w.assets[r.key] ?? r), prompt: r.prompt, imagePrompt: r.imagePrompt };
}

export async function generateArt(w: WorldDefinition, level: 'essential' | 'full', report: (msg: string, frac: number) => void, onAsset?: () => void, shouldStop?: () => boolean): Promise<void> {
  const plan = planAssets(w, level);
  let done = 0;
  const outDir = worldAssetDir(w.id);
  await writeImagePrompts(w, plan, (m) => report(m, 0), shouldStop);
  // Textures first so worlds become visually coherent early. Batched so local GPUs swap models rarely.
  const ordered = [...plan.filter((p) => p.kind === 'texture'), ...plan.filter((p) => p.kind !== 'texture')];
  report(`Painting ${ordered.length} images…`, 0);
  // Chunks keep results flowing in while limiting model swaps (generate chunk → score chunk → retry rejects).
  const CHUNK = 64;
  for (let i = 0; i < ordered.length; i += CHUNK) {
    if (shouldStop?.()) return;
    await produceAssets(ordered.slice(i, i + CHUNK), w.concept.artStyle, outDir, w.seed, (res) => {
      w.assets[res.key] = res;
      done++;
      report(`${res.status === 'ok' ? 'Painted' : res.status === 'skipped' ? 'Skipped' : 'Failed'} ${res.key}${res.score !== undefined ? ` (score ${res.score.toFixed(1)}, ${res.attempts} tries)` : ''}${res.error ? ` — ${res.error.slice(0, 120)}` : ''}`, done / Math.max(1, ordered.length));
      linkAssets(w);
      onAsset?.();
    }, shouldStop);
  }
}
