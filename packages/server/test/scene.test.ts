import { describe, expect, it, beforeAll } from 'vitest';
import sharp from 'sharp';
import { GROUND, Rng, bytesToBase64, type WorldDefinition, type ZoneDef } from '@gd/shared';
import { renderScene } from '../src/worldgen/scene';

/** A tiny place: the left half floor, the right half water, a wall tile and nothing painted (flat colours). */
function place(): { w: WorldDefinition; z: ZoneDef } {
  const W = 12, H = 12;
  const ground = new Uint8Array(W * H).map((_, i) => ((i % W) < W / 2 ? GROUND.floor : GROUND.water));
  ground[5 * W + 2] = GROUND.wall;
  const role = (c: string) => ({ name: 'x', prompt: 'x', colors: [c] });
  const roles = Object.fromEntries(['floor', 'floorAlt', 'path', 'water', 'wall', 'tree', 'rock', 'plant', 'light', 'furniture', 'rubble', 'pillar', 'door', 'chest', 'exit', 'shrine', 'sign', 'lever', 'bed'].map((r) => [r, role('#808080')]));
  roles.floor = role('#c8b070');
  roles.water = role('#203060');
  const z = { id: 'z', name: 'Test', kind: 'wilderness', description: '', regionIndex: 0, levelRange: [1, 2], tilesetId: 'ts', width: W, height: H, ground: bytesToBase64(ground), objects: bytesToBase64(new Uint8Array(W * H)), features: [], spawns: [], mapPos: { x: 0, y: 0 }, links: [], entry: { x: 1, y: 1 }, familyIds: [] } as unknown as ZoneDef;
  const w = { id: 'w_scene_test', assets: {}, tilesets: { ts: { id: 'ts', name: 'T', style: 'stone', roles, ambient: 1, fogColor: '#000', lightColor: '#fff', outdoor: true } }, zones: [z] } as unknown as WorldDefinition;
  void Rng;
  return { w, z };
}

describe('scene block-out', () => {
  let px: (x: number, y: number) => [number, number, number];
  let s: Awaited<ReturnType<typeof renderScene>>;
  beforeAll(async () => {
    const { w, z } = place();
    s = await renderScene(w, z, { props: 'all', ids: true, flatGround: true });
    const { data, info } = await sharp(s.png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    px = (x, y) => {
      const p = { x: Math.round(s.ox + (x - y) * 32), y: Math.round(s.oy + (x + y) * 16) };
      const k = (p.y * info.width + p.x) * 3;
      return [data[k]!, data[k + 1]!, data[k + 2]!];
    };
  });

  it('keeps each surface in its own place (floor stays floor, water stays water)', () => {
    const floor = px(2, 8), water = px(9, 3);
    expect(floor[0]).toBeGreaterThan(150);
    expect(water[2]).toBeGreaterThan(water[0]!);
    expect(water[0]).toBeLessThan(80);
  });

  it('lists walls as objects and marks them in the id map', () => {
    const walls = s.objects.filter((o) => o.kind === 'wall');
    expect(walls).toHaveLength(1);
    const p = { x: Math.round(s.ox + (2 - 5) * 32), y: Math.round(s.oy + (2 + 5) * 16) - 20 };
    const k = (p.y * s.width + p.x) * 3;
    const id = ((s.ids![k]! << 16) | (s.ids![k + 1]! << 8) | s.ids![k + 2]!) - 1;
    expect(id).toBe(walls[0]!.id);
  });
});
