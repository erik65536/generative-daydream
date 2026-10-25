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

/** Where an objective leads, in words ("Mara Venn · Switchyard"). */
export function objectiveWhere(world: ClientWorld, player: PlayerView, o: QuestObjective): string | undefined {
  const zoneName = (id?: string) => world.zones.find((x) => x.id === id)?.name;
  const known = (id?: string) => !!id && player.knownZones.includes(id);
  if (o.npcId) {
    const n = world.npcs.find((x) => x.id === o.npcId);
    return n ? `${n.name}${known(n.zoneId) ? ` · ${zoneName(n.zoneId)}` : ''}` : undefined;
  }
  if (o.targetId) {
    const b = world.bosses.find((x) => x.id === o.targetId);
    if (b) return known(b.zoneId) ? zoneName(b.zoneId) : 'somewhere not yet found';
  }
  if (o.zoneId) return known(o.zoneId) ? zoneName(o.zoneId) : 'a place not yet on your map';
  if (o.familyId) {
    const z = world.zones.find((x) => x.familyIds?.includes(o.familyId!) && player.knownZones.includes(x.id));
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
