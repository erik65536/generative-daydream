/**
 * Encounter building shared by world assembly and the balance simulator: packs are sized by a threat budget
 * relative to the party's strength, so solo and party worlds get fights of the same intended difficulty.
 */
import { MONSTER_ROLES, type CombatMode, type DifficultyId, type MonsterRole, type Rng, type Ruleset } from '@gd/shared';

export type EncounterKind = 'normal' | 'elite' | 'boss';

export interface PackMember {
  role: MonsterRole;
  level: number;
  elite?: boolean;
  boss?: boolean;
  /** Threat multiplier from pack fitting. */
  scale?: number;
}

/** Characters in a typical party for the world's mode. */
export function partySizeFor(mode: CombatMode): number {
  return mode === 'solo' ? 1 : mode === 'party_manual' ? 4 : 3;
}

/** Party strength in threat units (a lone hero with the solo bonus counts for more than one). */
export function partyPower(mode: CombatMode): number {
  return mode === 'solo' ? 1.7 : partySizeFor(mode);
}

/** Build a pack worth the right amount of threat. `roles` are the family's member roles. */
export function buildPack(r: Ruleset, rng: Rng, opts: { mode: CombatMode; level: number; kind: EncounterKind; roles?: MonsterRole[]; depth?: number }): PackMember[] {
  const roles = (opts.roles?.length ? opts.roles : [...MONSTER_ROLES]).filter((x, i, a) => a.indexOf(x) === i);
  const power = partyPower(opts.mode);
  const depthBonus = 1 + (opts.depth ?? 0.5) * 0.25;
  const threat = (role: MonsterRole) => r.monsters[role]?.threat ?? 1;
  const out: PackMember[] = [];
  let budget: number;
  if (opts.kind === 'boss') {
    out.push({ role: rng.pick(roles.filter((x) => x !== 'swarm')) ?? 'brute', level: opts.level, boss: true });
    budget = power * 0.55;
  } else if (opts.kind === 'elite') {
    const lead = rng.pick(roles.filter((x) => x !== 'swarm' && x !== 'healer')) ?? roles[0]!;
    out.push({ role: lead, level: opts.level, elite: true });
    budget = power * 1.3 * depthBonus - threat(lead) * 2;
  } else budget = power * depthBonus;
  // Fill: prefer a front-liner, then mix; a healer at most once.
  let guard = 0;
  while (budget > 0.35 && guard++ < 12) {
    const options = roles.filter((x) => (x !== 'healer' || !out.some((m) => m.role === 'healer')) && threat(x) <= budget + 0.4);
    if (!options.length) break;
    const front = out.some((m) => r.monsters[m.role]!.range < 2);
    const role = !front ? (options.find((x) => r.monsters[x]!.range < 2) ?? rng.pick(options)) : rng.pick(options);
    out.push({ role, level: Math.max(1, opts.level - (role === 'swarm' ? 1 : 0)) });
    budget -= threat(role);
  }
  if (!out.length) out.push({ role: roles[0] ?? 'brute', level: opts.level });
  return out;
}

// ------------------------------------------------------------------------------------ fitting at runtime

export interface FitMember {
  id: string;
  role: MonsterRole;
  boss?: boolean;
  elite?: boolean;
}

export interface PackFit {
  /** Members left out for a smaller party. */
  absent: string[];
  /** Threat multiplier for the members that stay. */
  scale: number;
  /** Member promoted to elite by the difficulty. */
  eliteId?: string;
  /** Member copied once more by the difficulty. */
  extraOf?: string;
}

function threatOf(r: Ruleset, design: number, m: { role: MonsterRole; boss?: boolean; elite?: boolean }): number {
  return m.boss ? design * 0.45 : (r.monsters[m.role]?.threat ?? 1) * (m.elite ? 2 : 1);
}

