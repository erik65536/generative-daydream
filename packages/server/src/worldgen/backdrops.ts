/** Painting places and keeping the paintings with the world (files in its asset folder, the index on the zone). */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { WorldDefinition, ZoneDef } from '@gd/shared';
import { worldAssetDir } from '../storage';
import { cutOccluders, paintPlace, upscale2x, type PaintOptions } from './painter';
import { renderScene } from './scene';

export async function paintBackdrop(w: WorldDefinition, z: ZoneDef, o: PaintOptions = {}): Promise<void> {
  const painted = await paintPlace(w, z, o);
  const scene = painted.scene;
  // Twice the game's resolution, so high-density screens and zooming in stay sharp.
  const sharp2 = o.sharpen === false || painted.scale > 1 ? null : await upscale2x(painted.painting, o.seed ?? 7, o.report);
  const painting = sharp2 ?? painted.painting;
  const scale = sharp2 ? 2 : painted.scale;
  o.report?.(`Cutting out ${scene.objects.length} walls and things of ${z.name}`);
  const { atlas, pieces } = await cutOccluders(painting, scene, scale);
  const dir = worldAssetDir(w.id);
  fs.mkdirSync(dir, { recursive: true });
  // A version in the file name, so browsers never show a stale painting after a repaint.
  const v = Date.now().toString(36);
  const image = `bd_${z.id}`, atlasKey = `bdo_${z.id}`;
  const imageFile = `${image}_${v}.webp`, atlasFile = `${atlasKey}_${v}.webp`;
  fs.writeFileSync(path.join(dir, imageFile), await sharp(painting).webp({ quality: 90 }).toBuffer());
  fs.writeFileSync(path.join(dir, atlasFile), await sharp(atlas).webp({ lossless: true, exact: true }).toBuffer());
  // Older versions of this place's painting go.
  for (const f of fs.readdirSync(dir)) if ((f.startsWith(`${image}_`) || f.startsWith(`${atlasKey}_`)) && f !== imageFile && f !== atlasFile) fs.rmSync(path.join(dir, f));
  w.assets[image] = { key: image, kind: 'texture', file: imageFile, prompt: `painted backdrop of ${z.name}`, status: 'ok', width: scene.width, height: scene.height };
  w.assets[atlasKey] = { key: atlasKey, kind: 'texture', file: atlasFile, prompt: `cut-outs of ${z.name}`, status: 'ok' };
  z.backdrop = { image, atlas: atlasKey, width: scene.width, height: scene.height, ox: scene.ox, oy: scene.oy, scale, pieces, ...(painted.brief ? { brief: painted.brief } : {}) };
  w.updatedAt = Date.now();
}

/** Cut a place's existing painting out again (after the cut-out rules change), without repainting it. */
export async function recutBackdrop(w: WorldDefinition, z: ZoneDef): Promise<void> {
  const bd = z.backdrop;
  if (!bd) throw new Error(`${z.name} has no painting.`);
  const dir = worldAssetDir(w.id);
  const painting = await sharp(path.join(dir, w.assets[bd.image]!.file!)).png().toBuffer();
  const scene = await renderScene(w, z, { props: 'all', ids: true, flatGround: true });
  const { atlas, pieces } = await cutOccluders(painting, scene, bd.scale ?? 1);
  const v = Date.now().toString(36);
  const atlasFile = `${bd.atlas}_${v}.webp`;
  fs.writeFileSync(path.join(dir, atlasFile), await sharp(atlas).webp({ lossless: true, exact: true }).toBuffer());
  const old = w.assets[bd.atlas]?.file;
  if (old && old !== atlasFile) fs.rmSync(path.join(dir, old), { force: true });
  w.assets[bd.atlas] = { ...w.assets[bd.atlas]!, file: atlasFile };
  z.backdrop = { ...bd, pieces };
}
