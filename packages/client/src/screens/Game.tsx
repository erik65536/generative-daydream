import { useEffect, useRef, useState } from 'react';
import { rx } from '@gd/shared';
import type { Me } from '../api';
import { GameClient, setClient, clearClient, useGame, client } from '../net/game';
import { Renderer, type HoverInfo } from '../render/renderer';
import { ActionBar, CombatLog, Narration, PartyFrames, Toasts, TopRight, TurnBar, startSkill } from '../ui/hud';
import { CharacterWindow, CodexWindow, CraftWindow, DialogWindow, HelpWindow, InventoryWindow, LootWindow, MapWindow, MenuWindow, QuestWindow, SkillsWindow, TradeWindow } from '../ui/windows';
import { hideTip } from '../ui/common';
import { navigate } from '../App';
import { applyWorldTheme } from '../ui/theme';

export function GameScreen({ me, instanceId }: { me: Me; instanceId: string }) {
  const [gc, setGc] = useState<GameClient | null>(null);
  useEffect(() => {
    const c = new GameClient(instanceId);
    setClient(c);
    (window as unknown as { __gd?: GameClient }).__gd = c; // debugging handle
    c.connect();
    setGc(c);
    return () => {
      c.close();
      clearClient(c);
    };
  }, [instanceId]);
  if (!gc) return null;
  return <GameView key={instanceId} me={me} />;
}

function handleClick(r: Renderer, info: HoverInfo, button: number, ev?: MouseEvent) {
  const c = client();
  const st = c.state;
  hideTip();
  if (st.narrations.length) return;
  if (button === 2) {
    if (st.targeting) c.update({ targeting: null });
    return;
  }
  if (button !== 0) return;
  const charId = st.selectedCharId ?? st.player?.leaderId;
  if (!charId) return;
  const tgt = st.targeting;
  if (tgt) {
    const point = info.tile ? { x: info.tile.x, y: info.tile.y } : undefined;
    const targetId = info.entityId;
    if (tgt.skillId) {
      const s = rx(c.r).skill.get(tgt.skillId);
      const needsEntity = s?.targeting === 'enemy' || s?.targeting === 'ally';
      if (needsEntity && !targetId) return c.toast('Choose a target.', 'bad');
      else c.send({ t: 'use_skill', charId: tgt.charId, skillId: tgt.skillId, targetId, x: point?.x, y: point?.y });
    } else if (tgt.itemId) c.send({ t: 'use_item', charId: tgt.charId, itemId: tgt.itemId, targetId, x: point?.x, y: point?.y });
    c.update({ targeting: null });
    return;
  }
  if (info.entityId) {
    const e = st.entities.get(info.entityId);
    if (!e) return;
    if (e.ownerUserId === st.userId) {
      c.update({ selectedCharId: e.id });
      if (!st.combat) c.send({ t: 'set_leader', charId: e.id });
      return;
    }
    if (e.hostile && !e.dead) {
      const actor = st.combat ? st.combat.activeId : charId;
      c.send({ t: 'use_skill', charId: actor, skillId: 'attack', targetId: e.id });
      return;
    }
    if (e.kind === 'npc' && !st.combat) {
      c.send({ t: 'interact', targetId: e.id, charId });
      return;
    }
  }
  if ((info.featureId || info.lootId) && !st.combat) {
    // Click takes everything; shift-click opens the container to pick items.
    c.send({ t: 'interact', targetId: (info.lootId ?? info.featureId)!, charId, inspect: !!ev?.shiftKey });
    return;
  }
  if (info.tile) {
    const at = !st.combat && info.point ? info.point : info.tile;
    c.send({ t: 'move', x: at.x, y: at.y, charId: st.combat ? undefined : charId });
  }
  void r;
}

