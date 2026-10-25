/**
 * Ruleset design with an LLM: structured steps (core, gear, classes, then every class's tree side by side), then
 * compile → (world binding) → balance → AI review of flavour/structure → rebalance.
 */
import { z } from 'zod';
import type { Ruleset, WorldInput } from '@gd/shared';
import type { Purpose } from '../genai/types';
import { ClassTreeIntentSchema, ClassesIntentSchema, CoreIntentSchema, GearIntentSchema, SKILL_EFFECT_KINDS, STAT_EFFECTS, type RulesetIntent } from './intent';
import * as RP from './prompts';

/** Runs one structured LLM step (provided by the pipeline: it retries, then stops the build). */
export type StepRunner = <T extends z.ZodType>(purpose: Purpose, label: string, opts: { prompt: string; schema: T; name: string; maxTokens?: number; system?: string }) => Promise<z.infer<T>>;

export async function designRules(run: StepRunner, world: string, input: WorldInput, onStep?: (done: number, total: number) => void): Promise<RulesetIntent> {
  const core = await run('world.design', 'Rules: core', { prompt: RP.corePrompt(world, input), schema: CoreIntentSchema, name: 'rules_core', maxTokens: 6000, system: RP.RULES_SYSTEM });
  if (!core.slots.some((s) => s.kind === 'weapon')) core.slots.unshift({ name: 'Weapon', kind: 'weapon' });
  const gear = await run('world.content', 'Rules: gear & peoples', { prompt: RP.gearPrompt(world, core), schema: GearIntentSchema, name: 'rules_gear', maxTokens: 6000, system: RP.RULES_SYSTEM });
  const n = input.rules?.classes;
  const classes = await run('world.design', 'Rules: classes', { prompt: RP.classesPrompt(world, core, gear, n ? [n, n] : [3, 5]), schema: ClassesIntentSchema, name: 'rules_classes', maxTokens: 4000, system: RP.RULES_SYSTEM });
  if (n && classes.classes.length > n) classes.classes = classes.classes.slice(0, n);
  // Every class's skill tree is designed at the same time.
  let done = 3;
  const total = 3 + classes.classes.length;
  onStep?.(done, total);
  const trees = await Promise.all(classes.classes.map(async (c) => {
    const tree = await run('world.content', `Rules: ${c.name} skills`, { prompt: RP.treePrompt(world, core, c), schema: ClassTreeIntentSchema, name: 'rules_tree', maxTokens: 6000, system: RP.RULES_SYSTEM });
    onStep?.(++done, total);
    return tree;
  }));
  return { core, gear, classes, trees };
}

// ------------------------------------------------------------------------------------ review

export const ReviewSchema = z.object({
  verdict: z.string().max(400),
  revisions: z
    .array(
      z.object({
        kind: z.enum(['skill', 'passive', 'class', 'attribute', 'status']),
        className: z.string().max(40).optional(),
        name: z.string().max(40).describe('Exact current name of the thing to change'),
        newName: z.string().max(40).optional(),
        newDescription: z.string().max(200).optional(),
        effects: z.array(z.object({ kind: z.enum(SKILL_EFFECT_KINDS), weight: z.number().int().min(1).max(5), of: z.string().max(40).optional() })).max(3).optional().describe('Skills only: replace its effect mix'),
        stats: z.array(z.object({ effect: z.enum(STAT_EFFECTS), of: z.string().max(40).optional(), weight: z.number().int().min(1).max(5) })).max(3).optional().describe('Passives/attributes only: replace stat picks'),
      }),
    )
    .max(8),
});

function reportText(r: Ruleset): string {
  const b = r.balance;
  if (!b) return 'No balance report.';
  const lines = b.scenarios.map((s) => `- ${s.label}: win ${Math.round(s.winRate * 100)}%, health lost ${Math.round(s.hpLost * 100)}%, ${s.rounds} rounds ${s.ok ? '(on target)' : '(OFF target)'}`);
  const unused = b.skillUsage.filter((u) => u.share < 0.03).map((u) => r.skills.find((s) => s.id === u.skillId)?.name).filter(Boolean);
  const dominant = b.skillUsage.filter((u) => u.share > 0.45).map((u) => r.skills.find((s) => s.id === u.skillId)?.name).filter(Boolean);
  return [
    `Simulation: ${b.notes.join(' ')}`,
    ...lines,
    unused.length ? `Rarely used skills: ${unused.join(', ')}.` : '',
    dominant.length ? `Dominant skills: ${dominant.join(', ')}.` : '',
    b.outliers.length ? `Outliers: ${b.outliers.join(' ')}` : '',
  ].filter(Boolean).join('\n');
}

