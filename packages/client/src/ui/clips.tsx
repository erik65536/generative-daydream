import { useEffect, useRef, useState } from 'react';
import { ACTOR_CLIPS, ANIM_DIRS, clipKey, type ActorAnim, type ClipName, type WorldDefinition } from '@gd/shared';
import { assetUrl } from '../api';

/**
 * An actor's clips playing in the studio: each clip in turn (or the one picked), turning a step clockwise after each
 * loop, at twice the game's size on the game's ground colour.
 */
export function ClipPreview({ w, k, anim }: { w: Pick<WorldDefinition, 'id' | 'assets'>; k: string; anim: ActorAnim }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const clips = ACTOR_CLIPS.filter((c) => anim.clips[c] && w.assets[clipKey(k, c)]?.file);
  const [pick, setPick] = useState<ClipName | 'all'>('all');
  const [dir, setDir] = useState<number | 'turn'>('turn');
  useEffect(() => {
    const sheets = new Map<ClipName, HTMLImageElement>();
    for (const c of clips) {
      const img = new Image();
      img.src = assetUrl(w.id, w.assets[clipKey(k, c)]!.file!);
      sheets.set(c, img);
    }
    const [cw, ch] = anim.cell;
    const k2 = 1 / anim.scale; // the sheet's own pixels at game size, then the canvas is shown at 2x
    let raf = 0, t0 = performance.now();
    let i = Math.max(0, pick === 'all' ? 0 : clips.indexOf(pick)), row = typeof dir === 'number' ? dir : 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const g = ref.current?.getContext('2d');
      const name = clips[i];
      if (!g || !name) return;
      const c = anim.clips[name]!, img = sheets.get(name)!;
      const dur = c.frames / c.fps, t = (now - t0) / 1000;
      if (t > dur + (c.loop ? 0 : 0.6)) {
        t0 = now;
        if (pick === 'all') i = (i + 1) % clips.length;
        if (dir === 'turn' && (pick !== 'all' || i === 0)) row = (row + 1) % 8;
        return;
      }
      const f = Math.min(c.frames - 1, Math.floor(t * c.fps));
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
      if (img.complete && img.naturalWidth) g.drawImage(img, f * cw, row * ch, cw, ch, 0, 0, cw * k2, ch * k2);
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.font = '9px system-ui';
      g.fillText(`${name} ${ANIM_DIRS[row]}`, 3, 10);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [w.id, k, anim, pick, dir, clips.join()]);
  return (
    <div className="col" style={{ gap: 4 }}>
      <canvas ref={ref} width={Math.round(anim.cell[0] / anim.scale)} height={Math.round(anim.cell[1] / anim.scale)} className="clip-preview" />
      <div className="row wrap" style={{ gap: 4 }}>
        <select className="input sm" value={pick} onChange={(e) => setPick(e.target.value as ClipName | 'all')}>
          <option value="all">All clips</option>
          {clips.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input sm" value={String(dir)} onChange={(e) => setDir(e.target.value === 'turn' ? 'turn' : Number(e.target.value))}>
          <option value="turn">Turning</option>
          {ANIM_DIRS.map((d, n) => <option key={d} value={n}>{d}</option>)}
        </select>
      </div>
    </div>
  );
}
