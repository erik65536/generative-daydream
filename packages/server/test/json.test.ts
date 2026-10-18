import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clampToSchema } from '../src/genai/json';

describe('fitting model output to schema limits', () => {
  it('shortens long text and drops extra list items instead of failing', () => {
    const Schema = z.object({
      buildings: z.array(z.object({ name: z.string().max(40), purpose: z.string().max(80) })).max(8),
      sideQuests: z.array(z.object({ title: z.string().max(60), objectives: z.array(z.object({ description: z.string().max(120) })).max(4) })).max(3),
      note: z.string().max(30).optional(),
    });
    const json = z.toJSONSchema(Schema, { unrepresentable: 'any' }) as Record<string, unknown>;
    const raw = {
      buildings: Array.from({ length: 9 }, (_, i) => ({ name: `Hall ${i}`, purpose: 'A cavernous maintenance depot where the night crew repairs rolling stock, stores signal lamps and argues about the schedule.' })),
      sideQuests: [{ title: 'Lost Lantern', objectives: Array.from({ length: 6 }, (_, i) => ({ description: `Step ${i}` })) }],
      note: 'short',
    };
    expect(Schema.safeParse(raw).success).toBe(false);
    const fixed = clampToSchema(raw, json);
    const r = Schema.safeParse(fixed);
    expect(r.success).toBe(true);
    const d = r.data!;
    expect(d.buildings).toHaveLength(8);
    expect(d.buildings[0]!.purpose.length).toBeLessThanOrEqual(80);
    expect(d.buildings[0]!.purpose).not.toMatch(/\s$/);
    expect(d.sideQuests[0]!.objectives).toHaveLength(4);
    expect(d.note).toBe('short');
  });
});

describe('strict structured-output schemas', () => {
  it('compiles to the strict subset and restores optional fields', async () => {
    const { strictSchema, restoreOptional } = await import('../src/genai/json');
    const Schema = z.object({
      name: z.string().max(40),
      lore: z.string().max(200).optional(),
      kind: z.enum(['a', 'b']).optional(),
      items: z.array(z.object({ id: z.string(), count: z.number().int().min(1).max(9).optional() })).min(1).max(3),
    });
    const json = z.toJSONSchema(Schema, { unrepresentable: 'any' }) as never;
    const strict = strictSchema(json) as { required: string[]; additionalProperties: boolean; properties: Record<string, { type?: unknown; enum?: unknown[]; description?: string; maxLength?: number; items?: { additionalProperties: boolean; required: string[] }; maxItems?: number }> };
    expect(strict.required).toEqual(['name', 'lore', 'kind', 'items']);
    expect(strict.additionalProperties).toBe(false);
    expect(strict.properties.name!.maxLength).toBeUndefined();
    expect(strict.properties.name!.description).toMatch(/at most 40 characters/);
    expect(strict.properties.lore!.type).toEqual(['string', 'null']);
    expect(strict.properties.kind!.enum).toContain(null);
    expect(strict.properties.items!.maxItems).toBe(3);
    expect(strict.properties.items!.items!.required).toEqual(['id', 'count']);
    // What a strict model returns: every key present, absent ones as null.
    const fromModel = { name: 'Depot', lore: null, kind: null, items: [{ id: 'x', count: null }] };
    expect(Schema.safeParse(fromModel).success).toBe(false);
    const restored = restoreOptional(fromModel, json);
    expect(Schema.parse(restored)).toEqual({ name: 'Depot', items: [{ id: 'x' }] });
  });
});
