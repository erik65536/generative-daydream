/**
 * Zod schemas for each world-generation LLM call. Kept small and enum-constrained so that
 * modest local models can satisfy them. Everything optional is backfilled from procedural content.
 */
import { z } from 'zod';
import { MERCHANT_KINDS, MONSTER_ARCHETYPES, NPC_ROLES, OBJECTIVE_TYPES, TILE_ROLES, LAYOUT_STRUCTURES } from '@gd/shared';

const str = (max: number, min = 1) => z.string().trim().min(min).max(max);
/** Lenient color: models may answer '#a1b2c3', 'a1b2c3', '#abc' or a color name; normalized later by normColor(). */
const hex = z.string().max(24).describe('Hex color such as #6a8a3a');

const NAMED: Record<string, string> = {
  black: '#202020', white: '#f0f0f0', gray: '#808080', grey: '#808080', red: '#b03030', crimson: '#a01830', green: '#4a8a3a', blue: '#3a5aa0',
  yellow: '#d8c040', gold: '#d0a040', orange: '#d07a30', purple: '#7a4a9a', violet: '#8a5ac0', brown: '#7a5232', pink: '#d880a0', teal: '#3a8a8a',
  cyan: '#40c0d0', silver: '#c0c0c8', beige: '#d8c8a0', tan: '#c0a070', navy: '#283868', olive: '#6a7a30', maroon: '#702028', ivory: '#f0ead0',
};

export function normColor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const t = c.trim().toLowerCase();
  const m6 = t.match(/^#?([0-9a-f]{6})$/);
  if (m6) return `#${m6[1]}`;
  const m3 = t.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  for (const [name, v] of Object.entries(NAMED)) if (t.includes(name)) return v;
  return undefined;
}

export function normColors(list: string[] | undefined): string[] {
  return (list ?? []).map(normColor).filter((x): x is string => !!x);
}
export const TILESET_STYLES = ['grass', 'stone', 'sand', 'snow', 'dirt', 'wood', 'metal', 'crystal', 'flesh', 'void'] as const;
export const WEATHER = ['none', 'rain', 'snow', 'ash', 'spores', 'embers', 'dust', 'fireflies'] as const;


export const ConceptSchema = z.object({
  title: str(80, 2),
  pitch: str(700, 10),
  genre: str(60),
  tone: str(240),
  artStyle: str(300).describe('Comma-separated visual style keywords used for every generated image.'),
  playerRole: str(240),
  intro: str(1600, 40).describe('Opening narration (80-150 words) read when a new game starts. Do not reveal the secret.'),
  secret: str(900, 10).describe('The hidden truth the story builds toward. Never revealed early.'),
  villain: z.object({ name: str(60), title: str(80), motive: str(400) }),
  palette: z.object({ primary: hex, secondary: hex, accent: hex }).optional(),
  factions: z.array(z.object({ name: str(60), description: str(300) })).max(5),
  worldFacts: z.array(str(300)).max(14),
});
export type ConceptOut = z.infer<typeof ConceptSchema>;

/** A zone's level design in neutral terms (every field optional; the engine fills gaps per zone kind). */
export const LayoutPlanSchema = z.object({
  structure: z.enum(LAYOUT_STRUCTURES).optional(),
  enclosed: z.boolean().optional(),
  blockers: z.object({ amount: z.enum(['sparse', 'some', 'dense']).optional(), arrangement: z.enum(['scattered', 'clusters', 'rows', 'edges']).optional() }).optional(),
  hazard: z.enum(['none', 'pools', 'river', 'channels']).optional(),
  structures: z.enum(['roofed', 'walled']).optional(),
  clutter: z.enum(['sparse', 'some', 'dense']).optional(),
});
export type LayoutPlanOut = z.infer<typeof LayoutPlanSchema>;

/** One entry per region and per place (exact counts, so a strict model cannot leave one out). */
export function atlasSchema(slotIds: string[], regionCount?: number) {
  const regions = z.array(z.object({ index: z.coerce.number().int(), name: str(60), description: str(400) }));
  return z.object({
    regions: regionCount ? regions.min(regionCount).max(regionCount) : regions,
    zones: z.array(
      z.object({
        slotId: z.enum(slotIds as [string, ...string[]]),
        name: str(60),
        description: str(500, 10),
        biome: z.enum(TILESET_STYLES),
        layout: LayoutPlanSchema.optional(),
        lore: str(600).optional(),
      }),
    ).min(slotIds.length).max(slotIds.length),
  });
}
export type AtlasOut = z.infer<ReturnType<typeof atlasSchema>>;

