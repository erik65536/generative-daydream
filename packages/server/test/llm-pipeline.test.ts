/**
 * Runs world generation and NPC dialogue through the real OpenAI-compatible provider against a mock server that
 * answers with schema-valid (but semantically random) JSON — and sometimes with junk — to prove the pipeline,
 * validation, retries and fallbacks hold up with weak models.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reloadGenAI, genai } from '../src/genai/service';
import { WorldGenJob, runGeneration } from '../src/worldgen/pipeline';
import { loadWorld } from '../src/storage';
import { instances } from '../src/game/manager';
import { validateWorld } from './helpers';

type Json = Record<string, unknown>;
let counter = 0;

/** Produce an instance of a JSON schema. */
function fake(schema: Json, root: Json, key = 'value'): unknown {
  if (schema.$ref) {
    const ref = String(schema.$ref).replace(/^#\/(\$defs|definitions)\//, '');
    const defs = (root.$defs ?? root.definitions) as Record<string, Json>;
    return fake(defs[ref]!, root, key);
  }
  for (const k of ['anyOf', 'oneOf'] as const) if (Array.isArray(schema[k])) return fake((schema[k] as Json[]).find((s) => s.type !== 'null') ?? (schema[k] as Json[])[0]!, root, key);
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[])[counter++ % (schema.enum as unknown[]).length];
  if (schema.const !== undefined) return schema.const;
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Json = {};
      const props = (schema.properties ?? {}) as Record<string, Json>;
      for (const [k, v] of Object.entries(props)) if ((schema.required as string[] | undefined)?.includes(k) || counter++ % 2 === 0) out[k] = fake(v, root, k);
      return out;
    }
    case 'array': {
      const min = Number(schema.minItems ?? 1), max = Number(schema.maxItems ?? Math.max(min, 3));
      const n = Math.min(max, Math.max(min, 3));
      return Array.from({ length: n }, () => fake((schema.items ?? {}) as Json, root, key));
    }
    case 'string': {
      if (schema.pattern && String(schema.pattern).includes('0-9a-fA-F')) return '#7a6a5a';
      const max = Number(schema.maxLength ?? 60);
      const base = `${key} ${++counter} of the mock world, written plainly`;
      const min = Number(schema.minLength ?? 1);
      return base.padEnd(min, ' x').slice(0, Math.max(min, Math.min(max, base.length)));
    }
    case 'integer':
    case 'number': {
      const min = Number(schema.minimum ?? 1), max = Number(schema.maximum ?? 5);
      return Math.max(min, Math.min(max, Math.round((min + max) / 2)));
    }
    case 'boolean':
      return counter++ % 2 === 0;
    default:
      return `${key} ${++counter}`;
  }
}

let server: http.Server;
let port = 0;
const seen: { name: string; ok: boolean }[] = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-llm-'));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body);
      const rf = data.response_format;
      const name: string = rf?.json_schema?.name ?? 'text';
      let content: string;
      if (!rf) content = 'Well met, traveler.';
      else if (name === 'npc_turn') {
        const prompt = JSON.stringify(data.messages);
        const quest = prompt.match(/(q_side_[\w]+)/)?.[1];
        content = JSON.stringify({ actions: quest ? [{ type: 'offer_quest', questId: quest }, { type: 'remember', memory: 'The player asked for work.', spread: 'town' }] : [{ type: 'none' }], emotion: 'happy', speech: 'Mock NPC says hello and has a job for you.' });
      } else if (name === 'main_story' && seen.filter((s) => s.name === name).length === 0) {
        // First attempt at the story: junk, to exercise the retry path.
        content = 'Sure! Here is the story: {"arcs": [ oops';
      } else content = '```json\n' + JSON.stringify(fake(rf.json_schema.schema, rf.json_schema.schema, name)) + '\n```';
      seen.push({ name, ok: true });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  port = (server.address() as { port: number }).port;
  const cfg = {
    providers: { mock: { type: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock', structured: 'json_schema', concurrency: 4 } },
    purposes: Object.fromEntries(['world.design', 'world.content', 'npc.decision', 'narration'].map((p) => [p, { provider: 'mock', retries: 1 }])),
    combineNpcDecisionAndDialogue: true,
    worldGenParallelism: 3,
  };
  fs.writeFileSync(path.join(tmp, 'genai.json'), JSON.stringify(cfg));
  process.env.GD_GENAI_CONFIG = path.join(tmp, 'genai.json');
  reloadGenAI();
});

afterAll(() => {
  server.close();
  delete process.env.GD_GENAI_CONFIG;
  reloadGenAI();
});

describe('LLM pipeline against a mock OpenAI-compatible server', () => {
  it('generates a valid world from model output (including a junk response)', async () => {
    const job = new WorldGenJob(`w_llm_${Date.now()}`, { setting: 'A test world of mock content', size: 'small', length: 'short', communication: 3, combatMode: 'party_npc', art: 'none', seed: 'llm' }, { id: 'u1', name: 'T' });
    await runGeneration(job);
    const w = loadWorld(job.worldId)!;
    expect(w.status).toBe('ready');
    expect(validateWorld(w)).toEqual([]);
    const names = new Set(seen.map((s) => s.name));
    for (const n of ['world_concept', 'world_atlas', 'monster_families', 'skills', 'items', 'affixes', 'main_story', 'town_content', 'area_content']) expect(names.has(n)).toBe(true);
    // The junk story response must have been retried.
    expect(seen.filter((s) => s.name === 'main_story').length).toBeGreaterThanOrEqual(2);
    // Model-provided names made it into the world.
    expect(w.concept.title).toMatch(/title/);
    const calls = genai().recent.filter((c) => c.provider === 'mock');
    for (const c of calls.filter((x) => !x.ok)) console.log('[llm-fail]', c.purpose, c.error);
    expect(calls.some((c) => !c.ok)).toBe(true);
    expect(calls.filter((c) => c.ok).length).toBeGreaterThan(8);

    // NPC dialogue through the decision model.
    const inst = instances.create(w, 'u1', 'T', 'llm run', [{ name: 'Tess', originId: 'o_rogue' }]);
    const msgs: unknown[] = [];
    inst.join({ userId: 'u1', send: (m) => msgs.push(m) });
    const npc = w.npcs.find((n) => n.questIds.some((q) => q.startsWith('q_side')))!;
    expect(npc).toBeTruthy();
    await inst.dialogue.open('u1', npc.id);
    await inst.dialogue.say('u1', 'Do you have any work for me?');
    const p = inst.state.players.u1!;
    expect(Object.keys(p.quests).some((q) => q.startsWith('q_side'))).toBe(true);
    expect(inst.state.npcs[npc.id]!.memories.some((m) => m.text.includes('asked for work'))).toBe(true);
    const last = (msgs.filter((m) => (m as { t: string }).t === 'dialog').pop() as { dialog: { messages: { text: string }[] } }).dialog.messages;
    expect(last.some((m) => m.text.includes('Mock NPC says hello'))).toBe(true);
  }, 120000);
});
