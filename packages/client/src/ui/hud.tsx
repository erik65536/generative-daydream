import { readable } from './theme';
import { useEffect, useRef, useState } from 'react';
import { GROUND, OBJ, rx, skillAp, skillRank, xpForLevel, type EntityView } from '@gd/shared';
import { client, tryClient, useGame } from '../net/game';
import { statusName, weaponVisual } from '../rules';
import { Bar, Portrait, SkillIcon, SkillTooltip, tip } from './common';
import { Icon } from './svgicons';

export function PartyFrames() {
  const { player, combat, selected, world, version } = useGame((s) => ({ player: s.player, combat: s.combat, selected: s.selectedCharId, world: s.world, version: s.version }));
  const c = client();
  if (!player || !world) return null;
  void version;
  const r = world.ruleset;
  const ix = rx(r);
  const terms = r.terminology;
  return (
    <div className="party">
      {player.party.map((ch) => {
        const stats = c.charStats(ch);
        const ent = c.state.entities.get(ch.id);
        const active = combat?.activeId === ch.id;
        const xpLo = xpForLevel(r, ch.level), xpHi = xpForLevel(r, ch.level + 1);
        const maxed = ch.level >= r.progression.maxLevel;
        return (
          <div
            key={ch.id}
            className={`pcard ${selected === ch.id ? 'sel' : ''} ${active ? 'active' : ''} ${ch.downed ? 'down' : ''}`}
            onClick={() => {
              c.update({ selectedCharId: ch.id });
              if (!combat) c.send({ t: 'set_leader', charId: ch.id });
            }}
            {...tip(
              <div>
                <div className="tname gold">{ch.name}</div>
                <div className="tsub">{terms.level} {ch.level} {ix.kin.get(ch.kinId)?.name} {ix.cls.get(ch.classId)?.name}{ch.npcId ? ' · companion' : ''}</div>
                <div className="tline">{r.health.name} {Math.round(ch.hp)}/{stats.maxHp}{ch.barrier > 0 ? ` (+${Math.round(ch.barrier)})` : ''}</div>
                {r.pools.map((pl) => (
                  <div className="tline" key={pl.id}>{pl.name} {Math.round(ch.pools[pl.id] ?? 0)}/{stats.pools[pl.id]?.max ?? 0}</div>
                ))}
                <div className="tsub">{maxed ? `Maximum ${terms.level.toLowerCase()}` : `${terms.xp} ${ch.xp}/${xpHi}`}</div>
                {ch.treePoints > 0 && <div className="tsub" style={{ color: 'var(--gold-2)' }}>{ch.treePoints} unspent point{ch.treePoints > 1 ? 's' : ''} (K)</div>}
              </div>,
            )}
          >
            <div className="portrait">
              <Portrait size={52} sprite={c.assetUrl(ch.sprite)} colors={ch.colors} seed={ch.id} archetype={ch.archetype} weapon={weaponVisual(ch)} presentation={ch.presentation} />
            </div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="name">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.name}</span>
                <span className="lvl">{ch.level}</span>
                {ch.treePoints > 0 && <span className="pts" title="Unspent talent points (K)">+{ch.treePoints}</span>}
              </div>
              <Bar value={ch.hp} max={stats.maxHp} color={`linear-gradient(90deg, color-mix(in srgb, ${r.health.color} 55%, #000), ${r.health.color})`} label={`${Math.round(ch.hp)} / ${stats.maxHp}`} extra={ch.barrier} />
              {r.pools.length > 0 && (
                <div className="row" style={{ gap: 3 }}>
                  {r.pools.map((pl) => (
                    <div className="grow" key={pl.id}><Bar thin value={ch.pools[pl.id] ?? 0} max={stats.pools[pl.id]?.max ?? 0} color={pl.color} /></div>
                  ))}
                </div>
              )}
              <Bar thin value={maxed ? 1 : ch.xp - xpLo} max={maxed ? 1 : xpHi - xpLo} color="rgba(217,181,106,.7)" />
            </div>
            {ent?.statuses.length ? (
              <div style={{ position: 'absolute', bottom: -5, left: 60, display: 'flex', gap: 2 }}>
                {ent.statuses.slice(0, 6).map((st) => (
                  <span key={st.id} className="badge gray" style={{ padding: '0 4px', fontSize: 9, borderColor: ix.status.get(st.id)?.color }}>{statusName(st.id)} {st.turns}</span>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function Minimap({ onOpen }: { onOpen: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const zoneVersion = useGame((s) => s.zoneVersion);
  useEffect(() => {
    const draw = () => {
      const cv = ref.current;
      const c = tryClient();
      if (!c) return;
      const z = c.state.zone;
      const ts = z ? c.state.world?.tilesets[z.tilesetId] : undefined;
      if (!cv || !z || !ts || !c.state.explored) return;
      const S = 200;
      cv.width = S * 2;
      cv.height = S * 2;
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      // Transparent: a light sketch of the place over the world, fading out at the edges.
      ctx.clearRect(0, 0, S, S);
      const leader = c.leaderEntity();
      const lp = leader ? c.entityPos(leader) : { x: z.width / 2, y: z.height / 2 };
      const scale = 3.2;
      const cx = S / 2, cy = S / 2;
      const isoP = (x: number, y: number) => ({ x: cx + (x - y - (lp.x - lp.y)) * scale, y: cy + (x + y - (lp.x + lp.y)) * scale * 0.5 });
      const col: Record<number, string> = { [GROUND.floor]: 'rgba(225,228,236,0.26)', [GROUND.floorAlt]: 'rgba(225,228,236,0.26)', [GROUND.path]: 'rgba(235,238,245,0.42)', [GROUND.water]: 'rgba(110,165,230,0.42)', [GROUND.wall]: 'rgba(250,250,255,0.82)' };
      const R = 34;
      for (let y = Math.max(0, Math.floor(lp.y) - R); y < Math.min(z.height, lp.y + R); y++)
        for (let x = Math.max(0, Math.floor(lp.x) - R); x < Math.min(z.width, lp.x + R); x++) {
          if (!c.state.explored.get(y * z.width + x)) continue;
          const g = z.groundBytes[y * z.width + x]!;
          if (!g) continue;
          const o = z.objectBytes[y * z.width + x]!;
          const p = isoP(x, y);
          ctx.fillStyle = o === OBJ.tree ? 'rgba(250,250,255,0.5)' : col[g] ?? 'rgba(255,255,255,0.2)';
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - scale * 0.5);
          ctx.lineTo(p.x + scale, p.y);
          ctx.lineTo(p.x, p.y + scale * 0.5);
          ctx.lineTo(p.x - scale, p.y);
          ctx.fill();
        }
      ctx.globalAlpha = 1;
      for (const f of z.features) {
        if (!c.state.explored.get(f.y * z.width + f.x)) continue;
        if (f.kind !== 'exit' && f.kind !== 'door' && f.kind !== 'waypoint') continue;
        const p = isoP(f.x, f.y);
        ctx.fillStyle = f.kind === 'waypoint' ? '#8fd8ff' : '#ffe08a';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const e of c.state.entities.values()) {
        if (e.dead) continue;
        const ep = c.entityPos(e);
        if (!c.state.explored.get(Math.round(ep.y) * z.width + Math.round(ep.x))) continue;
        const p = isoP(ep.x, ep.y);
        ctx.fillStyle = e.ownerUserId === c.state.userId ? '#7fd0ff' : e.hostile ? '#ff5a4a' : e.kind === 'character' ? '#9fe0a0' : c.state.player?.npcMarkers[e.id] ? '#ffd24a' : '#e0d0b0';
        ctx.beginPath();
        ctx.arc(p.x, p.y, e.ownerUserId === c.state.userId ? 3 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      // Where you are: a ring at the centre.
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
      ctx.stroke();
      // Soft circular edge.
      const fade = ctx.createRadialGradient(cx, cy, S * 0.3, cx, cy, S * 0.5);
      fade.addColorStop(0, 'rgba(0,0,0,1)');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, S, S);
      ctx.globalCompositeOperation = 'source-over';
    };
    draw();
    const t = setInterval(draw, 400);
    return () => clearInterval(t);
  }, [zoneVersion]);
  return (
    <div className="minimap" onClick={onOpen} title="Map (M)">
      <canvas ref={ref} />
    </div>
  );
}

export function TopRight({ open }: { open: (p: 'inventory' | 'character' | 'skills' | 'quests' | 'map' | 'menu' | 'help' | 'craft' | 'codex') => void }) {
  const { zone, clockAt, paused } = useGame((s) => ({ zone: s.zone, clockAt: s.clock?.minute, paused: s.clock?.paused }));
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const m = client().clockMinute();
  const day = Math.floor(m / 1440) + 1;
  const h = Math.floor((m % 1440) / 60), mm = Math.floor(m % 60);
  void clockAt;
  return (
    <div className="topright">
      <div className="map-head">
        <div className="zone-name">{zone?.name}</div>
        <div className="clock">
          Day {day} · {String(h).padStart(2, '0')}:{String(mm).padStart(2, '0')}
          {paused ? ' · paused' : ''}
        </div>
      </div>
      <Minimap onOpen={() => open('map')} />
    </div>
  );
}

type Panel = Parameters<Parameters<typeof TopRight>[0]['open']>[0];

/** The game's menus, as a slim bar in the bottom-right corner beside the action bar. */
export function SystemBar({ open }: { open: (p: Panel) => void }) {
  const { world, player } = useGame((s) => ({ world: s.world, player: s.player }));
  const points = player?.party.reduce((s, c) => s + c.treePoints, 0) ?? 0;
  const r = world?.ruleset;
  const crafting = !!r && (r.crafting.enabled || r.crafting.upgrades.enabled || r.crafting.enchanting.enabled);
  const btn = (p: Panel, label: string, k: string, badge?: number) => (
    <button className="btn" onClick={() => open(p)} {...tip(<div><b>{label}</b> <span className="dim">({k})</span></div>)}>
      <Icon name={p} />
      <span className="k">{k}</span>
      {badge ? <span className="points">{badge}</span> : null}
    </button>
  );
  return (
    <div className="systembar">
      {btn('character', 'Character', 'C')}
      {btn('inventory', 'Inventory', 'I')}
      {btn('skills', 'Talents', 'K', points)}
      {btn('quests', r?.terminology.quest ? `${r.terminology.quest} log` : 'Quests', 'J')}
      {crafting && btn('craft', 'Crafting', 'B')}
      {btn('codex', 'Codex', 'X')}
      {btn('map', 'Map', 'M')}
      {btn('menu', 'Menu', 'Esc')}
    </div>
  );
}

export function startSkill(charId: string, skillId: string) {
  const c = client();
  const s = rx(c.r).skill.get(skillId);
  if (!s) return;
  if (s.targeting === 'self') {
    c.send({ t: 'use_skill', charId, skillId });
    c.update({ targeting: null });
    return;
  }
  const cur = c.state.targeting;
  if (cur?.skillId === skillId && cur.charId === charId) c.update({ targeting: null });
  else c.update({ targeting: { charId, skillId } });
}

export function ActionBar() {
  const { player, combat, selected, targeting, world, version } = useGame((s) => ({ player: s.player, combat: s.combat, selected: s.selectedCharId, targeting: s.targeting, world: s.world, version: s.version }));
  const c = client();
  void version;
  if (!player || !world) return null;
  const r = world.ruleset;
  const ix = rx(r);
  const terms = r.terminology;
  const ch = player.party.find((x) => x.id === selected) ?? player.party[0]!;
  const order = combat?.order.find((o) => o.id === ch.id);
  const myTurn = c.isMyTurn() && combat?.activeId === ch.id;
  const stats = c.charStats(ch);
  const ap = order?.ap ?? 0;
  const tsk = targeting?.skillId ? ix.skill.get(targeting.skillId) : undefined;
  const hover = tsk ? skillAp(tsk, stats) : 0;
  const slots = Array.from({ length: 10 }, (_, i) => ch.hotbar[i] ?? null);
  const pips = Math.max(stats.apMax, ap);
  return (
    <div className="actionbar">
      {combat && order && (
        <div className="row" style={{ gap: 10 }}>
          <div className="ap-row" {...tip(<div><b>{terms.actionPoints}</b>: {ap} / {stats.apMax}<div className="tsub">+{stats.apPerTurn} each turn. Moving costs 1 per {stats.move.toFixed(1)} tiles.</div></div>)}>
            {Array.from({ length: pips }, (_, i) => (
              <div key={i} className={`pip ${i < ap ? (myTurn && i >= ap - hover ? 'spend' : 'on') : ''}`} />
            ))}
          </div>
          {myTurn ? (
            <>
              <button className="btn primary" onClick={() => c.send({ t: 'end_turn' })}>End turn <span className="tiny" style={{ opacity: 0.7 }}>Space</span></button>
              <button className="btn sm ghost" onClick={() => c.send({ t: 'flee' })} {...tip('Leave combat if no enemy is near.')}>Flee</button>
            </>
          ) : (
            <div className="badge gray" style={{ padding: '6px 12px' }}>{combat.order.find((o) => o.id === combat.activeId)?.name}’s turn…</div>
          )}
        </div>
      )}
      <div className="slots">
        {slots.map((id, i) => {
          const s = id ? ix.skill.get(id) : undefined;
          if (!id || !s) return <div key={i} className="slot na"><span className="key">{(i + 1) % 10}</span></div>;
          const cd = ch.cooldowns[id] ?? 0;
          const cost = s.cost;
          const sap = skillAp(s, stats);
          const pool = cost ? ix.pool.get(cost.poolId) : undefined;
          const lacking = (cost && cost.amount > (ch.pools[cost.poolId] ?? 0)) || (combat && order && sap > ap);
          return (
            <div
              key={i}
              className={`slot ${targeting?.skillId === id && targeting.charId === ch.id ? 'on' : ''} ${cd > 0 ? 'cd' : ''} ${lacking ? 'na' : ''}`}
              style={cd > 0 ? ({ '--cdf': Math.min(1, cd / Math.max(1, s.cooldown)) } as React.CSSProperties) : undefined}
              onClick={() => startSkill(ch.id, id)}
              {...tip(<SkillTooltip id={id} r={r} stats={stats} cooldown={cd} rank={skillRank(r, ch, id)} />)}
            >
              <span className="key">{(i + 1) % 10}</span>
              <SkillIcon id={id} />
              {cd > 0 && <span className="cdn">{cd}</span>}
              {combat && <span className="ap">{sap}</span>}
              {cost && pool && <span className="cost" style={{ background: pool.color }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TurnBar() {
  const { combat, entities, userId } = useGame((s) => ({ combat: s.combat, entities: s.entities, userId: s.userId, v: s.version }));
  const c = client();
  if (!combat) return null;
  return (
    <div className="turnbar">
      <span className="round">Round {combat.round}</span>
      {combat.order.filter((o) => !(entities.get(o.id) as EntityView | undefined)?.dead).map((o) => {
        const e = entities.get(o.id) as EntityView | undefined;
        // Downed allies stay in the order (they can be revived); unseen combatants get a placeholder.
        const downed = !!e && e.hp <= 0;
        return (
          <div key={o.id} className={`tp ${o.team} ${o.id === combat.activeId ? 'active' : ''} ${downed ? 'dead' : ''}`} {...tip(<div><b>{o.name}</b>{e ? <div className="tsub">{e.hp}/{e.maxHp} · {o.controllerUserId === userId ? 'you' : o.team === 'players' ? 'ally' : 'enemy'}</div> : <div className="tsub">out of sight</div>}</div>)}>
            {e ? <Portrait size={42} sprite={c.assetUrl(e.sprite)} colors={e.colors} shape={e.shape} archetype={e.archetype} weapon={e.weapon} seed={e.id} kind={e.kind} /> : <span className="tp-unseen">{o.name.slice(0, 1)}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

export function CombatLog() {
  const { log, chat } = useGame((s) => ({ log: s.log, chat: s.chat }));
  const items = [...log.map((l) => ({ at: l.at, text: l.text, color: l.color })), ...chat.map((c) => ({ at: c.at, text: `${c.from}: ${c.text}`, color: '#a8d8ff' }))].sort((a, b) => a.at - b.at).slice(-12);
  return (
    <div className="log">
      {items.map((l, i) => (
        <div key={i} style={{ color: readable(l.color) }}>{l.text}</div>
      ))}
    </div>
  );
}

export function Narration() {
  const n = useGame((s) => s.narrations[0]);
  const c = client();
  if (!n) return null;
  const close = () => c.update({ narrations: c.state.narrations.slice(1) });
  return (
    <div className="narration-wrap" onMouseDown={(e) => e.stopPropagation()} onClick={close}>
      <div className="narration panel" onClick={(e) => e.stopPropagation()}>
        <div className="tiny dim" style={{ letterSpacing: '.2em', textTransform: 'uppercase', marginBottom: 6 }}>{n.style === 'arc' ? 'Revelation' : n.style === 'ending' ? 'Epilogue' : n.style === 'intro' ? 'Prologue' : ''}</div>
        <h2>{n.title}</h2>
        <p>{n.text}</p>
        <button className="btn primary" autoFocus onClick={close}>{n.style === 'intro' ? 'Begin' : 'Continue'}</button>
      </div>
    </div>
  );
}

