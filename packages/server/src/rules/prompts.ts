/** Prompts for the ruleset design steps. The model decides structure, names and relative weights — never numbers. */
import type { WorldInput } from '@gd/shared';
import type { ClassesIntent, CoreIntent, GearIntent, RulesOverrides } from './intent';

export const RULES_SYSTEM = `You design the RULES of a turn-based RPG world for the "Generative Daydream" engine (in the spirit of Baldur's Gate 2 / Divinity: Original Sin 2).
You choose structure, names and relative weights (1-5). You never write numbers for damage, health or costs: a deterministic engine prices everything and a simulator balances it.
Engine facts you cannot change: combat is turn-based with action points; there is always a health stat (you name it); defeat sends the party back to the last town; items have levels and rarities; skills belong to one class each and are learned through an upgrade tree (three themed branches per class, four tiers).
Make the rules feel native to the setting — a cozy world might fight with bonks and sparkles, a sci-fi world with plasma and shielding — while staying clear and readable to players.
Output only the requested JSON.`;

function overrideLines(o?: RulesOverrides): string {
  if (!o) return '';
  const lines: string[] = [];
  if (o.revive) lines.push(`revive mode is fixed to "${o.revive}"`);
  if (o.crit !== undefined) lines.push(`critical hits are ${o.crit ? 'on' : 'off'}`);
  if (o.dodge !== undefined) lines.push(`dodge is ${o.dodge ? 'on' : 'off'}`);
  if (o.control !== undefined) lines.push(`control effects (root/silence/disarm/slow) are ${o.control ? 'on' : 'off'}`);
  if (o.surfaces !== undefined) lines.push(`ground surfaces are ${o.surfaces ? 'on' : 'off'}`);
  if (o.traps !== undefined) lines.push(`traps are ${o.traps ? 'on' : 'off'}`);
  if (o.locks !== undefined) lines.push(`locked containers are ${o.locks ? 'on' : 'off'}`);
  if (o.crafting !== undefined) lines.push(`crafting is ${o.crafting ? 'on' : 'off'}`);
  if (o.upgrades !== undefined) lines.push(`item upgrades are ${o.upgrades ? 'on' : 'off'}`);
  if (o.enchanting !== undefined) lines.push(`enchanting is ${o.enchanting ? 'on' : 'off'}`);
  return lines.length ? `\nTHE PLAYER CHOSE: ${lines.join('; ')}. Respect these.` : '';
}

export function corePrompt(world: string, input: WorldInput): string {
  return `${world}

Design the CORE RULES for this world.${overrideLines(input.rules)}
- "numbers": how big numbers feel (cozy/silly worlds: small; grim/epic: medium; high-tech: large).
- "health": what this world calls health (Health, Integrity, Spirits, Composure...) and its bar colour.
- "terminology": names for experience, level, action points (short, like AP), currency, party, town, dungeon, wilderness, quest, and what this world calls a character's class ("calling") and their origin or ancestry ("kin"). Use the world's own idiom (an office world might say Job Title and Department).
- "pools": 0-3 resources skills spend. Mark each physical, magical or any. Classes will be built around them.
- "attributes": 3-6 attributes. Each lists 1-3 effects with weights 1-5. Effects: health, health_regen, pool (of = pool name), pool_regen, melee_damage, ranged_damage, skill_damage, all_damage, type_damage (of = damage type), subtype_damage (of = subtype), healing, crit_chance, crit_damage, dodge, movement, initiative, mitigation (of = damage type), resist_all, resist (of = subtype), trap_sense, lockpicking, barter, loot_find, life_steal, thorns. Give every major play style (melee, ranged, skills, healing) an attribute that feeds it.
- "damageTypes": 1-3 broad categories, each with its own mitigation stat name (e.g. Physical → Armor, Magical → Ward).
- "subtypes": 0-8 flavours of damage, each belonging to a damage type, optionally with the status it tends to inflict.
- "statuses": up to 12 conditions. kinds: damage_over_time (give subtype), heal_over_time, buff, debuff (stats with direction), control (root = cannot move, silence = no skills, disarm = no weapon attacks, slow = fewer action points). NEVER create skip-turn, sleep, stun-skip or taunt effects.
- "slots": 3-10 equipment slots with exactly one weapon slot (add off-hand, armor and accessory slots that fit the setting).
- "rarities": five quality names, lowest to highest.
- "traps": up to 6 trap kinds (if traps fit), each with a subtype and/or status.
- "systems": which optional systems fit (traps, locks, surfaces, crafting, upgrades, enchanting, buffPotions, damagePotions, control).
- "rules": crit and dodge on/off, how swingy damage is (variance), and how downed allies come back (heal = any healing revives, special = only revive effects, after_combat = only when the fight ends).
- "inventory": bag slots (20-200) and how many bag upgrades can be bought (0-10).
- "ui": the interface's material and ornament style, its lettering ("typeface": engraved, classic, modern, condensed, storybook, gothic or technical), and a colour grading tint and mood for the game view. Match the world's feel, not its genre label.`;
}

