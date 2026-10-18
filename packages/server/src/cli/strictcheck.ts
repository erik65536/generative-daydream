/** Send every model-facing schema to OpenAI in strict mode with a tiny output cap: rejected schemas fail at once. */
import { z } from 'zod';
import { strictSchema } from '../genai/json';
import * as S from '../worldgen/schemas';
import * as I from '../rules/intent';
import { DirectionSchema, PromptBatch } from '../worldgen/art';
import { NpcRewrite, QuestRewrite, ZoneRewrite } from '../worldgen/studio';
import { ReviewSchema } from '../rules/generate';
import '../paths';

const schemas: Record<string, z.ZodType> = {
  concept: S.ConceptSchema, atlas: S.atlasSchema(['t0', 'w0', 'd0']), story: S.storySchema(['t0'], ['d0'], ['t0', 'w0', 'd0']), families: S.FamiliesSchema,
  town: S.TownContentSchema, area: S.AreaContentSchema, core: I.CoreIntentSchema, gear: I.GearIntentSchema, classes: I.ClassesIntentSchema, skill: I.SkillIntentSchema,
  tree: I.ClassTreeIntentSchema, review: ReviewSchema, direction: DirectionSchema, prompts: PromptBatch, npc: NpcRewrite, quest: QuestRewrite, zone: ZoneRewrite,
};
let bad = 0;
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-6-luna', input: 'Return a minimal example.', max_output_tokens: 16, reasoning: { effort: 'none' }, text: { format: { type: 'json_schema', name, schema: strictSchema(json as never), strict: true } } }),
  });
  const data = (await res.json()) as { error?: { message: string }; status?: string };
  if (res.status !== 200) bad++;
  console.log(`${res.status === 200 ? 'ok ' : 'BAD'} ${name.padEnd(10)} ${res.status} ${data.error?.message?.slice(0, 220) ?? data.status}`);
}
console.log(bad ? `${bad} schema(s) rejected` : 'all schemas accepted');
