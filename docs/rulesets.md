# Generated rulesets

Every world has its own **ruleset**: pure data, generated with the world, interpreted by one deterministic engine.
No code is generated. AI models choose *structure and intent*; the engine owns *numbers*.

```
LLM ── RulesetIntent ──► compiler (power budget) ──► Ruleset ──► balance loop (simulation) ──► final Ruleset
         names, roles,        deterministic numbers      tuned knobs + report        (+ AI review of flavour/structure,
         relative weights                                                             then recompile + rebalance)
```

## Engine invariants (not data)

| Area | Invariant |
|---|---|
| Combat | Always turn-based. Turn model is engine code; the ruleset picks one and sets its parameters. Implemented: `ap` (action points). Planned: `rounds` (action + bonus + move). |
| Death | Death mode is engine code. Implemented: `corpse_run` — the party respawns in the last town; the bag (not equipment, not quest items) stays on a corpse to recover. |
| Downed | Allies are downed at 0 health and only die if the whole party falls. Revive mode: `heal` (any heal revives), `special` (only revive effects), `after_combat` (1 health after combat). Downed allies always get up at 1 health after a won fight. |
| Resolution | Random rolls: damage variance, crit chance, dodge chance (either can be 0 / disabled). No armour-as-health. |
| Recovery | Health and pools always regenerate out of combat; every fight starts fresh, so encounters are balanced individually. |
| Decisions | No meta effects: nothing skips a turn, nothing forces a target (no sleep, stun-skip or taunt). Control effects restrict options instead: root, silence, disarm, slow (−AP). Control is followed by immunity. |
| Party | Solo, four player-controlled heroes, or the player plus three AI companions made with the world. |
| Space | Line of sight for every ranged effect; no attacks of opportunity, flanking or cover (yet). |
| Inventory | Slot-limited (no weight); stacking materials and potions; purchasable inventory upgrades. One currency. |
| Out of scope | Durability, ammo, hunger/survival, factions/reputation, stealth (later), summons (later), respec. |

## What a ruleset contains

Health (always), 0–N skill pools, AP (when the turn model uses it), 3–N attributes with per-point effects, 1–N damage
types each with a mitigation stat, 0–N subtypes each with a resistance (capped; absorbing a subtype is an explicit
effect, never overflow), statuses built from primitives (damage/heal over time, stat modifiers, control), optional
surfaces, 3–N equipment slots, item bases, affixes and rarities, potions, materials, optional crafting / upgrades /
enchanting, fast travel, 1-4 kins (each one gender, with its own look), classes with an upgrade tree, class-restricted skills with ranks, monster roles, traps,
progression (level curve solved from the world's content), economy, inventory, difficulty profiles, terminology.

### Upgrade trees

Every class tree has a fixed *shape*: three themed branches × four tiers plus a shared attribute branch.
Tiers unlock by points spent in that branch. Nodes are: skill unlock, skill rank (upgrade), passive (modifiers),
capstone. Points per level replace attribute points — attributes are just ranks in the attribute branch.
The AI fills the nodes; the compiler prices them.

## Numbers: the power budget

Everything is priced in one unit: a fraction of a reference character's combat power at its level.

* Reference curves per level: health `H(L)`, damage per AP `D(L)`, mitigation rating scale `K(L)`.
* Mitigation % = rating / (rating + K(L)) — gear rated for a lower level gets worse as you out-level it.
* A skill's damage coefficient comes from its AP cost, cooldown, resource cost, range, area and riders, priced per
  AP against the basic attack (100% weapon damage for 2 AP): a free skill is no better than attacking; a cooldown or a
  pool cost earns its edge (a cheap 1-AP skill hits about a fifth harder per AP).
* Pools (stamina, mana) refill 5% a combat turn and skills cost 15%, 25% or 40% of them, so they run dry in a long
  fight and plain attacks fill the gaps.
* Each attribute point, tree node, affix and potion is worth a fixed budget, split over its effects by the AI's weights.
* Monsters use the same curves × role weights × tuned per-level multipliers.

## Balance loop

Headless, synchronous combat core (the same code the game runs) on small arenas:

1. **Encounter suite** — the world's party mode vs normal / elite / boss packs at several levels, with level-typical
   gear and builds. Fits monster health/damage multipliers per level to hit targets (win rate, health lost, rounds).
2. **Class parity** — each class against the same encounters; per-class corrections pull outliers in.
3. **Usage telemetry** — skills nobody uses get stronger, dominant skills weaker (bounded).
4. **Build search** — sampled tree allocations per class find outlier builds; offending nodes are re-priced.
5. **Difficulty profiles** — the same suite with per-difficulty targets solves enemy multipliers per level,
   so difficulty can change per save without regenerating the world. Low levels get gentler multipliers
   because fights there are only a few hits long.

The report (targets vs achieved) is stored with the ruleset and shown on the world page.

## Words

Players must understand every rule word at first sight. Rules use plain, familiar game words (Health, Experience,
Gold, Fire, Poison, Strength...) and rename one only when the theme truly calls for it, to a word anyone recognises
(Credits on a space station, Hull for a ship). The theme shows in skills, items, classes and descriptions.

## Regenerating

There are no migrations: a world made under other rules can **regenerate its rules** (keeping lore and art; its
heroes are painted again for the new classes and kins, its companions keep their places in a class of the same role)
or **rebalance** (same intent, new engine numbers). Reveries begun under regenerated rules cannot be continued.