export function coreSummary(c: CoreIntent): string {
  return [
    `RULES "${c.name}": ${c.intro}`,
    `Health is "${c.health.name}". Pools: ${c.pools.map((p) => `${p.name} (${p.use})`).join(', ') || 'none'}.`,
    `Attributes: ${c.attributes.map((a) => a.name).join(', ')}.`,
    `Damage types: ${c.damageTypes.map((d) => `${d.name} (mitigated by ${d.mitigationName})`).join(', ')}. Subtypes: ${c.subtypes.map((s) => `${s.name} [${s.type}${s.status ? `, ${s.status}` : ''}]`).join(', ') || 'none'}.`,
    `Statuses: ${c.statuses.map((s) => `${s.name} (${s.kind}${s.control ? `:${s.control}` : ''})`).join(', ') || 'none'}.`,
    `Slots: ${c.slots.map((s) => `${s.name} (${s.kind})`).join(', ')}. Currency: ${c.terminology.currency}.`,
  ].join('\n');
}

export function gearPrompt(world: string, core: CoreIntent): string {
  return `${world}

${coreSummary(core)}

Design the GEAR, CONSUMABLES and PEOPLES of this world (names and kinds only; the engine sets all numbers).
- "weapons": 3-8 weapon kinds with a style (light_melee, heavy_melee = two-handed, quick_melee = fast light blades, ranged = two-handed bows/guns, caster = channels skills, thrown), a damage type from the list and optionally a subtype.
- "armor": names for armor pieces per armor slot (${core.slots.filter((s) => s.kind === 'armor').map((s) => s.name).join(', ')}) in heavy, medium and light weights.
- "offhands": shields, foci, quivers or charms that fit the world.
- "accessories": names for the accessory slots (${core.slots.filter((s) => s.kind === 'accessory').map((s) => s.name).join(', ') || 'none'}).
- "potions": 2-8 consumables (heal, restore a pool, buff = a status, damage = thrown at enemies, cleanse, revive).
- "materials": up to 6 crafting materials with tiers 1-3; "valuables": things only worth selling.
- "tools": names for the trap-disarming tool, the lock-opening tool and the item that returns you to town.
- "affixNames": optional prefix/suffix names for item enchantments by effect (e.g. melee_damage → "Brutal" / "of Force").
- "kins": 1-6 peoples/species/backgrounds the player can be. Each gets up to two small attribute bonuses and an optional perk.`;
}

export function classesPrompt(world: string, core: CoreIntent, gear: GearIntent, count: [number, number]): string {
  return `${world}

${coreSummary(core)}
Weapons: ${gear.weapons.map((w) => `${w.name} (${w.style})`).join(', ')}. Off-hands: ${gear.offhands.map((o) => `${o.name} (${o.style})`).join(', ') || 'none'}.

Design ${count[0]}-${count[1]} player CLASSES. Each needs a clear role (tank, melee, ranged, caster, support, hybrid) so a party feels complete; cover at least a front-liner, a damage dealer and a healer/support.
For each: name, description, role, 1-2 primary attributes (from the list), the pool its skills spend, its starting weapon (exact name), armor weight, optional off-hand, "appearance" (a visual description of their outfit, gear and bearing used to draw them; gender-neutral, because players choose a feminine, masculine or androgynous hero: no he/she, man/woman, beards or other gendered traits), and three themed upgrade-tree "branches".`;
}

export function treePrompt(world: string, core: CoreIntent, cls: ClassesIntent['classes'][number]): string {
  return `${world}

${coreSummary(core)}

CLASS: ${cls.name} (${cls.role}) — ${cls.description}
Branches: 0 = ${cls.branches[0]?.name}, 1 = ${cls.branches[1]?.name}, 2 = ${cls.branches[2]?.name}. Spends: ${cls.pool ?? 'no pool'}.

Design this class's SKILLS and PASSIVES for its upgrade tree.
- "skills": 8-10 skills spread over the three branches and tiers 0-3 (tier 0 is basic, tier 3 is a powerful capstone ability). The tier-0 skills of branches 0 and 1 are known from the start, so make them dependable everyday tools (one of them must deal damage unless the class is pure support).
  For each skill choose: targeting (enemy, ally, self, ground), range (melee, weapon = the weapon's reach, short, long), area (none, small, large), ap 1-3, cooldown (none, short, long), cost (none, low, medium, high), usesWeapon (true for weapon techniques), up to 3 effects with weights 1-5 (damage, heal, barrier, status, surface, restore, cleanse, revive, lifesteal, chain, teleport, dash, push) — "of" names the exact subtype, damage type, status or pool — and a visual fx.
  Stronger effects come from higher ap, longer cooldowns, higher costs and higher tiers; the engine prices it all.
- "passives": 4-8 passive upgrades (stat effects from the attribute effect list, weights 1-5), each in a branch and tier; mark exactly one or two as capstones (tier 3).
Use ONLY statuses, subtypes and pools that exist in the rules above.`;
}

export const REVIEW_SYSTEM = `You review the rules of an RPG world after an automated balance simulation. You may only change flavour and structure: names, descriptions, which effects a skill combines and their relative weights, a passive's stat picks. You cannot change numbers — the engine will re-price and re-balance after your edits. Only propose changes that clearly improve fun, clarity or fit with the setting. Output only the requested JSON.`;
