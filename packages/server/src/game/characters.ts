/** Character creation and progression on the world's ruleset: class, kin, upgrade tree, levels. */
import {
  branchSpent, canAllocate, characterStats, knownSkills, levelForXp, rx, treePointsAt, uid,
  type CharacterSpec, type CharacterState, type ItemInstance, type Rng, type Ruleset, type TreeNode, type WorldDefinition,
} from '@gd/shared';
import { makeItem } from './loot';

export type { CharacterSpec };

/** The sprite of a hero of this class and kin (each class is painted once per kin). */
export const heroSprite = (classId: string, kinId: string) => `spr_hero_${classId}_${kinId}`;

export function createCharacter(r: Ruleset, w: WorldDefinition | null, spec: CharacterSpec, rng: Rng): { ch: CharacterState; inventory: ItemInstance[] } {
  const ix = rx(r);
  const cls = ix.cls.get(spec.classId) ?? r.classes[0]!;
  const kin = ix.kin.get(spec.kinId) ?? r.kins[0]!;
  const equipment: CharacterState['equipment'] = {};
  for (const [slotId, baseId] of Object.entries(cls.startingGear)) if (ix.item.get(baseId)) equipment[slotId] = makeItem(r, rng, baseId, 1, r.rarities[0]!.id);
  const ch: CharacterState = {
    id: uid('ch'),
    name: spec.name.trim().slice(0, 24) || 'Wanderer',
    classId: cls.id,
    kinId: kin.id,
    presentation: kin.presentation,
    sprite: spec.sprite ?? heroSprite(cls.id, kin.id),
    level: 1,
    xp: 0,
    tree: {},
    treePoints: r.progression.treePointsStart,
    hotbar: [],
    hp: 1,
    pools: {},
    barrier: 0,
    barrierTurns: 0,
    statuses: [],
    equipment,
    cooldowns: {},
    downed: false,
    archetype: cls.aiRole,
  };
  ch.hotbar = defaultHotbar(r, ch);
  restoreFully(r, ch);
  const inventory: ItemInstance[] = [];
  const heal = r.items.find((i) => i.category === 'potion' && i.use?.effects.some((e) => e.kind === 'heal'));
  if (heal) inventory.push(makeItem(r, rng, heal.id, 1, r.rarities[0]!.id, 3));
  if (r.systems.traps && ix.item.get('tool_disarm')) inventory.push(makeItem(r, rng, 'tool_disarm', 1, r.rarities[0]!.id, 1));
  if (r.systems.locks && ix.item.get('tool_unlock')) inventory.push(makeItem(r, rng, 'tool_unlock', 1, r.rarities[0]!.id, 2));
  void w;
  return { ch, inventory };
}

export function defaultHotbar(r: Ruleset, ch: CharacterState): (string | null)[] {
  const skills = knownSkills(r, ch).filter((id) => !rx(r).skill.get(id)?.utility);
  return skills.slice(0, 10);
}

export function statsOf(r: Ruleset, ch: CharacterState, solo: boolean) {
  return characterStats(r, ch, { solo });
}

export function restoreFully(r: Ruleset, ch: CharacterState, solo = false) {
  const s = statsOf(r, ch, solo);
  ch.hp = s.maxHp;
  for (const [id, p] of Object.entries(s.pools)) ch.pools[id] = p.max;
  ch.barrier = 0;
  ch.barrierTurns = 0;
  ch.downed = false;
  ch.statuses = [];
}

/** Clamp pools after equipment or stat changes. */
export function clampPools(r: Ruleset, ch: CharacterState, solo = false) {
  const s = statsOf(r, ch, solo);
  ch.hp = Math.min(ch.hp, s.maxHp);
  for (const [id, p] of Object.entries(s.pools)) ch.pools[id] = Math.min(ch.pools[id] ?? p.max, p.max);
}

/** Out-of-combat regeneration over `seconds`. Returns true if anything changed. */
export function regenerate(r: Ruleset, ch: CharacterState, solo: boolean, seconds: number): boolean {
  if (ch.downed) return false;
  const s = statsOf(r, ch, solo);
  const frac = seconds / Math.max(1, r.recovery.secondsToFull);
  let changed = false;
  if (ch.hp < s.maxHp) {
    ch.hp = Math.min(s.maxHp, ch.hp + s.maxHp * frac);
    changed = true;
  }
  for (const [id, p] of Object.entries(s.pools)) {
    if ((ch.pools[id] ?? 0) < p.max) {
      ch.pools[id] = Math.min(p.max, (ch.pools[id] ?? 0) + p.max * frac);
      changed = true;
    }
  }
  return changed;
}

