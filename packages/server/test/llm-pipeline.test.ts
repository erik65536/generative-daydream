/**
 * Runs world generation and NPC dialogue through the real OpenAI-compatible provider against a mock server that
 * answers with schema-valid (but semantically random) JSON — and sometimes with junk — to prove the pipeline,
 * validation and retries hold up with weak models. Places are laid out as plain ground (no image model).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { genai } from '../src/genai/service';
import { WorldGenJob, runGeneration } from '../src/worldgen/pipeline';
import { loadWorld } from '../src/storage';
import { instances } from '../src/game/manager';
import { hero, mockModels, plainPlaces, validateWorld, type MockModels } from './helpers';

let models: MockModels;
let restore: () => void;

beforeAll(async () => {
  models = await mockModels({
    junkOnce: ['main_story'],
    npc: (prompt) => {
      const quest = prompt.match(/(q_side_[\w]+)/)?.[1];
      return { actions: quest ? [{ type: 'offer_quest', questId: quest }, { type: 'remember', memory: 'The player asked for work.', spread: 'town' }] : [{ type: 'none' }], emotion: 'happy', speech: 'Mock NPC says hello and has a job for you.' };
    },
  });
  restore = plainPlaces();
});

afterAll(() => {
  restore();
  models.stop();
});

describe('LLM pipeline against a mock OpenAI-compatible server', () => {
  it('generates a valid world from model output (including a junk response)', async () => {
    const job = new WorldGenJob(`w_llm_${Date.now()}`, { setting: 'A test world of mock content', size: 'small', length: 'short', communication: 3, combatMode: 'party_npc', seed: 'llm' }, { id: 'u1', name: 'T' });
    await runGeneration(job);
    const w = loadWorld(job.worldId)!;
    expect(w.status).toBe('ready');
    expect(validateWorld(w)).toEqual([]);
    const names = new Set(models.seen);
    for (const n of ['world_concept', 'world_atlas', 'monster_families', 'rules_core', 'rules_gear', 'rules_classes', 'rules_tree', 'main_story', 'town_content', 'area_content']) expect(names.has(n)).toBe(true);
    // The junk story response must have been retried.
    expect(models.seen.filter((s) => s === 'main_story').length).toBeGreaterThanOrEqual(2);
    // Model-provided names made it into the world.
    expect(w.concept.title).toMatch(/title/);
    const calls = genai().recent.filter((c) => c.provider === 'mock');
    expect(calls.some((c) => !c.ok)).toBe(true);
    expect(calls.filter((c) => c.ok).length).toBeGreaterThan(8);

    // NPC dialogue through the decision model.
    const inst = instances.create(w, 'u1', 'T', 'llm run', [hero(w, 'Tess', 'melee')]);
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
