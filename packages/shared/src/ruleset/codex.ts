/** Player-facing rule documentation, generated entirely from a ruleset. */
import type { DifficultyId, Ruleset } from './types';
import { knot, rx } from './stats';
import { modifierLabel } from './describe';

export interface CodexEntry {
  title: string;
  color?: string;
  /** Short flavour or explanation. */
  text?: string;
  /** Mechanical facts. */
  lines: string[];
}

export interface CodexSection {
  id: string;
  title: string;
  intro?: string;
  entries: CodexEntry[];
}

const CONTROL_TEXT: Record<string, string> = {
  root: 'cannot move',
  silence: 'cannot use skills (basic attacks still work)',
  disarm: 'cannot use weapon attacks',
  slow: 'loses action points each turn',
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "a", "a and b", "a, b and c". */
function listing(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

export function codexSections(r: Ruleset): CodexSection[] {
  const ix = rx(r);
  const t = r.terminology;
  const out: CodexSection[] = [];

  // ---------------------------------------------------------------- basics
  const basics: CodexEntry[] = [];
  basics.push({
    title: 'Turns',
    text: `Combat is turn-based. Everyone acts in order of initiative; on your turn you spend ${t.actionPoints} to move, attack and use skills, in any order. Thinking is free — nothing happens until you act.`,
    lines: [
      `You start a fight with ${r.turn.apStart} ${t.actionPoints} and gain ${r.turn.apPerTurn} each turn (up to ${r.turn.apMax}). Unspent points carry over.`,
      `Moving costs 1 ${t.actionPoints} per ${r.turn.tilesPerAp} tiles, plus extra for difficult ground.`,
      'Ranged attacks and skills need a clear line of sight.',
      'Out of combat, time flows normally and skills that work outside combat can be used freely.',
    ],
  });
  const res: string[] = [`Damage varies by ±${pct(r.resolution.variance)} each hit.`];
  if (r.resolution.crit) res.push(`Critical hits (base ${pct(r.resolution.baseCrit / 100)}, at most ${pct(r.resolution.critCap)}) deal ${pct(r.resolution.critMult)} damage.`);
  else res.push('There are no critical hits in this world.');
  if (r.resolution.dodge) res.push(`Attacks can be dodged (base ${pct(r.resolution.baseDodge / 100)}, at most ${pct(r.resolution.dodgeCap)}).`);
  else res.push('Attacks never miss.');
  basics.push({ title: 'Hits', lines: res });
  basics.push({
    title: 'Falling in battle',
    lines: [
      `A character reduced to 0 ${r.health.name} is downed, not dead.`,
      r.revive === 'heal' ? 'Any healing brings a downed ally back up.' : r.revive === 'special' ? 'Only reviving skills and items can bring a downed ally back during a fight.' : 'Downed allies get back up when the fight ends.',
      'Downed allies always recover after a won fight.',
      `If the whole ${t.party.toLowerCase()} falls, you wake in the last ${t.town.toLowerCase()} you visited. Your equipment stays with you, but your pack${r.death.keepGold ? '' : ` and ${t.currency}`} remain${r.death.keepGold ? 's' : ''} on your body — go back and recover it.`,
    ],
  });
  basics.push({
    title: 'Recovery',
    lines: [
      `Out of combat, ${listing([r.health.name, ...r.pools.map((p) => p.name)])} refill${r.pools.length ? '' : 's'} completely in about ${Math.round(r.recovery.secondsToFull)} seconds.`,
      ...r.pools.map((p) => `${p.name} restores ${pct(p.regenPerTurn)} each combat turn.`),
    ],
  });
  if (r.party.soloBonus.hp || r.party.soloBonus.dmg || r.party.soloBonus.ap) {
    const b = r.party.soloBonus;
    basics.push({ title: 'Travelling alone', lines: [[b.hp ? `+${pct(b.hp)} ${r.health.name}` : '', b.dmg ? `+${pct(b.dmg)} damage` : '', b.ap ? `+${b.ap} ${t.actionPoints} per turn` : ''].filter(Boolean).join(', ') + ' for a lone adventurer.'] });
  }
  out.push({ id: 'basics', title: 'How it works', intro: r.intro, entries: basics });

  // ---------------------------------------------------------------- resources & attributes
  const resEntries: CodexEntry[] = [{ title: r.health.name, color: r.health.color, lines: ['When it reaches 0 you are downed.', 'Barriers absorb damage before it is taken.'] }];
  for (const p of r.pools) resEntries.push({ title: p.name, color: p.color, text: p.description, lines: [`Starts at ${Math.round(p.base)} and grows ${Math.round(p.perLevel * 10) / 10} per ${t.level.toLowerCase()}.`, 'Spent by skills.'] });
  out.push({ id: 'resources', title: 'Resources', entries: resEntries });

  out.push({
    id: 'attributes',
    title: 'Attributes',
    intro: `Everyone starts with ${r.attributeBase} in each attribute, adjusted by kin and class. Each point above that gives:`,
    entries: r.attributes.map((a) => ({ title: `${a.name} (${a.abbr})`, text: a.description, lines: a.perPoint.map((m) => modifierLabel(r, m, 1)) })),
  });

  // ---------------------------------------------------------------- damage
  const dmg: CodexEntry[] = r.damageTypes.map((d) => ({
    title: d.name,
    color: d.color,
    text: d.description,
    lines: [`Reduced by ${d.mitigationName}. Higher ${d.mitigationName} gives diminishing returns, up to 85% reduction.`],
  }));
  if (r.systems.subtypes) {
    for (const s of r.subtypes) dmg.push({ title: s.name, color: s.color, lines: [`A kind of ${ix.type.get(s.typeId)?.name ?? s.typeId} damage.`, 'Resistances reduce it further (at most 75% for heroes). Resistance never turns damage into healing.'] });
  }
  out.push({ id: 'damage', title: 'Damage', intro: 'Every hit has a damage type. Armour-like defences reduce each type separately, and some creatures have strengths and weaknesses.', entries: dmg });

  // ---------------------------------------------------------------- statuses & surfaces
  if (r.systems.statuses && r.statuses.length) {
    out.push({
      id: 'statuses',
      title: 'Conditions',
      intro: r.control.enabled ? `Control effects can't be applied again to the same target for ${r.control.immunityTurns} turn${r.control.immunityTurns === 1 ? '' : 's'} after they wear off.` : undefined,
      entries: r.statuses.map((s) => {
        const lines: string[] = [];
        if (s.dot) lines.push(`Deals ${(s.dot.subtypeId ? ix.subtype.get(s.dot.subtypeId)?.name : ix.type.get(s.dot.typeId)?.name) ?? ''} damage every turn.`);
        if (s.hot) lines.push(`Restores ${r.health.name} every turn.`);
        for (const m of s.modifiers ?? []) lines.push(modifierLabel(r, m, 1));
        if (s.control) lines.push(`The target ${CONTROL_TEXT[s.control] ?? s.control}${s.control === 'slow' && s.apLoss ? ` (${s.apLoss})` : ''}.`);
        return { title: s.name, color: s.color, text: s.description, lines: lines.length ? lines : [s.harmful ? 'Harmful.' : 'Beneficial.'] };
      }),
    });
  }
  if (r.systems.surfaces && r.surfaces.length) {
    out.push({
      id: 'surfaces',
      title: 'Surfaces',
      intro: 'Some skills leave lasting ground effects. Standing in them, or walking through, has consequences — and some combine.',
      entries: r.surfaces.map((s) => {
        const lines: string[] = [];
        if (s.dot) lines.push('Damages anyone standing in it.');
        if (s.statusId) lines.push(`Inflicts ${ix.status.get(s.statusId)?.name ?? s.statusId}.`);
        if (s.moveCost) lines.push(`Slows movement (+${s.moveCost} per tile).`);
        for (const re of s.reactions ?? []) lines.push(`Meets ${ix.surface.get(re.other)?.name ?? re.other}: ${re.result ? `becomes ${ix.surface.get(re.result)?.name ?? re.result}` : 'both vanish'}.`);
        return { title: s.name, color: s.color, lines };
      }),
    });
  }

  // ---------------------------------------------------------------- characters
  out.push({
    id: 'classes',
    title: 'Callings',
    intro: `Each class has its own skills and an upgrade tree of three branches. Kin add a smaller bonus.`,
    entries: [
      ...r.classes.map((c) => ({
        title: c.name,
        text: c.description,
        lines: [
          `Role: ${c.role}. Key attributes: ${listing(c.primaryAttributes.map((a) => ix.attr.get(a)?.name ?? a))}.`,
          `Starts with ${listing(c.startingSkills.map((s) => ix.skill.get(s)?.name ?? s))}.`,
          `Branches: ${c.branches.map((b) => b.name).join(' · ')}.`,
        ],
      })),
      ...r.kins.map((k) => ({
        title: k.name,
        text: k.description,
        lines: [
          ...Object.entries(k.attributes).filter(([, v]) => v).map(([a, v]) => `${v > 0 ? '+' : ''}${v} ${ix.attr.get(a)?.name ?? a}`),
          ...k.modifiers.map((m) => modifierLabel(r, m, 1)),
        ],
      })),
    ],
  });

  const pr = r.progression;
  out.push({
    id: 'progression',
    title: 'Growing stronger',
    entries: [
      {
        title: `${t.level}s`,
        lines: [
          `${t.xp} comes from defeating foes and, above all, finishing ${t.quest.toLowerCase()}s. The highest ${t.level.toLowerCase()} is ${pr.maxLevel}.`,
          `You start with ${pr.treePointsStart} upgrade point${pr.treePointsStart === 1 ? '' : 's'} and gain ${pr.treePointsPerLevel} each ${t.level.toLowerCase()}.`,
        ],
      },
      {
        title: 'Upgrade trees',
        lines: [
          'Spend points to learn new skills, improve skills you know, or gain passive bonuses.',
          `Deeper tiers open after spending ${listing(pr.tierRequirements.slice(1).map(String))} points in that branch.`,
          `The shared attribute branch gives +${pr.attributePerRank} to an attribute per rank.`,
          'Trainers can also teach skills from your tree.',
          'Choices are permanent — plan your build.',
        ],
      },
    ],
  });

  // ---------------------------------------------------------------- items
  const items: CodexEntry[] = [
    { title: 'Equipment', lines: [`Slots: ${r.slots.map((s) => s.name).join(', ')}.`, 'Better items appear deeper in the world, and from tougher foes.'] },
    { title: 'Rarity', lines: r.rarities.map((x) => `${x.name}: ${x.affixes[0] === x.affixes[1] ? x.affixes[0] : `${x.affixes[0]}–${x.affixes[1]}`} bonus${x.affixes[1] === 1 ? '' : 'es'}`) },
    {
      title: 'Your pack',
      lines: [
        `Holds ${r.inventory.slots} stacks${r.inventory.upgrades ? `; merchants can enlarge it ${r.inventory.upgrades} times (+${r.inventory.slotsPerUpgrade} each)` : ''}.`,
        'Story items never take space.',
        `Merchants buy at about ${pct(r.economy.sellRatio)} of the price.`,
      ],
    },
  ];
  const craft: string[] = [];
  if (r.crafting.enabled && r.recipes.length) craft.push(`${r.recipes.length} recipes turn materials into useful things.`);
  if (r.crafting.upgrades.enabled) craft.push(`Equipment can be improved up to +${r.crafting.upgrades.maxLevel} (+${pct(r.crafting.upgrades.perLevel)} base power each).`);
  if (r.crafting.enchanting.enabled) craft.push('Enchanting replaces one bonus on an item with a new random one.');
  if (craft.length) items.push({ title: 'Crafting', lines: craft });
  if (r.systems.traps || r.systems.locks) {
    items.push({
      title: 'Traps and locks',
      lines: [
        ...(r.systems.traps ? ['Traps are hidden until someone notices them; trap sense widens the range. Spotted traps can be avoided or disarmed.'] : []),
        ...(r.systems.locks ? ['Locked chests and doors need a key, a tool, or a skilled hand.'] : []),
      ],
    });
  }
  out.push({ id: 'items', title: 'Gear', entries: items });

  // ---------------------------------------------------------------- difficulty
  const mid = Math.max(1, Math.round(pr.maxLevel / 2));
  out.push({
    id: 'difficulty',
    title: 'Difficulty',
    intro: 'Difficulty is chosen per journey and can be changed by its owner from the menu. It changes your foes, not you.',
    entries: (Object.keys(r.difficulty) as DifficultyId[]).map((id) => {
      const d = r.difficulty[id];
      const f = (k: typeof d.enemyHp) => `${pct(knot(k, 1))} → ${pct(knot(k, mid))} → ${pct(knot(k, pr.maxLevel))}`;
      return {
        title: d.name,
        lines: [
          `Enemy ${r.health.name}: ${f(d.enemyHp)} (${t.level.toLowerCase()} 1 → ${mid} → ${pr.maxLevel})`,
          `Enemy damage: ${f(d.enemyDmg)}`,
          ...(d.extraEnemyChance ? [`${pct(d.extraEnemyChance)} chance of an extra foe per group`] : []),
          ...(d.eliteChance ? [`${pct(d.eliteChance)} chance a foe is an elite`] : []),
          ...(d.lootMult !== 1 ? [`Loot ×${Math.round(d.lootMult * 100) / 100}`] : []),
        ],
      };
    }),
  });
  return out;
}
