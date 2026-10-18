/** Controller HUD: the radial wheel, the prompt above what A would act on, and button glyphs. */
import { useGame } from '../net/game';
import { SkillIcon } from './common';
import { Icon } from './svgicons';

/** An Xbox face button or trigger, drawn the way players know it. */
export function Glyph({ b }: { b: 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'Menu' | 'View' }) {
  return <span className={`glyph-btn g-${b}`}>{b === 'Menu' ? '≡' : b === 'View' ? '⧉' : b}</span>;
}

/** Only rendered while the controller is the input in use. */
export function PadOnly({ children }: { children: React.ReactNode }) {
  const pad = useGame((s) => s.inputMode === 'pad');
  return pad ? <>{children}</> : null;
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
    </div>
  );
}

/** A compact legend of what the buttons do right now, at the bottom of the screen. */
export function PadLegend() {
  const { pad, combat, myTurn, modal, targeting } = useGame((s) => ({ pad: s.inputMode === 'pad', combat: !!s.combat, myTurn: !!s.combat && s.player?.party.some((p) => p.id === s.combat!.activeId), modal: !!(s.panel || s.dialog || s.trade || s.loot || s.narrations.length || s.wheel), targeting: !!s.targeting }));
  if (!pad || modal) return null;
  return (
    <div className="pad-legend">
      {combat ? (
        myTurn ? (
          <>
            <span><Glyph b="LB" /><Glyph b="RB" /> Target</span>
            <span><Glyph b="RT" /> Skills</span>
            <span><Glyph b="X" /> Attack nearest</span>
            {targeting ? <span><Glyph b="B" /> Cancel</span> : <span><Glyph b="Y" /> End turn</span>}
          </>
        ) : <span className="dim">Waiting for your turn</span>
      ) : (
        <>
          <span><Glyph b="RT" /> Skills</span>
          <span><Glyph b="LT" /> Menus</span>
          <span><Glyph b="LB" /><Glyph b="RB" /> Focus</span>
          <span><Glyph b="X" /> Attack</span>
          <span><Glyph b="Y" /> Journal</span>
        </>
      )}
    </div>
  );
}
