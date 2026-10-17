import { useEffect, useRef, useState } from 'react';
import { GROUND, OBJ, MAX_AP, getSkill, SKILLS, xpForLevel, type CharacterState, type EntityView } from '@gd/shared';
import { client, tryClient, useGame } from '../net/game';
import { Bar, Portrait, SkillIcon, SkillTooltip, tip } from './common';
import { Icon } from './svgicons';

const weaponOf = (ch: CharacterState) => {
  const id = ch.equipment.mainhand?.baseId;
  return id === 'w_bow' ? 'bow' : id === 'w_staff' ? 'staff' : id === 'w_wand' ? 'wand' : id === 'w_dagger' ? 'dagger' : id === 'w_heavy' ? 'axe' : 'sword';
};

export function PartyFrames() {
  const { player, combat, selected, terms, version } = useGame((s) => ({ player: s.player, combat: s.combat, selected: s.selectedCharId, terms: s.world?.terminology, version: s.version }));
  const c = client();
  if (!player || !terms) return null;
  void version;
  return (
    <div className="party">
      {player.party.map((ch) => {
        const stats = c.charStats(ch);
        const ent = c.state.entities.get(ch.id);
        const active = combat?.activeId === ch.id;
        const points = ch.unspentAttributes + ch.unspentSkillPoints;
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
                <div className="tsub">{terms.level} {ch.level} {c.state.world?.origins.find((o) => o.id === ch.originId)?.name}{ch.npcId ? ' · companion' : ''}</div>
                <div className="tline">{terms.health} {Math.round(ch.hp)}/{stats.maxHp}</div>
                <div className="tline">{terms.physArmor} {Math.round(ch.physArmor)}/{stats.maxPhys} · {terms.magArmor} {Math.round(ch.magArmor)}/{stats.maxMag}</div>
                <div className="tline">{terms.stamina} {Math.round(ch.stamina)}/{stats.maxStamina}{c.state.world?.systems.dualEnergy ? ` · ${terms.focus} ${Math.round(ch.focus)}/${stats.maxFocus}` : ''}</div>
                <div className="tsub">{terms.xp} {ch.xp}/{xpForLevel(ch.level + 1)}</div>
              </div>,
            )}
          >
            <div className="portrait">
              <Portrait size={52} sprite={c.assetUrl(ch.sprite)} colors={ch.colors} seed={ch.id} archetype={ch.archetype} weapon={weaponOf(ch)} />
            </div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="name">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.name}</span>
                <span className="lvl">{ch.level}</span>
              </div>
              {stats.maxPhys > 0 && <Bar thin value={ch.physArmor} max={stats.maxPhys} color="var(--phys)" />}
              {stats.maxMag > 0 && <Bar thin value={ch.magArmor} max={stats.maxMag} color="var(--mag)" />}
              <Bar value={ch.hp} max={stats.maxHp} color="linear-gradient(90deg,#8e1f18,#d8443a)" label={`${Math.round(ch.hp)} / ${stats.maxHp}`} />
              <div className="row" style={{ gap: 3 }}>
                <div className="grow"><Bar thin value={ch.stamina} max={stats.maxStamina} color="var(--stamina)" /></div>
                {c.state.world?.systems.dualEnergy && <div className="grow"><Bar thin value={ch.focus} max={stats.maxFocus} color="var(--focus)" /></div>}
              </div>
              <Bar thin value={ch.xp - xpForLevel(ch.level)} max={xpForLevel(ch.level + 1) - xpForLevel(ch.level)} color="rgba(217,181,106,.7)" />
            </div>
            {points > 0 && <div className="points">+{points}</div>}
            {ent?.statuses.length ? (
              <div style={{ position: 'absolute', bottom: -5, left: 60, display: 'flex', gap: 2 }}>
                {ent.statuses.slice(0, 6).map((s) => (
                  <span key={s.id} className="badge gray" style={{ padding: '0 4px', fontSize: 9 }}>{terms.statuses[s.id]} {s.turns}</span>
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
      ctx.fillStyle = '#0a0810';
      ctx.fillRect(0, 0, S, S);
      const leader = c.leaderEntity();
      const lp = leader ? c.entityPos(leader) : { x: z.width / 2, y: z.height / 2 };
      const scale = 3.2;
      const cx = S / 2, cy = S / 2;
      const isoP = (x: number, y: number) => ({ x: cx + (x - y - (lp.x - lp.y)) * scale, y: cy + (x + y - (lp.x + lp.y)) * scale * 0.5 });
      const col: Record<number, string> = { [GROUND.floor]: ts.roles.floor.colors[0]!, [GROUND.floorAlt]: ts.roles.floorAlt.colors[0]!, [GROUND.path]: ts.roles.path.colors[0]!, [GROUND.water]: ts.roles.water.colors[0]!, [GROUND.wall]: ts.roles.wall.colors[0]! };
      const R = 34;
      for (let y = Math.max(0, Math.floor(lp.y) - R); y < Math.min(z.height, lp.y + R); y++)
        for (let x = Math.max(0, Math.floor(lp.x) - R); x < Math.min(z.width, lp.x + R); x++) {
          if (!c.state.explored.get(y * z.width + x)) continue;
          const g = z.groundBytes[y * z.width + x]!;
          if (!g) continue;
          const o = z.objectBytes[y * z.width + x]!;
          const p = isoP(x, y);
          ctx.fillStyle = o === OBJ.tree ? ts.roles.tree.colors[0]! : col[g] ?? '#333';
          ctx.globalAlpha = g === GROUND.wall ? 1 : 0.85;
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

export function TopRight({ open }: { open: (p: 'inventory' | 'character' | 'skills' | 'quests' | 'map' | 'menu' | 'help' | 'craft') => void }) {
  const { zone, world, clockAt, paused, player } = useGame((s) => ({ zone: s.zone, world: s.world, clockAt: s.clock?.minute, paused: s.clock?.paused, player: s.player }));
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const m = client().clockMinute();
  const day = Math.floor(m / 1440) + 1;
  const h = Math.floor((m % 1440) / 60), mm = Math.floor(m % 60);
  void clockAt;
  const points = player?.party.reduce((s, c) => s + c.unspentAttributes + c.unspentSkillPoints, 0) ?? 0;
  const btn = (p: Parameters<typeof open>[0], label: string, k: string, badge?: number) => (
    <button className="btn" onClick={() => open(p)} {...tip(<div><b>{label}</b> <span className="dim">({k})</span></div>)}>
      <Icon name={p} />
      <span className="k">{k}</span>
      {badge ? <span className="points" style={{ right: -4, top: -4 }}>{badge}</span> : null}
    </button>
  );
  return (
    <div className="topright">
      <Minimap onOpen={() => open('map')} />
      <div className="zone-name">{zone?.name}</div>
      <div className="clock">
        Day {day} · {String(h).padStart(2, '0')}:{String(mm).padStart(2, '0')}
        {paused ? ' · paused' : ''}
      </div>
      <div className="menu-btns">
        {btn('character', 'Character', 'C', points)}
        {btn('inventory', 'Inventory', 'I')}
        {btn('skills', 'Skills', 'K')}
        {btn('quests', world?.terminology.quest ? `${world.terminology.quest} log` : 'Quests', 'J')}
        {world?.systems.crafting && btn('craft', 'Crafting', 'B')}
        {btn('map', 'Map', 'M')}
        {btn('menu', 'Menu', 'Esc')}
      </div>
    </div>
  );
}

export function startSkill(charId: string, skillId: string) {
  const c = client();
  const s = getSkill(skillId);
  if (!s) return;
  if (s.passive) return;
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
  const { player, combat, selected, targeting, terms, version } = useGame((s) => ({ player: s.player, combat: s.combat, selected: s.selectedCharId, targeting: s.targeting, terms: s.world?.terminology, version: s.version }));
  const c = client();
  void version;
  if (!player || !terms) return null;
  const ch = player.party.find((x) => x.id === selected) ?? player.party[0]!;
  const order = combat?.order.find((o) => o.id === ch.id);
  const myTurn = c.isMyTurn() && combat?.activeId === ch.id;
  const stats = c.charStats(ch);
  const ap = order?.ap ?? 0;
  const hover = targeting?.skillId ? getSkill(targeting.skillId)?.ap ?? 0 : 0;
  const naming = c.naming()!;
  const slots = Array.from({ length: 10 }, (_, i) => ch.hotbar[i] ?? null);
  return (
    <div className="actionbar">
      {combat && order && (
        <div className="row" style={{ gap: 10 }}>
          <div className="ap-row" {...tip(<div>{terms.actionPoints}: {ap} / {MAX_AP}. Moving costs 1 per {stats.tilesPerAp.toFixed(1)} tiles.</div>)}>
            {Array.from({ length: MAX_AP }, (_, i) => (
              <div key={i} className={`pip ${i < ap ? (myTurn && i >= ap - hover ? 'spend' : 'on') : ''}`} />
            ))}
          </div>
          {myTurn ? (
            <>
              <button className="btn primary" onClick={() => c.send({ t: 'end_turn' })}>End turn <span className="tiny" style={{ opacity: 0.7 }}>Space</span></button>
              <button className="btn sm ghost" onClick={() => c.send({ t: 'flee' })} {...tip('Leave combat if no enemy is near.')}>Flee</button>
            </>
          ) : (
            <div className="badge gray" style={{ padding: '6px 12px' }}>{combat.order.find((o) => o.id === combat.activeId)?.name}'s turn…</div>
          )}
        </div>
      )}
      <div className="slots">
        {slots.map((id, i) => {
          if (!id) return <div key={i} className="slot na"><span className="key">{(i + 1) % 10}</span></div>;
          const s = getSkill(id);
          const cd = ch.cooldowns[id] ?? 0;
          const cost = s?.cost ?? 0;
          const poolKey = s && (s.school === 'elemental' || s.school === 'occult' || s.school === 'restoration') && c.state.world?.systems.dualEnergy ? 'focus' : 'stamina';
          const lacking = cost > (poolKey === 'focus' ? ch.focus : ch.stamina) || (combat && order && (s?.ap ?? 0) > ap);
          return (
            <div
              key={i}
              className={`slot ${targeting?.skillId === id && targeting.charId === ch.id ? 'on' : ''} ${cd > 0 ? 'cd' : ''} ${lacking ? 'na' : ''}`}
              onClick={() => startSkill(ch.id, id)}
              {...tip(<SkillTooltip id={id} ctx={naming} terms={terms} cooldown={cd} />)}
            >
              <span className="key">{(i + 1) % 10}</span>
              <SkillIcon id={id} />
              {cd > 0 && <span className="cdn">{cd}</span>}
              {combat && s && <span className="ap">{s.ap}</span>}
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
      {combat.order.map((o) => {
        const e = entities.get(o.id) as EntityView | undefined;
        const dead = !e || e.dead || e.hp <= 0;
        return (
          <div key={o.id} className={`tp ${o.team} ${o.id === combat.activeId ? 'active' : ''} ${dead ? 'dead' : ''}`} {...tip(<div><b>{o.name}</b>{e ? <div className="tsub">{e.hp}/{e.maxHp} · {o.controllerUserId === userId ? 'you' : o.team === 'players' ? 'ally' : 'enemy'}</div> : null}</div>)}>
            {e && <Portrait size={42} sprite={c.assetUrl(e.sprite)} colors={e.colors} shape={e.shape} archetype={e.archetype} weapon={e.weapon} seed={e.id} kind={e.kind} />}
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
        <div key={i} style={{ color: l.color }}>{l.text}</div>
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

export { SKILLS };
