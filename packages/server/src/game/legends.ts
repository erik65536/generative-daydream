/**
 * Named legendary drops. A piece of top-rarity gear is dropped as rolled, then a text model gives it a name, a
 * short legend tied to where and from whom it came, and two signature bonuses chosen from what that kind of gear
 * may carry. The engine sets the numbers. If the model is unavailable, the item simply stays an unnamed legendary.
 */
import { z } from 'zod';
import { rx, uid, type ItemInstance, type Modifier, type Ruleset, type UniqueItemDef } from '@gd/shared';
import { genai } from '../genai/service';
import { affixValue } from './loot';

export const isTopRarity = (r: Ruleset, item: ItemInstance) => item.rarityId === r.rarities[r.rarities.length - 1]!.id && !item.uniqueId && rx(r).item.get(item.baseId)?.category === 'equipment';

export interface LegendContext {
  world: { title: string; pitch: string; tone: string };
  /** Where it was found ("The Glass Mile"), and from whom or what ("the Lenswight Matriarch", "a sealed parts locker"). */
  place: string;
  source: string;
}

export async function forgeLegend(r: Ruleset, item: ItemInstance, ctx: LegendContext): Promise<{ def: UniqueItemDef; mods: Modifier[] } | null> {
  const g = genai();
  if (g.isProcedural('narration')) return null;
  const ix = rx(r);
  const base = ix.item.get(item.baseId);
  const kind = base?.slotId ? ix.slot.get(base.slotId)?.kind : undefined;
  if (!base || !kind) return null;
  const have = new Set([...item.affixes.map((a) => ix.affix.get(a.affixId)?.stat), ...(base.implicit ?? []).map((m) => m.stat)]);
  const options = r.affixes.filter((a) => a.slotKinds.includes(kind) && !have.has(a.stat));
  if (options.length < 2) return null;
  const label = (id: string) => {
    const a = ix.affix.get(id)!;
    return `${a.prefix} / ${a.suffix}`;
  };
  const schema = z.object({
    name: z.string().describe('2-5 words, a proper name for this one item (not the base item name with an adjective)'),
    legend: z.string().describe('1-2 sentences of its history, under 200 characters, in the world\'s voice'),
    signatures: z.array(z.enum(options.map((a) => a.id) as [string, ...string[]])).min(2).max(2).describe('the two powers that best fit its legend'),
  });
  try {
    const out = await g.structured('narration', {
      system: 'You name legendary items for a role-playing game. Names are evocative and specific to the world; never generic fantasy unless the world is.',
      prompt: [
        `World: "${ctx.world.title}" — ${ctx.world.pitch} Tone: ${ctx.world.tone}.`,
        `The item: ${base.name}${base.description ? ` (${base.description})` : ''}, found in ${ctx.place}, from ${ctx.source}.`,
        `Possible signature powers (id: name as prefix / suffix): ${options.map((a) => `${a.id}: ${label(a.id)}`).join('; ')}.`,
        'Give it a name, a short legend, and pick its two signature powers.',
      ].join('\n'),
      schema,
      name: 'legendary_item',
      maxTokens: 400,
    });
    const top = r.rarities[r.rarities.length - 1]!.id;
    const mods: Modifier[] = [...new Set(out.signatures)].map((id) => ({ stat: ix.affix.get(id)!.stat, value: affixValue(r, id, item.level, top, 0.9) }));
    const def: UniqueItemDef = { id: uid('u_leg'), baseId: item.baseId, name: out.name.trim().slice(0, 48), description: out.legend.trim().slice(0, 240), rarityId: top, mods };
    return { def, mods };
  } catch (e) {
    console.warn('[legend] naming failed:', (e as Error).message);
    return null;
  }
}
