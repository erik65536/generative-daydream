/** Controller HUD: the radial wheel, the prompt above what A would act on, and button glyphs. */
import { skillRank } from '@gd/shared';
import { client, useGame } from '../net/game';
import { SkillIcon, SkillTooltip } from './common';
import { Icon } from './svgicons';

/** An Xbox face button or trigger, drawn the way players know it. */
export function Glyph({ b }: { b: 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'Menu' | 'View' }) {
  return <span className={`glyph-btn g-${b}`}>{b === 'Menu' ? '≡' : b === 'View' ? '⧉' : b}</span>;
}

export function PadPrompt() {
  const p = useGame((s) => (s.inputMode === 'pad' && !s.wheel ? s.padPrompt : null));
  if (!p) return null;
  return (
    <div className="pad-prompt" style={{ left: p.x, top: p.y }}>
      <Glyph b="A" /> <span className="pp-verb">{p.verb}</span>{p.name && <span className="pp-name">{p.name}</span>}
    </div>
  );
}

export function PadWheel() {
  const w = useGame((s) => s.wheel);
  if (!w) return null;
  const n = w.items.length;
  const R = n > 6 ? 150 : 125;
  const cur = w.items[w.sel];
  return (
    <div className="pad-wheel">
      <div className="pw-ring" style={{ width: R * 2 + 90, height: R * 2 + 90 }}>
        {w.items.map((it, i) => {
          const a = (i / n) * Math.PI * 2;
          return (
            <div key={it.id} className={`pw-item ${i === w.sel ? 'on' : ''} ${it.disabled ? 'off' : ''}`} style={{ left: `calc(50% + ${Math.sin(a) * R}px)`, top: `calc(50% - ${Math.cos(a) * R}px)` }}>
              {w.kind === 'skills' ? <SkillIcon id={it.id} size={40} /> : <Icon name={it.icon as never} size={22} />}
            </div>
          );
        })}
        <div className="pw-center">
          <div className="pw-label">{cur?.label}</div>
          {cur?.sub && <div className="pw-sub">{cur.sub}</div>}
          <div className="pw-hint">Release <Glyph b={w.kind === 'skills' ? 'RT' : 'LT'} /> to choose · <Glyph b="B" /> cancel</div>
        </div>
      </div>
      {w.kind === 'skills' && cur && <WheelSkillCard id={cur.id} />}
    </div>
  );
}

/** The chosen skill's full description beside the wheel (what hovering it on the skill bar shows). */
function WheelSkillCard({ id }: { id: string }) {
  const c = client();
  const st = c.state;
  const chId = st.combat ? st.combat.activeId : st.selectedCharId ?? st.player?.leaderId;
  const ch = st.player?.party.find((p) => p.id === chId) ?? st.player?.party[0];
  if (!ch || !st.world) return null;
  const r = st.world.ruleset;
  return (
    <div className="pw-card tooltip">
      <SkillTooltip id={id} r={r} stats={c.charStats(ch)} cooldown={ch.cooldowns[id] ?? 0} rank={skillRank(r, ch, id)} />
    </div>
  );
}