function rulesText(r: Ruleset): string {
  return r.classes
    .map((c) => `${c.name} (${c.role}): skills ${r.skills.filter((s) => s.owner === c.id).map((s) => `${s.name} [${s.effects.map((e) => e.kind).join('+')}]`).join(', ')}; passives ${c.nodes.filter((n) => n.kind === 'passive' || n.kind === 'capstone').map((n) => n.name).join(', ')}`)
    .join('\n');
}

/** Ask the model for flavour/structure revisions; returns a revised intent, or null if nothing changes. */
export async function reviewRules(run: StepRunner, world: string, intent: RulesetIntent, r: Ruleset): Promise<RulesetIntent | null> {
  const prompt = `${world}

${RP.coreSummary(intent.core)}
${rulesText(r)}

BALANCE REPORT
${reportText(r)}

Propose up to 8 revisions that make the rules more fun, clearer or more fitting (rename or re-describe things, change a rarely used skill's effect mix, give a dull passive better stat picks). Leave numbers to the engine. Return an empty list if the rules are good.`;
  const out = await run('world.design', 'Rules: review', { prompt, schema: ReviewSchema, name: 'rules_review', maxTokens: 6000, system: RP.REVIEW_SYSTEM });
  if (!out.revisions.length) return null;
  const next: RulesetIntent = JSON.parse(JSON.stringify(intent));
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  let changed = 0;
  for (const rev of out.revisions) {
    if (rev.kind === 'skill' || rev.kind === 'passive') {
      next.classes.classes.forEach((c, ci) => {
        if (rev.className && !same(rev.className, c.name)) return;
        const tree = next.trees[ci];
        if (!tree) return;
        if (rev.kind === 'skill') {
          const s = tree.skills.find((x) => same(x.name, rev.name));
          if (!s) return;
          if (rev.newName) s.name = rev.newName;
          if (rev.newDescription) s.description = rev.newDescription;
          if (rev.effects?.length) s.effects = rev.effects;
          changed++;
        } else {
          const p = tree.passives.find((x) => same(x.name, rev.name));
          if (!p) return;
          if (rev.newName) p.name = rev.newName;
          if (rev.newDescription) p.description = rev.newDescription;
          if (rev.stats?.length) p.effects = rev.stats;
          changed++;
        }
      });
    } else if (rev.kind === 'class') {
      const c = next.classes.classes.find((x) => same(x.name, rev.name));
      if (c) {
        if (rev.newName) c.name = rev.newName;
        if (rev.newDescription) c.description = rev.newDescription;
        changed++;
      }
    } else if (rev.kind === 'attribute') {
      const a = next.core.attributes.find((x) => same(x.name, rev.name));
      if (a) {
        if (rev.newName) {
          renameRefs(next, a.name, rev.newName);
          a.name = rev.newName;
        }
        if (rev.newDescription) a.description = rev.newDescription;
        if (rev.stats?.length) a.effects = rev.stats;
        changed++;
      }
    } else if (rev.kind === 'status') {
      const s = next.core.statuses.find((x) => same(x.name, rev.name));
      if (s) {
        if (rev.newName) {
          renameRefs(next, s.name, rev.newName);
          s.name = rev.newName;
        }
        if (rev.newDescription) s.description = rev.newDescription;
        changed++;
      }
    }
  }
  return changed ? next : null;
}

/** Point every by-name reference at a renamed status/attribute. */
function renameRefs(intent: RulesetIntent, from: string, to: string) {
  const fix = (v: string | undefined) => (v && v.trim().toLowerCase() === from.trim().toLowerCase() ? to : v);
  for (const sub of intent.core.subtypes) sub.status = fix(sub.status);
  for (const t of intent.core.traps) t.status = fix(t.status);
  for (const p of intent.gear.potions) p.of = fix(p.of);
  for (const k of intent.gear.kins) for (const a of k.attributes) a.attribute = fix(a.attribute) ?? a.attribute;
  for (const c of intent.classes.classes) c.primaryAttributes = c.primaryAttributes.map((a) => fix(a) ?? a);
  for (const t of intent.trees) for (const s of t.skills) for (const e of s.effects) e.of = fix(e.of);
}