function GameView({ me }: { me: Me }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const { status, error, panel, dialog, trade, loot, targeting, world, combat } = useGame((s) => ({ status: s.status, error: s.error, panel: s.panel, dialog: s.dialog, trade: s.trade, loot: s.loot, targeting: s.targeting, world: s.world, combat: s.combat }));
  const [note, setNote] = useState<{ x: number; y: number; text: string; ok: boolean } | null>(null);
  const c = client();

  useEffect(() => {
    const r = new Renderer(canvasRef.current!, c);
    rendererRef.current = r;
    r.onClick = (info, button, ev) => handleClick(r, info, button, ev);
    const noteTimer = setInterval(() => {
      const n = r.cursorNote;
      r.cursorNote = null;
      setNote(n ? { x: r.hover.screenX, y: r.hover.screenY, ...n } : null);
    }, 80);
    return () => {
      clearInterval(noteTimer);
      r.destroy();
    };
  }, []);

  // The UI takes its colours and typefaces from the world.
  useEffect(() => applyWorldTheme(world), [world?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = c.state;
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      const toggle = (p: NonNullable<typeof st.panel>) => c.update({ panel: st.panel === p ? null : p });
      if (k === 'escape') {
        if (st.narrations.length) return c.update({ narrations: st.narrations.slice(1) });
        if (st.targeting) return c.update({ targeting: null });
        if (st.loot) return c.send({ t: 'close_loot' });
        if (st.dialog) return c.send({ t: 'end_dialog' });
        if (st.trade) return c.send({ t: 'end_trade' });
        if (st.panel) return c.update({ panel: null });
        return c.update({ panel: 'menu' });
      }
      if (st.narrations.length) {
        if (k === 'enter' || k === ' ') c.update({ narrations: st.narrations.slice(1) });
        return;
      }
      if (/^[0-9]$/.test(k)) {
        const idx = k === '0' ? 9 : Number(k) - 1;
        const chId = st.combat ? st.combat.activeId : st.selectedCharId ?? st.player?.leaderId;
        const ch = st.player?.party.find((p) => p.id === chId) ?? st.player?.party[0];
        const sk = ch?.hotbar[idx];
        if (ch && sk) startSkill(ch.id, sk);
        return;
      }
      if ((k === ' ' || k === 'enter') && st.combat && c.isMyTurn()) {
        e.preventDefault();
        c.send({ t: 'end_turn' });
        return;
      }
      if (k === 'tab' && st.player) {
        e.preventDefault();
        const party = st.player.party;
        const i = party.findIndex((p) => p.id === st.selectedCharId);
        const next = party[(i + 1) % party.length]!;
        c.update({ selectedCharId: next.id });
        if (!st.combat) c.send({ t: 'set_leader', charId: next.id });
        return;
      }
      if (st.dialog) return;
      if (k === 'i') toggle('inventory');
      else if (k === 'c') toggle('character');
      else if (k === 'k') toggle('skills');
      else if (k === 'j' || k === 'l' || k === 'q') toggle('quests');
      else if (k === 'm') toggle('map');
      else if (k === 'b' && st.world && (st.world.ruleset.crafting.enabled || st.world.ruleset.crafting.upgrades.enabled || st.world.ruleset.crafting.enchanting.enabled)) toggle('craft');
      else if (k === 'x') toggle('codex');
      else if (k === 'h' || k === '?') toggle('help');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const close = () => c.update({ panel: null });
  return (
    <div
      className={`game ${targeting ? 'targeting' : ''}`}
      onContextMenu={(e) => {
        // The game uses right-click; keep the browser menu only for text fields.
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
      }}
    >
      <canvas ref={canvasRef} className="view" />
      {/* Per-world colour grading over the scene (below the HUD). */}
      <div className="grade" aria-hidden><i className="grain" /></div>
      <div className="hud">
        <PartyFrames />
        <TopRight open={(p) => c.update({ panel: panel === p ? null : p })} />
        <TurnBar />
        <ActionBar />
        <CombatLog />
        <Toasts />
        {targeting && (
          <div className="badge" style={{ position: 'absolute', bottom: 132, left: '50%', transform: 'translateX(-50%)', padding: '6px 14px', fontSize: 12 }}>
            {targeting.skillId ? `Choose a target for ${c.skillName(targeting.skillId)}` : 'Choose where to use it'} — right-click to cancel
          </div>
        )}
        {panel === 'inventory' && <InventoryWindow onClose={close} />}
        {panel === 'character' && <CharacterWindow onClose={close} />}
        {panel === 'skills' && <SkillsWindow onClose={close} />}
        {panel === 'quests' && <QuestWindow onClose={close} />}
        {panel === 'map' && <MapWindow onClose={close} />}
        {panel === 'craft' && <CraftWindow onClose={close} />}
        {panel === 'menu' && <MenuWindow onClose={close} onHelp={() => c.update({ panel: 'help' })} onCodex={() => c.update({ panel: 'codex' })} />}
        {panel === 'help' && <HelpWindow onClose={close} />}
        {panel === 'codex' && <CodexWindow onClose={close} />}
        {trade && <TradeWindow />}
        {trade && panel !== 'inventory' && <InventoryWindow onClose={() => c.send({ t: 'end_trade' })} />}
        {dialog && !trade && <DialogWindow />}
        {loot && <LootWindow />}
        <Narration />
        {note && <div className={`cursor-note ${note.ok ? '' : 'bad'}`} style={{ left: note.x, top: note.y }}>{note.text}</div>}
        {combat && !c.isMyTurn() && <div />}
      </div>
      {status !== 'connected' && (
        <div className="connection">
          {status === 'connecting' ? <div className="spinner" /> : <div className="display gold" style={{ fontSize: 20 }}>{error ?? 'Disconnected'}</div>}
          {status !== 'connecting' && (
            <div className="row">
              <button className="btn" onClick={() => location.reload()}>Reconnect</button>
              <button className="btn ghost" onClick={() => navigate('#/')}>Back to worlds</button>
            </div>
          )}
          <span className="dim small">{me.username}</span>
        </div>
      )}
    </div>
  );
}
