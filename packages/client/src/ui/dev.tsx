/**
 * Developer options for admins (toggle with the ` key): go to any place, see the whole map, reload the daydream
 * after it was edited on disk, zoom far out, and hide the HUD for clean views. Ctrl+click teleports the party.
 */
import { useState } from 'react';
import { client, useGame } from '../net/game';
import type { Renderer } from '../render/renderer';

export function DevPanel({ renderer, hudHidden, setHudHidden, onClose }: { renderer: Renderer | null; hudHidden: boolean; setHudHidden: (v: boolean) => void; onClose: () => void }) {
  const c = client();
  const { world, zone } = useGame((s) => ({ world: s.world, zone: s.zone }));
  const [q, setQ] = useState('');
  const [peace, setPeace] = useState(false);
  if (!world) return null;
  const outer = world.zones.filter((z) => z.kind !== 'interior');
  const list = outer.flatMap((z) => [z, ...world.zones.filter((i) => i.parentZoneId === z.id)]).filter((z) => !q || z.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="dev-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Developer</b>
        <button className="btn sm ghost" onClick={onClose}>×</button>
      </div>
      <div className="dim small">Ctrl+click: teleport · ` toggles this panel</div>
      <div className="row wrap" style={{ gap: 4 }}>
        <button className="btn sm" onClick={() => c.send({ t: 'dev', action: 'reveal' })}>Reveal map</button>
        <button className="btn sm" title="Load the daydream again from disk (after rebuilding a place)" onClick={() => c.send({ t: 'dev', action: 'reload' })}>Reload daydream</button>
        <button className="btn sm" onClick={() => setHudHidden(!hudHidden)}>{hudHidden ? 'Show HUD' : 'Hide HUD'}</button>
        <button className="btn sm" onClick={() => renderer && (renderer.devZoom = !renderer.devZoom)}>Far zoom</button>
        <button className="btn sm" onClick={() => (c.send({ t: 'dev', action: 'peace', on: !peace }), setPeace(!peace))}>{peace ? 'Peaceful ✓' : 'Peaceful'}</button>
        <button className="btn sm" title="Show places from their painting, or from their tiles" onClick={() => renderer && (renderer.usePaintings = !renderer.usePaintings)}>Painting on/off</button>
      </div>
      <input className="input" placeholder="Find a place…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="dev-zones">
        {list.map((z) => (
          <button key={z.id} className={`dev-zone ${z.id === zone?.id ? 'on' : ''} ${z.kind === 'interior' ? 'sub' : ''}`} onClick={() => c.send({ t: 'dev', action: 'goto', zoneId: z.id })}>
            {z.name} <span className="dim">{z.kind}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