/** The difficulty's encounter rolls: maybe one more foe, maybe an elite. */
function rollDifficulty(r: Ruleset, difficulty: DifficultyId, rand: () => number): { extra: boolean; elite: boolean } {
  const d = r.difficulty[difficulty] ?? r.difficulty.normal;
  return { extra: rand() < d.extraEnemyChance, elite: rand() < d.eliteChance };
}

/**
 * Packs are built for the world's design party (a full party, or a hero with companions). A smaller party
 * meets fewer members (the strongest and any boss stay) and the rest are scaled to the remaining gap, so a
 * lone hero in a companions world is not swarmed. Then the difficulty's extra-foe and elite rolls apply.
 */
export function fitPack(r: Ruleset, members: FitMember[], opts: { mode: CombatMode; partySize: number; difficulty: DifficultyId; rand: () => number }): PackFit {
  const design = partyPower(opts.mode);
  const actual = opts.partySize <= 1 ? partyPower('solo') : Math.min(opts.partySize, 4);
  const ratio = Math.min(1, actual / design);
  const threat = (m: FitMember) => threatOf(r, design, m);
  const order = [...members].sort((a, b) => Number(!!b.boss) - Number(!!a.boss) || Number(!!b.elite) - Number(!!a.elite) || threat(b) - threat(a));
  const target = members.reduce((s, m) => s + threat(m), 0) * ratio;
  const keep: FitMember[] = [];
  let kept = 0;
  for (const m of order) {
    if (!keep.length || m.boss || kept + threat(m) / 2 <= target) {
      keep.push(m);
      kept += threat(m);
    }
  }
  const fit: PackFit = { absent: members.filter((m) => !keep.includes(m)).map((m) => m.id), scale: Math.max(0.5, Math.min(1, target / Math.max(0.01, kept))) };
  const roll = rollDifficulty(r, opts.difficulty, opts.rand);
  if (roll.extra) {
    const back = members.find((m) => fit.absent.includes(m.id) && !m.boss);
    const pool = keep.filter((m) => !m.boss);
    if (back) fit.absent = fit.absent.filter((id) => id !== back.id);
    else if (pool.length) fit.extraOf = pool[Math.floor(opts.rand() * pool.length)]!.id;
  }
  if (roll.elite) {
    const pool = members.filter((m) => !m.boss && !m.elite && !fit.absent.includes(m.id));
    if (pool.length) fit.eliteId = pool[Math.floor(opts.rand() * pool.length)]!.id;
  }
  return fit;
}

/** The simulator's version: a design-size party meets the pack with the difficulty's rolls applied. */
export function withDifficulty(r: Ruleset, pack: PackMember[], difficulty: DifficultyId, rng: Rng): PackMember[] {
  const out = pack.map((m) => ({ ...m }));
  const roll = rollDifficulty(r, difficulty, () => rng.next());
  const pool = out.filter((m) => !m.boss);
  if (roll.extra && pool.length) out.push({ ...pool[Math.floor(rng.next() * pool.length)]!, elite: false });
  const elig = out.filter((m) => !m.boss && !m.elite);
  if (roll.elite && elig.length) elig[Math.floor(rng.next() * elig.length)]!.elite = true;
  return out;
}

/** A pack scaled for a smaller party, as the game spawns it (for simulation). */
export function fittedPack(r: Ruleset, pack: PackMember[], opts: { mode: CombatMode; partySize: number; difficulty: DifficultyId; rng: Rng }): PackMember[] {
  const fit = fitPack(r, pack.map((m, i) => ({ id: String(i), role: m.role, boss: m.boss, elite: m.elite })), { ...opts, rand: () => opts.rng.next() });
  const out: PackMember[] = pack.map((m, i) => ({ ...m, elite: m.elite || fit.eliteId === String(i), scale: fit.scale })).filter((_, i) => !fit.absent.includes(String(i)));
  if (fit.extraOf !== undefined) out.push({ ...pack[Number(fit.extraOf)]!, scale: fit.scale });
  return out;
}
