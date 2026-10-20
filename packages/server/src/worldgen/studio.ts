/**
 * World studio: the owner sees everything a world is made of (places, people, quests, art and the prompts
 * behind it), edits text and prompts directly, and regenerates pieces with the AI: one quest, one person, one
 * place's text, or images.
 */
import { z } from 'zod';
import type { WorldDefinition } from '@gd/shared';
import { genai } from '../genai/service';
import { saveWorld } from '../storage';
import { conceptSummary } from './prompts';
import { ART_PHASE, paintArt, WorldGenJob } from './pipeline';
import { activeJob } from '../jobs/queue';
import { listArt, planAssets } from './art';

/** Everything the studio shows (the owner may see spoilers: it is their world). */
export function studioView(w: WorldDefinition) {
  const { generationLog: _log, rulesIntent: _intent, ...world } = w;
  return { world, art: listArt(w), busy: !!activeJob(w.id) };
}

// ------------------------------------------------------------------------------------ direct edits

const text = (max: number) => z.string().trim().min(1).max(max);

export const EditSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('zone'), id: z.string(), name: text(80).optional(), description: text(1500).optional(), lore: z.string().max(1500).optional() }),
  z.object({
    type: z.literal('npc'),
    id: z.string(),
    name: text(60).optional(),
    title: text(80).optional(),
    personality: text(800).optional(),
    appearance: text(600).optional(),
    backstory: text(1500).optional(),
    voice: text(300).optional(),
    greeting: text(400).optional(),
  }),
  z.object({
    type: z.literal('quest'),
    id: z.string(),
    title: text(100).optional(),
    summary: text(1500).optional(),
    completionText: z.string().max(1000).optional(),
    objectives: z.array(z.object({ id: z.string(), description: text(300) })).max(20).optional(),
  }),
  // null clears the owner's version and returns to the world's own brief / the writer's prompt.
  z.object({ type: z.literal('art'), key: z.string(), brief: z.string().max(600).nullable().optional(), imagePrompt: z.string().max(2400).nullable().optional() }),
]);
export type StudioEdit = z.infer<typeof EditSchema>;

/** Swap a renamed person or place in every text that mentions it. */
function renameEverywhere(w: WorldDefinition, from: string, to: string) {
  if (!from || from === to) return;
  const swap = (s: string | undefined) => (s && s.includes(from) ? s.split(from).join(to) : s);
  for (const q of w.quests) {
    q.title = swap(q.title)!;
    q.summary = swap(q.summary)!;
    q.completionText = swap(q.completionText);
    for (const o of q.objectives) o.description = swap(o.description)!;
  }
  for (const n of w.npcs) {
    n.greeting = swap(n.greeting)!;
    n.backstory = swap(n.backstory)!;
    n.barks = n.barks.map((b) => swap(b)!);
    n.knowledge = n.knowledge.map((k) => swap(k)!);
  }
  for (const z of w.zones) {
    z.description = swap(z.description)!;
    for (const f of z.features) {
      f.name = swap(f.name);
      if ('text' in f) (f as { text?: string }).text = swap((f as { text?: string }).text);
    }
  }
  for (const l of w.lore) l.text = swap(l.text)!;
}

/** Apply one direct edit; returns an error message or null. */
export function applyEdit(w: WorldDefinition, e: StudioEdit): string | null {
  switch (e.type) {
    case 'zone': {
      const z = w.zones.find((x) => x.id === e.id);
      if (!z) return 'No such place.';
      if (e.name && e.name !== z.name) {
        renameEverywhere(w, z.name, e.name);
        z.name = e.name;
      }
      if (e.description) z.description = e.description;
      if (e.lore !== undefined) z.lore = e.lore || undefined;
      return null;
    }
    case 'npc': {
      const n = w.npcs.find((x) => x.id === e.id);
      if (!n) return 'No such person.';
      if (e.name && e.name !== n.name) {
        renameEverywhere(w, n.name, e.name);
        n.name = e.name;
      }
      for (const k of ['title', 'personality', 'appearance', 'backstory', 'voice', 'greeting'] as const) if (e[k]) n[k] = e[k]!;
      return null;
    }
    case 'quest': {
      const q = w.quests.find((x) => x.id === e.id);
      if (!q) return 'No such quest.';
      if (e.title) q.title = e.title;
      if (e.summary) q.summary = e.summary;
      if (e.completionText !== undefined) q.completionText = e.completionText || undefined;
      for (const o of e.objectives ?? []) {
        const t = q.objectives.find((x) => x.id === o.id);
        if (t) t.description = o.description;
      }
      return null;
    }
    case 'art': {
      const ov = { ...(w.artOverrides?.[e.key] ?? {}) };
      if (e.brief !== undefined) ov.brief = e.brief?.trim() || undefined;
      if (e.imagePrompt !== undefined) ov.imagePrompt = e.imagePrompt?.trim() || undefined;
      w.artOverrides = { ...(w.artOverrides ?? {}), [e.key]: ov };
      if (!ov.brief && !ov.imagePrompt && !ov.roll) delete w.artOverrides[e.key];
      return null;
    }
  }
}

