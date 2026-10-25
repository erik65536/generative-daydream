/** The pinned quest on the HUD: its current step, progress and where to go next. */
import type { ClientWorld, PlayerView, QuestDef, QuestObjective } from '@gd/shared';
import { client, useGame } from '../net/game';

/** The quest the HUD follows: the pinned one, or the main story when nothing was chosen ('' hides it). */
export function trackedQuest(player: PlayerView): QuestDef | undefined {
  const active = (id: string) => player.quests[id]?.status === 'active';
  if (player.pinnedQuestId === '') return undefined;
  if (player.pinnedQuestId && active(player.pinnedQuestId)) return player.questDefs[player.pinnedQuestId];
  return Object.values(player.questDefs).find((d) => d.main && active(d.id));
}

export function currentObjective(player: PlayerView, d: QuestDef): QuestObjective | undefined {
  const p = player.quests[d.id];
  const list = p?.overrides ?? d.objectives;
  return list.find((o) => !p?.objectives[o.id]?.done && !o.optional) ?? list.find((o) => !p?.objectives[o.id]?.done);
}

/**
 * Where an objective leads, in words ("Mara Venn · Switchyard"). The place is always named: the quest itself points
 * there (a step that names nowhere left players searching every place).
 */
export function objectiveWhere(world: ClientWorld, player: PlayerView, o: QuestObjective): string | undefined {
  const zoneName = (id?: string) => world.zones.find((x) => x.id === id)?.name;
  const companion = (id: string) => player.party.some((c) => c.npcId === id);
  if (o.npcId) {
    const n = world.npcs.find((x) => x.id === o.npcId);
    if (!n) return undefined;
    return companion(n.id) ? `${n.name} · with you` : `${n.name} · ${zoneName(n.zoneId) ?? 'somewhere'}`;
  }
  if (o.targetId) {
    const b = world.bosses.find((x) => x.id === o.targetId);
    if (b) return zoneName(b.zoneId);
  }
  if (o.zoneId) return zoneName(o.zoneId);
  if (o.featureId) return zoneName(world.zones.find((z) => z.features.some((f) => f.id === o.featureId))?.id);
  if (o.itemUniqueId) {
    const z = world.zones.find((x) => x.features.some((f) => f.items?.includes(o.itemUniqueId!)));
    if (z) return zoneName(z.id);
  }
  if (o.familyId) {
    // Where the party has been first, else the nearest kind of place that has them.
    const homes = world.zones.filter((x) => x.familyIds?.includes(o.familyId!));
    const z = homes.find((x) => player.knownZones.includes(x.id)) ?? homes[0];
    return z ? zoneName(z.id) : undefined;
  }
  return undefined;
}

/** The HUD shows the step, not the story: its first sentence, kept short. */
function firstSentence(text: string): string {
  const one = text.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? text;
  return one.length > 110 ? `${one.slice(0, 107).replace(/\s+\S*$/, '')}…` : one;
}

export function QuestTracker({ onOpen }: { onOpen: () => void }) {
  const { player, world } = useGame((s) => ({ player: s.player, world: s.world }));
  if (!player || !world) return null;
  const d = trackedQuest(player);
  if (!d) return null;
  const o = currentObjective(player, d);
  const prog = o ? player.quests[d.id]?.objectives[o.id] : undefined;
  const where = o ? objectiveWhere(world, player, o) : undefined;
  const pinned = player.pinnedQuestId === d.id;
  return (
    <div className="tracker" onClick={onOpen} title="Open the quest log (J)">
      <div className="tr-head">
        <span className="tr-kind">{d.main ? 'Story' : pinned ? 'Pinned' : world.ruleset.terminology.quest}</span>
        <button className="tr-x" title="Hide from the HUD" onClick={(e) => { e.stopPropagation(); client().send({ t: 'pin_quest', questId: '' }); }}>✕</button>
      </div>
      <div className="tr-title">{d.title}</div>
      {o && (
        <div className="tr-step">
          <span className="tr-dot" />
          <span>{firstSentence(o.description)}{(o.count ?? 1) > 1 ? ` (${prog?.progress ?? 0}/${o.count})` : ''}</span>
        </div>
      )}
      {where && <div className="tr-where">{where}</div>}
    </div>
  );
}