export function storySchema(townSlots: string[], dungeonSlots: string[], allSlots: string[]) {
  const objective = z.object({
    type: z.enum(OBJECTIVE_TYPES),
    description: str(240),
    npcKey: z.string().optional(),
    bossKey: z.string().optional(),
    itemKey: z.string().optional(),
    zoneSlot: z.enum(allSlots as [string, ...string[]]).optional(),
    familyHint: z.string().optional(),
    count: z.coerce.number().int().min(1).max(12).optional(),
  });
  return z.object({
    keyNpcs: z
      .array(
        z.object({
          key: str(40),
          name: str(60),
          title: str(80),
          role: z.enum(NPC_ROLES),
          townSlot: z.enum(townSlots as [string, ...string[]]),
          pronouns: str(20).optional(),
          personality: str(300),
          appearance: str(300),
          backstory: str(500),
          secret: str(400).optional(),
        }),
      )
      .min(2)
      .max(10),
    bosses: z
      .array(
        z.object({
          key: str(40),
          name: str(60),
          title: str(80),
          description: str(400),
          appearance: str(300),
          dungeonSlot: z.enum(dungeonSlots as [string, ...string[]]),
          archetype: z.enum(MONSTER_ARCHETYPES),
          taunt: str(240).optional(),
        }),
      )
      .min(1),
    keyItems: z.array(z.object({ key: str(40), name: str(60), description: str(300), kind: z.enum(['relic', 'weapon', 'armor', 'trinket', 'document']) })).max(10),
    arcs: z
      .array(
        z.object({
          title: str(80),
          summary: str(600),
          revelation: str(700).describe('Narration revealed when this arc completes; this is where twists land.'),
          quests: z
            .array(
              z.object({
                title: str(80),
                summary: str(400),
                giverKey: z.string(),
                turnInKey: z.string().optional(),
                objectives: z.array(objective).min(1).max(6),
                completionText: str(500).optional(),
              }),
            )
            .min(1)
            .max(6),
        }),
      )
      .min(1),
    ending: str(1500, 20),
  });
}
export type StoryOut = z.infer<ReturnType<typeof storySchema>>;

export const FamiliesSchema = z.object({
  families: z
    .array(
      z.object({
        name: str(48),
        description: str(300),
        element: z.string().max(40).describe('Name of the damage subtype (or damage type) they deal'),
        habitat: str(120).describe('Space-separated words for where they live, e.g. "forest cave swamp".'),
        colors: z.array(hex).min(1).max(4),
        members: z.array(z.object({ archetype: z.enum(MONSTER_ARCHETYPES), name: str(48), description: str(240), appearance: str(240) })).min(2).max(5),
      }),
    )
    .min(2),
});
export type FamiliesOut = z.infer<typeof FamiliesSchema>;

const roleDef = z.object({ name: str(40), colors: z.array(hex).min(1).max(3), prompt: str(200) });
export const RoleDefSchema = roleDef;
export const TilesetSchema = z.object({
  name: str(60),
  style: z.enum(TILESET_STYLES),
  ambient: z.coerce.number().min(0).max(1).optional(),
  weather: z.enum(WEATHER).optional(),
  lightColor: hex.optional(),
  roles: z.object(Object.fromEntries(TILE_ROLES.map((r) => [r, roleDef.optional()])) as Record<(typeof TILE_ROLES)[number], z.ZodOptional<typeof roleDef>>),
});
export type TilesetOut = z.infer<typeof TilesetSchema>;

const npcSchema = z.object({
  name: str(60),
  title: str(80),
  role: z.enum(NPC_ROLES),
  merchantKind: z.enum(MERCHANT_KINDS).optional(),
  pronouns: str(20).optional(),
  personality: str(300),
  appearance: str(300),
  backstory: str(500),
  knowledge: z.array(str(300)).max(6),
  secrets: z.array(str(300)).max(3).optional(),
  voice: str(160).optional(),
  greeting: str(300),
  barks: z.array(str(140)).max(4),
  canJoinParty: z.boolean().optional(),
  friends: z.array(z.string()).max(4).optional(),
});
export type NpcOut = z.infer<typeof npcSchema>;

const sideObjective = z.object({
  type: z.enum(OBJECTIVE_TYPES),
  description: str(240),
  target: z.string().optional().describe('Name of the NPC, monster family, item, or place this objective refers to.'),
  count: z.coerce.number().int().min(1).max(12).optional(),
});

export const TownContentSchema = z.object({
  npcs: z.array(npcSchema).min(1),
  buildings: z.array(z.object({ name: str(60), purpose: str(80) })).max(12),
  sideQuests: z.array(z.object({ title: str(80), summary: str(400), giverName: z.string(), objectives: z.array(sideObjective).min(1).max(4), rewardItem: z.string().optional(), completionText: str(400).optional() })),
  tileset: TilesetSchema,
  interiorTileset: TilesetSchema,
  signText: str(300).optional(),
});
export type TownContentOut = z.infer<typeof TownContentSchema>;

export const AreaContentSchema = z.object({
  tileset: TilesetSchema,
  loreNotes: z.array(z.object({ title: str(80), text: str(900, 20) })).max(3),
  shrineName: str(60).optional(),
  signText: str(300).optional(),
});
export type AreaContentOut = z.infer<typeof AreaContentSchema>;