// ------------------------------------------------------------------------------------ AI rewrites

export type RewriteTarget = { type: 'npc' | 'quest' | 'zone'; id: string };

export const NpcRewrite = z.object({
  name: text(60),
  title: text(80),
  personality: text(800),
  appearance: text(600).describe('What they look like and wear, for their portrait: physical details only'),
  backstory: text(1500),
  voice: text(300),
  greeting: text(400),
  barks: z.array(text(200)).max(6),
});
export const QuestRewrite = z.object({
  title: text(100),
  summary: text(1500),
  completionText: text(1000),
  objectives: z.array(z.object({ id: z.string(), description: text(300).describe('One short sentence the quest log shows, under 20 words') })),
});
export const ZoneRewrite = z.object({ name: text(80), description: text(1500), lore: z.string().max(1500) });

const REWRITE_SYSTEM = `You are the writer of a role-playing game, revising one piece of an existing world at its owner's request. Follow the owner's direction closely. Keep everything consistent with the world and with the facts given (names of other people and places, what the game requires of the piece). Write vivid, specific text in the world's own voice. Never use generic fantasy defaults unless the world is fantasy.`;

/** Rewrite one person, quest or place with the text model, following the owner's direction. */
export async function rewrite(w: WorldDefinition, target: RewriteTarget, guidance: string): Promise<string> {
  const g = genai();
  if (g.isProcedural('world.content')) throw new Error('No text model is configured (config/genai.json).');
  const world = conceptSummary(w.concept as never);
  const zoneName = (id?: string) => w.zones.find((z) => z.id === id)?.name ?? id ?? '';
  const npcName = (id?: string) => w.npcs.find((n) => n.id === id)?.name ?? w.bosses.find((b) => b.id === id)?.name ?? id ?? '';
  const direction = guidance.trim() ? `THE OWNER'S DIRECTION: ${guidance.trim()}` : 'THE OWNER\'S DIRECTION: make it more vivid, specific and true to this world.';
  if (target.type === 'npc') {
    const n = w.npcs.find((x) => x.id === target.id);
    if (!n) throw new Error('No such person.');
    const quests = w.quests.filter((q) => n.questIds.includes(q.id) || q.giverNpcId === n.id).map((q) => q.title);
    const out = await g.structured('world.content', {
      system: REWRITE_SYSTEM,
      prompt: `${world}\n\nPERSON (${n.role}${n.merchantKind ? `, sells ${n.merchantKind}` : ''}, lives in ${zoneName(n.zoneId)}):\n${JSON.stringify({ name: n.name, title: n.title, personality: n.personality, appearance: n.appearance, backstory: n.backstory, voice: n.voice, greeting: n.greeting, barks: n.barks })}\n${quests.length ? `Gives the quests: ${quests.join('; ')}. Keep them plausible.\n` : ''}Their role in the game (${n.role}) stays the same.\n\n${direction}\n\nReturn the revised person.`,
      schema: NpcRewrite,
      name: 'person',
      maxTokens: 2000,
    });
    applyEdit(w, { type: 'npc', id: n.id, ...out });
    n.barks = out.barks;
    return `Rewrote ${out.name}.`;
  }
  if (target.type === 'quest') {
    const q = w.quests.find((x) => x.id === target.id);
    if (!q) throw new Error('No such quest.');
    const facts = q.objectives.map((o) => `- ${o.id} (${o.type}${o.npcId ? `, person: ${npcName(o.npcId)}` : ''}${o.targetId ? `, target: ${npcName(o.targetId)}` : ''}${o.zoneId ? `, place: ${zoneName(o.zoneId)}` : ''}${o.itemUniqueId ? `, item: ${w.uniqueItems[o.itemUniqueId]?.name ?? o.itemUniqueId}` : ''}${o.count ? `, ×${o.count}` : ''}): ${o.description}`);
    const out = await g.structured('world.content', {
      system: REWRITE_SYSTEM,
      prompt: `${world}\n\nQUEST${q.main ? ' (main story)' : ''}, given by ${npcName(q.giverNpcId) || 'nobody (it starts on its own)'}:\nTitle: ${q.title}\nSummary: ${q.summary}\nCompletion: ${q.completionText ?? ''}\nObjectives (their type and target are fixed by the game; rewrite only their wording as one short sentence each, keep every id):\n${facts.join('\n')}\n\n${direction}\n\nReturn the revised quest text.`,
      schema: QuestRewrite,
      name: 'quest',
      maxTokens: 2000,
    });
    applyEdit(w, { type: 'quest', id: q.id, title: out.title, summary: out.summary, completionText: out.completionText, objectives: out.objectives.filter((o) => q.objectives.some((x) => x.id === o.id)) });
    return `Rewrote "${out.title}".`;
  }
  const z0 = w.zones.find((x) => x.id === target.id);
  if (!z0) throw new Error('No such place.');
  const people = w.npcs.filter((n) => n.zoneId === z0.id).map((n) => `${n.name} (${n.title})`);
  const out = await g.structured('world.content', {
    system: REWRITE_SYSTEM,
    prompt: `${world}\n\nPLACE (${z0.kind}, level ${z0.levelRange.join('-')}):\nName: ${z0.name}\nDescription: ${z0.description}\nHidden lore: ${z0.lore ?? ''}\n${people.length ? `People here: ${people.join(', ')}\n` : ''}\n${direction}\n\nReturn the revised place.`,
    schema: ZoneRewrite,
    name: 'place',
    maxTokens: 1500,
  });
  applyEdit(w, { type: 'zone', id: z0.id, name: out.name, description: out.description, lore: out.lore });
  return `Rewrote ${out.name}.`;
}

