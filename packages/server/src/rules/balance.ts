/**
 * The balance loop. Simulates encounters with the real combat code and tunes a small set of knobs toward
 * difficulty targets: monster health/damage multipliers per level, elite/boss tiers, class corrections, skill
 * potency from usage telemetry, outlier builds found by search, and per-difficulty enemy multipliers.
 * Mutates the ruleset in place and returns a report. Deterministic for a given seed.
 */
import {
  DIFFICULTIES, RULESET_VERSION, Rng, invalidateRuleset, knot, rx,
  type BalanceReport, type BalanceScenarioResult, type CombatMode, type DifficultyId, type Knots, type MonsterRole, type Ruleset,
} from '@gd/shared';
import { buildPack, withDifficulty, type EncounterKind } from './encounters';
import { makeParty, newTelemetry, runFight, type FightTelemetry } from './sim';

export interface FamilyInfo {
  roles: MonsterRole[];
  subtypeId?: string;
}

export interface BalanceOptions {
  mode: CombatMode;
  seed: string;
  families?: FamilyInfo[];
  /** Wall-clock budget; optional steps are skipped when it runs out. */
  budgetMs?: number;
  /** Fewer fights per evaluation (tests). */
  quick?: boolean;
  onProgress?: (msg: string, frac: number) => void;
}

type Range = [number, number];
interface Target { winRate: Range; hpLost: Range; rounds: Range }

/** Intended feel per encounter kind and difficulty (AI-played; humans do a little better). */
const TARGETS: Record<DifficultyId, Record<EncounterKind, Target>> = {
  story: { normal: { winRate: [0.98, 1], hpLost: [0.05, 0.25], rounds: [2, 4.5] }, elite: { winRate: [0.95, 1], hpLost: [0.15, 0.45], rounds: [2.5, 5] }, boss: { winRate: [0.9, 1], hpLost: [0.3, 0.7], rounds: [3.5, 8] } },
  easy: { normal: { winRate: [0.97, 1], hpLost: [0.12, 0.35], rounds: [2.5, 4.5] }, elite: { winRate: [0.92, 1], hpLost: [0.3, 0.55], rounds: [3, 5.5] }, boss: { winRate: [0.75, 0.97], hpLost: [0.45, 0.8], rounds: [4, 9] } },
  normal: { normal: { winRate: [0.94, 1], hpLost: [0.2, 0.45], rounds: [2.5, 5] }, elite: { winRate: [0.82, 0.99], hpLost: [0.4, 0.7], rounds: [3, 6.5] }, boss: { winRate: [0.55, 0.9], hpLost: [0.55, 0.9], rounds: [4.5, 10] } },
  hard: { normal: { winRate: [0.88, 0.99], hpLost: [0.35, 0.6], rounds: [3, 5.5] }, elite: { winRate: [0.7, 0.92], hpLost: [0.5, 0.8], rounds: [3.5, 7] }, boss: { winRate: [0.4, 0.75], hpLost: [0.65, 0.95], rounds: [5, 11] } },
  brutal: { normal: { winRate: [0.8, 0.97], hpLost: [0.5, 0.75], rounds: [3, 6] }, elite: { winRate: [0.55, 0.85], hpLost: [0.6, 0.9], rounds: [4, 8] }, boss: { winRate: [0.25, 0.6], hpLost: [0.75, 1], rounds: [5, 12] } },
};

const mid = (r: Range) => (r[0] + r[1]) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const inRange = (v: number, r: Range, slack = 0) => v >= r[0] - slack && v <= r[1] + slack;

interface Eval {
  winRate: number;
  hpLost: number;
  rounds: number;
  runs: number;
}

function setKnot(k: Knots, level: number, value: number) {
  const e = k.find((x) => x.level === level);
  if (e) e.value = value;
  else {
    k.push({ level, value });
    k.sort((a, b) => a.level - b.level);
  }
}