/** Spend a tree point on a node. Returns an error or null. */
export function allocateNode(r: Ruleset, ch: CharacterState, nodeId: string): string | null {
  const err = canAllocate(r, ch, nodeId);
  if (err) return err;
  ch.tree[nodeId] = (ch.tree[nodeId] ?? 0) + 1;
  ch.treePoints--;
  const node = rx(r).nodes.get(ch.classId)?.get(nodeId);
  if (node?.kind === 'skill' && node.skillId && !ch.hotbar.includes(node.skillId)) {
    const i = ch.hotbar.indexOf(null);
    if (i >= 0) ch.hotbar[i] = node.skillId;
    else if (ch.hotbar.length < 10) ch.hotbar.push(node.skillId);
  }
  return null;
}

/** Grant experience; returns the number of levels gained. */
export function grantXp(r: Ruleset, ch: CharacterState, amount: number): number {
  if (ch.level >= r.progression.maxLevel) return 0;
  ch.xp += Math.max(0, Math.round(amount));
  const newLevel = levelForXp(r, ch.xp);
  const gained = newLevel - ch.level;
  if (gained > 0) {
    ch.level = newLevel;
    ch.treePoints += gained * r.progression.treePointsPerLevel;
    if (ch.npcId) autoSpend(r, ch);
    restoreFully(r, ch);
  }
  return gained;
}

/**
 * Automatic build policy (companions, the simulator's "typical" builds): favour the class's primary branch,
 * learn skills when available, rank up skills, take passives, and put spare points into primary attributes.
 * `style` biases branch choice so the simulator can sample different builds.
 */
export function autoSpend(r: Ruleset, ch: CharacterState, rng?: Rng, style: 'typical' | 'random' = 'typical') {
  const ix = rx(r);
  const cls = ix.cls.get(ch.classId);
  if (!cls) return;
  const nodes = [...(ix.nodes.get(ch.classId)?.values() ?? [])];
  let guard = 0;
  while (ch.treePoints > 0 && guard++ < 200) {
    const options = nodes.filter((n) => !canAllocate(r, ch, n.id));
    if (!options.length) break;
    const pick = style === 'random' && rng ? rng.pick(options) : typicalPick(r, ch, options, cls.primaryAttributes, cls.branches.map((b) => b.id));
    allocateNode(r, ch, pick.id);
  }
  ch.hotbar = defaultHotbar(r, ch);
}

function typicalPick(r: Ruleset, ch: CharacterState, options: TreeNode[], primaryAttrs: string[], branches: string[]): TreeNode {
  const score = (n: TreeNode) => {
    const rank = ch.tree[n.id] ?? 0;
    const branchBias = branches.indexOf(n.branch) === 0 ? 1.2 : branches.indexOf(n.branch) === 1 ? 1.05 : 0.95;
    switch (n.kind) {
      case 'skill': return 10 * branchBias + n.tier;
      case 'capstone': return 9 * branchBias;
      case 'rank': return (7 - rank) * branchBias;
      case 'passive': return (6 - rank * 1.5) * branchBias;
      case 'attribute': return primaryAttrs.includes(n.attributeId ?? '') ? 3 : 0.5;
    }
  };
  // Prefer progressing toward the next tier in the main branch.
  const main = branches[0]!;
  const spent = branchSpent(r, ch, main);
  const nextReq = r.progression.tierRequirements.find((x) => x > spent);
  return [...options].sort((a, b) => score(b) + (nextReq && b.branch === main ? 0.5 : 0) - (score(a) + (nextReq && a.branch === main ? 0.5 : 0)))[0]!;
}

/** Bring a fresh character to a level with an automatic build (companions, simulator). */
export function levelUpTo(r: Ruleset, ch: CharacterState, level: number, rng?: Rng, style: 'typical' | 'random' = 'typical') {
  ch.level = Math.max(1, Math.min(r.progression.maxLevel, level));
  ch.xp = r.progression.xp[ch.level] ?? 0;
  ch.treePoints = treePointsAt(r, ch.level) - Object.values(ch.tree).reduce((s, v) => s + v, 0);
  autoSpend(r, ch, rng, style);
  restoreFully(r, ch);
}