// ------------------------------------------------------------------------------------ jobs

export const TaskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rewrite'), target: z.object({ type: z.enum(['npc', 'quest', 'zone']), id: z.string() }), guidance: z.string().max(2000).default('') }),
  z.object({ kind: z.literal('paint'), keys: z.array(z.string()).min(1).max(400), reroll: z.boolean().default(true) }),
]);
export type StudioTask = z.infer<typeof TaskSchema>;

/**
 * Run a studio task as a world job (progress shows on the world page and in the studio). A task resumed after a
 * restart skips its finished first stage and paints whatever is still out of date.
 */
export async function runStudioJob(job: WorldGenJob, w: WorldDefinition, task: StudioTask): Promise<void> {
  const first = task.kind === 'rewrite' ? { id: 'rewrite', label: 'Rewriting', detail: 'The text model revises it' } : null;
  const resumed = job.phases.some((p) => p.status !== 'pending');
  const firstDone = !!first && job.phases.some((p) => p.id === first.id && p.status === 'done');
  if (!resumed) job.plan(first ? [first, ART_PHASE] : [ART_PHASE]);
  job.step = first?.label ?? 'Painting';
  let paint = new Set<string>();
  if (firstDone) paint = new Set(planAssets(w, 'full').map((r) => r.key));
  else if (task.kind === 'rewrite') {
    job.phase('rewrite');
    const before = new Map(listArt(w).map((a) => [a.key, a.brief]));
    job.push(await rewrite(w, task.target, task.guidance), 'step');
    saveWorld(w);
    // Repaint whatever the new text changed (a person's look).
    for (const a of listArt(w)) if (before.get(a.key) !== a.brief) paint.add(a.key);
  } else {
    paint = new Set(task.keys);
    if (task.reroll && !resumed) {
      w.artOverrides ??= {};
      for (const k of task.keys) w.artOverrides[k] = { ...(w.artOverrides[k] ?? {}), roll: (w.artOverrides[k]?.roll ?? 0) + 1 };
      saveWorld(w);
    }
  }
  if (paint.size) {
    job.phase('art');
    await paintArt(job, w, paint);
  }
  saveWorld(w);
  job.finishPhases();
}