export function balanceRuleset(r: Ruleset, opts: BalanceOptions): BalanceReport {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 15 * 60_000;
  const fightsPer = opts.quick ? 8 : 14;
  const maxL = r.progression.maxLevel;
  const levels = [...new Set([1, Math.max(2, Math.round(maxL * 0.35)), Math.max(3, Math.round(maxL * 0.7)), maxL].filter((l) => l <= maxL))];
  const midL = levels[Math.floor(levels.length / 2)]!;
  const families: FamilyInfo[] = opts.families?.length ? opts.families : [{ roles: ['brute', 'skirmisher', 'archer', 'caster'], subtypeId: r.subtypes[0]?.id }];
  const notes: string[] = [];
  const outliers: string[] = [];
  const telemetry = newTelemetry();
  let fights = 0;
  let iterations = 0;
  const timeLeft = () => budget - (Date.now() - t0);
  const progress = (msg: string, frac: number) => opts.onProgress?.(msg, clamp(frac, 0, 1));
  const classIds = r.classes.map((c) => c.id);
  const partySize = opts.mode === 'solo' ? 1 : opts.mode === 'party_manual' ? 4 : 3;

  // Knots at the levels we tune (keep existing values as the starting point).
  r.curves.monsterHp = levels.map((l) => ({ level: l, value: knot(r.curves.monsterHp, l) }));
  r.curves.monsterDmg = levels.map((l) => ({ level: l, value: knot(r.curves.monsterDmg, l) }));

  const lineup = (i: number): string[] => {
    if (partySize === 1) return [classIds[i % classIds.length]!];
    return Array.from({ length: partySize }, (_, j) => classIds[(i + j) % classIds.length]!);
  };

  function evaluate(level: number, kind: EncounterKind, difficulty: DifficultyId, n = fightsPer, opts2: { classes?: string[][]; tree?: Record<string, number>; tele?: FightTelemetry; mode?: CombatMode } = {}): Eval {
    invalidateRuleset(r);
    let wins = 0, hp = 0, rounds = 0;
    for (let i = 0; i < n; i++) {
      const rng = new Rng(`${opts.seed}:${level}:${kind}:${difficulty}:${i}:${iterations}`);
      const fam = families[i % families.length]!;
      const classes = opts2.classes ? opts2.classes[i % opts2.classes.length]! : lineup(i);
      const party = makeParty(r, { classes, level, rng, tree: opts2.tree });
      const pack = withDifficulty(r, buildPack(r, rng, { mode: opts2.mode ?? opts.mode, level, kind, roles: fam.roles, depth: 0.5 }), difficulty, rng);
      const res = runFight(r, { party, pack, subtypeId: fam.subtypeId, potions: kind === 'boss' ? 2 * classes.length : kind === 'elite' ? classes.length : 0, difficulty, seed: rng.next().toString(36), telemetry: opts2.tele ?? telemetry });
      fights++;
      if (res.win) wins++;
      hp += res.hpLost;
      rounds += res.rounds;
    }
    return { winRate: wins / n, hpLost: hp / n, rounds: rounds / n, runs: n };
  }

  /** Fit monster multipliers at one level (normal difficulty knots, or a difficulty profile's). */
  function fit(level: number, difficulty: DifficultyId, maxIter: number) {
    const t = TARGETS[difficulty].normal;
    const hpK = difficulty === 'normal' ? r.curves.monsterHp : r.difficulty[difficulty].enemyHp;
    const dmgK = difficulty === 'normal' ? r.curves.monsterDmg : r.difficulty[difficulty].enemyDmg;
    for (let i = 0; i < maxIter; i++) {
      iterations++;
      const e = evaluate(level, 'normal', difficulty);
      const ok = inRange(e.winRate, t.winRate) && inRange(e.hpLost, t.hpLost) && inRange(e.rounds, t.rounds);
      if (ok) return e;
      let hpM = knot(hpK, level), dmgM = knot(dmgK, level);
      hpM *= clamp(Math.pow(mid(t.rounds) / Math.max(1, e.rounds), 0.9), 0.6, 1.6);
      dmgM *= clamp(Math.pow(mid(t.hpLost) / Math.max(0.03, e.hpLost), 0.6), 0.6, 1.6);
      if (e.winRate < t.winRate[0]) dmgM *= 0.88;
      setKnot(hpK, level, clamp(hpM, 0.15, 8));
      setKnot(dmgK, level, clamp(dmgM, 0.1, 8));
      if (timeLeft() < 0) break;
    }
    return evaluate(level, 'normal', difficulty);
  }

  function fitTier(kind: 'elite' | 'boss', level: number, maxIter: number) {
    const t = TARGETS.normal[kind];
    const tier = kind === 'elite' ? r.elite : r.boss;
    for (let i = 0; i < maxIter; i++) {
      iterations++;
      const e = evaluate(level, kind, 'normal');
      if (inRange(e.winRate, t.winRate) && inRange(e.hpLost, t.hpLost) && inRange(e.rounds, t.rounds)) return;
      tier.hp = clamp(tier.hp * clamp(Math.pow(mid(t.rounds) / Math.max(1, e.rounds), 0.8), 0.7, 1.5), 1, 14);
      tier.dmg = clamp(tier.dmg * clamp(Math.pow(mid(t.hpLost) / Math.max(0.05, e.hpLost), 0.55), 0.7, 1.4) * (e.winRate < t.winRate[0] ? 0.9 : e.winRate > t.winRate[1] ? 1.06 : 1), 0.8, 4);
      if (timeLeft() < 0) return;
    }
  }

  // ---------------------------------------------------------------- 1. monster curve
  progress('Fitting monster strength per level', 0.02);
  levels.forEach((l, i) => {
    fit(l, 'normal', opts.quick ? 3 : 6);
    progress(`Level ${l} fitted`, 0.05 + 0.2 * ((i + 1) / levels.length));
  });

  // ---------------------------------------------------------------- 2. elite & boss tiers
  if (timeLeft() > 0) {
    progress('Tuning elite and boss encounters', 0.27);
    fitTier('elite', midL, opts.quick ? 2 : 4);
    fitTier('boss', midL, opts.quick ? 2 : 4);
  }

  // ---------------------------------------------------------------- 3. class parity
  const classResults: BalanceReport['classes'] = [];
  if (timeLeft() > 0 && classIds.length > 1) {
    progress('Evening out the classes', 0.4);
    for (let pass = 0; pass < (opts.quick ? 1 : 2); pass++) {
      const scores = classIds.map((c) => {
        const e = evaluate(midL, 'elite', 'normal', Math.max(4, Math.round(fightsPer * 0.6)), { classes: [[c]], mode: 'solo' });
        return { c, e, score: e.hpLost + (1 - e.winRate) * 0.6 };
      });
      const mean = scores.reduce((s, x) => s + x.score, 0) / scores.length;
      for (const s of scores) {
        const cls = rx(r).cls.get(s.c)!;
        if (s.score > mean * 1.2) {
          cls.tune.hp = clamp(cls.tune.hp * 1.06, 0.7, 1.5);
          cls.tune.dmg = clamp(cls.tune.dmg * 1.05, 0.7, 1.5);
        } else if (s.score < mean * 0.8) {
          cls.tune.hp = clamp(cls.tune.hp * 0.95, 0.7, 1.5);
          cls.tune.dmg = clamp(cls.tune.dmg * 0.95, 0.7, 1.5);
        }
        if (pass === (opts.quick ? 0 : 1)) classResults.push({ classId: s.c, winRate: s.e.winRate, tune: { ...cls.tune } });
      }
    }
  }

  // ---------------------------------------------------------------- 4. skill usage telemetry
  const usage: BalanceReport['skillUsage'] = [];
  if (timeLeft() > 0) {
    progress('Reading skill usage', 0.52);
    // Use a fresh telemetry from max-level fights so most skills are known.
    const tele = newTelemetry();
    for (const l of [midL, maxL]) for (const kind of ['normal', 'elite'] as const) evaluate(l, kind, 'normal', Math.max(4, Math.round(fightsPer * 0.6)), { tele });
    for (const cls of r.classes) {
      const uses = tele.uses.get(cls.id);
      if (!uses) continue;
      const own = [...uses].filter(([id]) => rx(r).skill.get(id)?.owner === cls.id);
      const total = own.reduce((s, [, n]) => s + n, 0);
      if (!total) continue;
      for (const sk of r.skills.filter((s) => s.owner === cls.id)) {
        const share = (uses.get(sk.id) ?? 0) / total;
        const known = own.length;
        if (share > 0.5 && known > 2) sk.tune = clamp(sk.tune * 0.92, 0.6, 1.6);
        else if (share < 0.03 && sk.effects.some((e) => e.kind === 'damage' || e.kind === 'heal')) sk.tune = clamp(sk.tune * 1.08, 0.6, 1.6);
        usage.push({ skillId: sk.id, share: Math.round(share * 1000) / 1000, tune: Math.round(sk.tune * 1000) / 1000 });
      }
    }
  }

  // ---------------------------------------------------------------- 5. build search for outliers
  if (timeLeft() > budget * 0.35 && !opts.quick) {
    progress('Searching for overpowered builds', 0.62);
    for (const cls of r.classes) {
      if (timeLeft() < budget * 0.3) break;
      const rng = new Rng(`${opts.seed}:builds:${cls.id}`);
      const typical = makeParty(r, { classes: [cls.id], level: maxL, rng })[0]!;
      const base = evaluate(maxL, 'elite', 'normal', 6, { classes: [[cls.id]], tree: typical.tree, mode: 'solo' });
      let best: { tree: Record<string, number>; e: Eval } | null = null;
      for (let k = 0; k < 5; k++) {
        const b = makeParty(r, { classes: [cls.id], level: maxL, rng, style: 'random' })[0]!;
        const e = evaluate(maxL, 'elite', 'normal', 6, { classes: [[cls.id]], tree: b.tree, mode: 'solo' });
        if (!best || e.hpLost + (1 - e.winRate) < best.e.hpLost + (1 - best.e.winRate)) best = { tree: b.tree, e };
      }
      if (!best) continue;
      const gap = base.hpLost + (1 - base.winRate) - (best.e.hpLost + (1 - best.e.winRate));
      if (gap < 0.25) continue;
      // Ablation: which node is carrying the outlier build?
      const nodes = rx(r).nodes.get(cls.id)!;
      const candidates = Object.entries(best.tree).filter(([id, n]) => n > 0 && nodes.get(id) && nodes.get(id)!.kind !== 'attribute' && nodes.get(id)!.kind !== 'skill').sort((a, b) => b[1] - a[1]).slice(0, 5);
      let worst: { id: string; delta: number } | null = null;
      for (const [id] of candidates) {
        const t2 = { ...best.tree };
        delete t2[id];
        const e = evaluate(maxL, 'elite', 'normal', 4, { classes: [[cls.id]], tree: t2, mode: 'solo' });
        const delta = e.hpLost + (1 - e.winRate) - (best.e.hpLost + (1 - best.e.winRate));
        if (!worst || delta > worst.delta) worst = { id, delta };
      }
      if (worst && worst.delta > 0.08) {
        const node = nodes.get(worst.id)!;
        if (node.kind === 'rank' && node.skillId) {
          const sk = rx(r).skill.get(node.skillId)!;
          sk.tune = clamp(sk.tune * 0.85, 0.5, 1.6);
        } else node.tune = clamp((node.tune ?? 1) * 0.8, 0.4, 1.5);
        outliers.push(`${cls.name}: "${node.name}" carried an outlier build (${Math.round(gap * 100)}% better than typical); weakened.`);
      }
    }
  }

  // ---------------------------------------------------------------- 6. re-fit after changes
  if (timeLeft() > 0) {
    progress('Re-fitting after class and skill changes', 0.72);
    for (const l of levels) fit(l, 'normal', opts.quick ? 1 : 3);
  }

  // ---------------------------------------------------------------- 7. difficulty profiles
  const diffLevels = [...new Set([1, midL, maxL])];
  for (const d of DIFFICULTIES) {
    if (d === 'normal' || timeLeft() < 0) continue;
    progress(`Calibrating ${r.difficulty[d].name} difficulty`, 0.78 + 0.04 * DIFFICULTIES.indexOf(d));
    r.difficulty[d].enemyHp = diffLevels.map((l) => ({ level: l, value: knot(r.difficulty[d].enemyHp, l) }));
    r.difficulty[d].enemyDmg = diffLevels.map((l) => ({ level: l, value: knot(r.difficulty[d].enemyDmg, l) }));
    for (const l of diffLevels) fit(l, d, opts.quick ? 1 : 3);
  }

  // ---------------------------------------------------------------- 8. report
  progress('Writing the balance report', 0.95);
  const scenarios: BalanceScenarioResult[] = [];
  const record = (level: number, kind: EncounterKind, difficulty: DifficultyId) => {
    const e = evaluate(level, kind, difficulty, Math.max(4, Math.round(fightsPer * 0.7)));
    const t = TARGETS[difficulty][kind];
    scenarios.push({
      id: `${difficulty}:${kind}:${level}`,
      label: `${r.difficulty[difficulty].name} · ${kind} · level ${level}`,
      level, difficulty, runs: e.runs,
      winRate: round(e.winRate), hpLost: round(e.hpLost), rounds: round(e.rounds),
      target: t,
      ok: inRange(e.winRate, t.winRate, 0.05) && inRange(e.hpLost, t.hpLost, 0.08) && inRange(e.rounds, t.rounds, 0.8),
    });
  };
  for (const l of levels) record(l, 'normal', 'normal');
  record(midL, 'elite', 'normal');
  record(midL, 'boss', 'normal');
  if (!opts.quick) {
    record(maxL, 'boss', 'normal');
    for (const d of ['story', 'hard', 'brutal'] as DifficultyId[]) record(midL, 'normal', d);
  }
  const okCount = scenarios.filter((s) => s.ok).length;
  notes.push(`${okCount}/${scenarios.length} scenarios on target after ${iterations} tuning iterations and ${fights} simulated fights.`);
  invalidateRuleset(r);
  const report: BalanceReport = { at: Date.now(), engineVersion: RULESET_VERSION, iterations, durationMs: Date.now() - t0, fights, scenarios, classes: classResults, skillUsage: usage, outliers, notes };
  r.balance = report;
  progress('Balanced', 1);
  return report;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
