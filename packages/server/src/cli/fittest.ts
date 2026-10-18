/** Live check: a field over its limit is rewritten on its own, not regenerated with the whole answer. */
import { z } from 'zod';
import { genai } from '../genai/service';
import { openaiCost } from '../genai/providers';

const Schema = z.object({ name: z.string().max(40), purpose: z.string().max(60), rooms: z.array(z.string().max(30)).max(3) });
const out = await genai().structured('world.content', {
  prompt: 'Invent one building for a subway maintenance town. Give it a name, a "purpose" written as three long, detailed sentences, and list six rooms with long descriptive names.',
  schema: Schema,
  name: 'building',
  maxTokens: 1500,
});
console.log(JSON.stringify(out, null, 2));
console.log(`≈ $${openaiCost().toFixed(4)}`);
for (const r of genai().recent.slice(-4)) console.log(r.ok ? 'ok ' : 'ERR', r.attempt, r.preview ?? r.error ?? '');
process.exit(0);
