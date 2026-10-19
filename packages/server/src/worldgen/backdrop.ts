/**
 * Painted backdrops: the prompts that turn a place's block-out (its ground, walls and props, drawn at the game's
 * scale) into one illustration: the painter's prompt, and the art director's brief it follows.
 */
import { z } from 'zod';
import type { TilesetDef, WorldDefinition, ZoneDef } from '@gd/shared';
import { genai } from '../genai/service';
import { conceptSummary } from './prompts';

/** The painter's brief for a full block-out (real ground, walls and props): repaint it as one finished scene. */
export function scenePrompt(w: WorldDefinition, z: ZoneDef, brief?: string): string {
  const areas = z.blueprint?.areas.map((a) => `${a.name}: ${a.purpose}`).join(' ') ?? '';
  const ts = w.tilesets[z.tilesetId];
  const hasWater = Buffer.from(z.ground, 'base64').includes(4);
  const water = hasWater ? ` The flat blue areas are water (${ts?.roles.water.name ?? 'water'}): paint them as that liquid, at the same level as the ground beside them, with its shoreline exactly where the blue ends.` : '';
  return `Picture 1 is a rough block-out of one whole place in a 2D isometric RPG, seen from above at the game's fixed isometric camera angle: its floors, walls, buildings and furniture, each roughly drawn in place.
Repaint it as a finished, beautiful hand-painted isometric game map, in the spirit of the painted backgrounds of Pillars of Eternity, Disco Elysium and Diablo II: one coherent illustration with consistent lighting, colour and detail everywhere.
Keep the camera, framing and layout exactly: every wall, building and piece of furniture stays where it is, at the same size, so the map still matches the game. Within that, you have full creative freedom: redesign the floor surfaces and walls with real materials, patterns, borders and thresholds; add rugs, worn paths, scuffs, stains, cracks, puddles, cables, papers, small story details; light the scene with pools of light, cast shadows and soft occlusion where things meet the floor; make every object look like it belongs to the same painting. Keep open floor walkable and uncluttered: add nothing that stands up from the floor where the block-out has none. Buildings stay closed solid blocks with their walls and a roof or ceiling on top (their insides are elsewhere); a doorway is just a door in the wall. No people, no text or letters.${water}
${brief ? `ART DIRECTION FOR THIS PLACE: ${brief}` : `The place: ${z.name}: ${z.description}${areas ? `
Its parts: ${areas}` : ''}`}
Art style: ${w.concept.artStyle}. Rich, readable, atmospheric, strong light and shade.`;
}

const BriefSchema = z.object({ brief: z.string().min(200).max(1600) });

/**
 * The art director's brief for painting a place: mood and light, what the walls and each area's floor are made
 * of, the small details that tell its story, and a palette, grounded in the place's floor plan and surfaces.
 */
export async function writePaintBrief(w: WorldDefinition, zone: ZoneDef, guidance?: string): Promise<string> {
  const ts = w.tilesets[zone.tilesetId]!;
  const areas = zone.blueprint?.areas.map((a) => `- ${a.name} (${a.purpose}); floor: ${floorName(ts, a.floor)}`).join('\n') ?? '';
  const out = await genai().structured('world.design', {
    system: 'You are the art director of a 2D isometric RPG with hand-painted backgrounds in the spirit of Pillars of Eternity, Disco Elysium and Diablo II. You write the brief a painter follows to paint one whole place as a single illustration.',
    prompt: `${conceptSummary(w.concept as never)}

PLACE: ${zone.name}: ${zone.description}
${zone.lore ? `Its history: ${zone.lore}
` : ''}Walls: ${ts.roles.wall.name} (${ts.roles.wall.prompt}).
Its areas:
${areas}
Art style of the world: ${w.concept.artStyle}
${guidance ? `
THE OWNER'S DIRECTION: ${guidance}
` : ''}
Write the painter's brief (120-220 words): the mood and the light (where it comes from, its colour, where the shadows pool), the real materials of the walls and of each area's floor with their wear and age, a few small story details on the ground per area (stains, scuffs, papers, rugs, puddles, debris that fit this place), and a palette of 4-6 colours. The layout and furniture are fixed already: describe surfaces, light and atmosphere, not new furniture. Make it beautiful and specific to this place, never generic. No text or signage. No fog, mist, haze or smoke over the ground (the game adds weather itself); every part of the map stays clearly visible, and water stays water at ground level.`,
    schema: BriefSchema,
    name: 'paint_brief',
    maxTokens: 1500,
  });
  return out.brief.trim();
}

function floorName(ts: TilesetDef, floor: string): string {
  if (floor === 'floor' || floor === 'floorAlt' || floor === 'path' || floor === 'water') return ts.roles[floor].name;
  return ts.surfaces?.find((s) => s.id === floor)?.name ?? floor;
}
