/**
 * Controller play, designed for a pad rather than a mouse adapted to one:
 *
 *   Exploring   left stick walks; the nearest person, chest, way out or pile ahead is focused (LB/RB to change)
 *               and A acts on it; X attacks the nearest foe.
 *   Combat      a ground cursor snaps to foes (LB/RB), shows the path and cost, and A moves or attacks there;
 *               Y ends the turn; B flees (or backs out of aiming).
 *   Anywhere    hold RT for the skill wheel and LT for the menu wheel (pick with either stick, release to
 *               choose); d-pad left/right switches character; right stick zooms; Menu opens the game menu.
 *   Windows     the d-pad or left stick moves a focus ring between controls, A presses, X opens an item's
 *               actions, LB/RB switch tabs, B goes back.
 */
import { rx } from '@gd/shared';
import type { GameClient, WheelItem } from '../net/game';
import type { HoverInfo, Renderer } from '../render/renderer';
import { PadNav } from './spatial';

const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
const DEAD = 0.28;
const PANELS: { id: NonNullable<GameClient['state']['panel']>; label: string }[] = [
  { id: 'inventory', label: 'Inventory' },
  { id: 'character', label: 'Character' },
  { id: 'skills', label: 'Talents' },
  { id: 'quests', label: 'Journal' },
  { id: 'map', label: 'Map' },
  { id: 'craft', label: 'Crafting' },
  { id: 'codex', label: 'Codex' },
  { id: 'menu', label: 'Menu' },
];
const INTERACTIVE = new Set(['chest', 'exit', 'sign', 'lore', 'craft_station', 'waypoint', 'object']);

interface Target { info: HoverInfo; verb: string; name: string; x: number; y: number; hostile?: boolean }

export class PadInput {
  private raf = 0;
  private prev: boolean[] = [];
  private lastMove = 0;
  private moving = false;
  private heading = { x: -1, y: 0 };
  private sentDir = { x: 0, y: 0 };
  private focusIdx = 0;
  private cursor: { x: number; y: number } | null = null;
  private repeatAt = 0;
  private nav = new PadNav();

  constructor(private r: Renderer, private c: GameClient, private act: (info: HoverInfo, button: number) => void) {
    this.raf = requestAnimationFrame(this.tick);
    window.addEventListener('gamepadconnected', this.connected);
    (window as unknown as { __padInput?: PadInput }).__padInput = this; // debugging handle
  }

  /** Read the controller once (the frame loop does this; tests call it directly). */
  poll() {
    this.read();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('gamepadconnected', this.connected);
    this.nav.clear();
  }

  private connected = () => this.c.toast('Controller connected. Hold RT for skills, LT for menus.', 'info');

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    this.read();
  };

  private read() {
    const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p && p.connected);
    if (!pad) return;
    const down = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    const pressed = (i: number) => down[i] && !this.prev[i];
    const released = (i: number) => !down[i] && this.prev[i];
    const lx = pad.axes[0] ?? 0, ly = pad.axes[1] ?? 0, rxs = pad.axes[2] ?? 0, rys = pad.axes[3] ?? 0;
    const any = down.some(Boolean) || Math.hypot(lx, ly) > DEAD || Math.hypot(rxs, rys) > DEAD;
    if (any && this.c.state.inputMode !== 'pad') this.c.update({ inputMode: 'pad' });
    try {
      this.step(down, pressed, released, { lx, ly, rx: rxs, ry: rys });
    } finally {
      this.prev = down;
    }
  }

  private step(down: boolean[], pressed: (i: number) => boolean, released: (i: number) => boolean, s: { lx: number; ly: number; rx: number; ry: number }) {
    const c = this.c, st = c.state;
    if (st.status !== 'connected' || !st.player) return;

    // Radial wheels: hold a trigger, aim with a stick, release to choose.
    if (st.wheel) {
      const ax = Math.hypot(s.rx, s.ry) > 0.5 ? s.rx : s.lx, ay = Math.hypot(s.rx, s.ry) > 0.5 ? s.ry : s.ly;
      if (Math.hypot(ax, ay) > 0.5) {
        const n = st.wheel.items.length;
        const ang = (Math.atan2(ax, -ay) + Math.PI * 2) % (Math.PI * 2);
        const sel = Math.round(ang / ((Math.PI * 2) / n)) % n;
        if (sel !== st.wheel.sel) c.update({ wheel: { ...st.wheel, sel } });
      }
      const trigger = st.wheel.kind === 'skills' ? B.RT : B.LT;
      if (released(trigger) || pressed(B.A)) this.chooseWheel();
      else if (pressed(B.B)) c.update({ wheel: null });
      return;
    }

    // Windows, conversations and story cards: move a focus ring between their controls.
    const modal = st.narrations.length > 0 || !!st.panel || !!st.dialog || !!st.trade || !!st.loot;
    if (modal) {
      this.stopWalking();
      this.r.setPadHover(null);
      if (st.padPrompt) c.update({ padPrompt: null });
      this.nav.step(down, pressed, { x: s.lx, y: s.ly }, s.ry);
      return;
    }
    this.nav.clear();

    if (pressed(B.MENU)) return c.update({ panel: 'menu' });
    if (pressed(B.VIEW) || pressed(B.UP)) return c.update({ panel: 'map' });
    if (pressed(B.DOWN)) return c.update({ panel: 'inventory' });
    if (pressed(B.LEFT) || pressed(B.RIGHT)) return this.switchCharacter(pressed(B.RIGHT) ? 1 : -1);
    if (Math.abs(s.ry) > 0.5) this.r.zoomBy(s.ry > 0 ? 0.985 : 1.015);
    if (pressed(B.RT)) return this.openSkills();
    if (pressed(B.LT)) return c.update({ wheel: { kind: 'panels', items: PANELS.filter((p) => p.id !== 'craft' || this.crafting()).map((p) => ({ id: p.id!, label: p.label, icon: p.id! })), sel: 0 } });

    if (st.combat) {
      this.r.steer = null;
      this.moving = false;
      this.combat(pressed, s);
    } else this.explore(pressed, s);
  }

  // ---------------------------------------------------------------------------- exploring

  private explore(pressed: (i: number) => boolean, s: { lx: number; ly: number }) {
    const c = this.c, st = c.state;
    this.cursor = null;
    const lead = c.leaderEntity();
    if (!lead) return;
    const mag = Math.hypot(s.lx, s.ly);
    if (mag > DEAD) {
      // Steering: the server keeps the party walking this way; we only tell it when the direction changes
      // (and now and then, so it knows the stick is still held).
      const d = this.r.screenDirToGround(s.lx, s.ly);
      this.heading = d;
      this.r.steer = d;
      const now = performance.now();
      const turned = d.x * this.sentDir.x + d.y * this.sentDir.y < 0.99;
      if (!this.moving || (turned && now - this.lastMove > 60) || now - this.lastMove > 150) {
        this.lastMove = now;
        this.sentDir = d;
        const at = this.r.predictedPos();
        c.send({ t: 'steer', dx: d.x, dy: d.y, x: at?.x, y: at?.y });
        this.moving = true;
      }
    } else this.stopWalking();

    // Focus: what A would act on.
    const targets = this.nearby(lead);
    if (pressed(B.RB)) this.focusIdx++;
    if (pressed(B.LB)) this.focusIdx--;
    const t = targets.length ? targets[((this.focusIdx % targets.length) + targets.length) % targets.length] : undefined;
    this.r.setPadHover(t?.info ?? null);
    const prompt = t ? this.promptAt(t.verb, t.name, t.x, t.y) : null;
    if (JSON.stringify(prompt) !== JSON.stringify(st.padPrompt)) c.update({ padPrompt: prompt });
    if (pressed(B.A) && t) {
      this.stopWalking();
      this.act(t.info, 0);
    }
    if (pressed(B.X)) {
      const foe = targets.find((x) => x.hostile) ?? this.nearestFoe(lead, 9);
      if (foe) this.act(foe.info, 0);
    }
    if (pressed(B.Y)) c.update({ panel: 'quests' });
    if (pressed(B.B) && st.targeting) c.update({ targeting: null });
  }

  private stopWalking() {
    this.r.steer = null;
    if (!this.moving) return;
    this.moving = false;
    // Stop where this screen shows the leader.
    const at = this.r.predictedPos();
    this.c.send({ t: 'steer', dx: 0, dy: 0, x: at?.x, y: at?.y });
  }

  /** Things to act on near the leader, best first: close, and ahead of where the party is heading. */
  private nearby(lead: { x: number; y: number; id: string }): Target[] {
    const st = this.c.state;
    const out: (Target & { score: number })[] = [];
    const score = (x: number, y: number) => {
      const dx = x - lead.x, dy = y - lead.y, d = Math.hypot(dx, dy);
      const ahead = d > 0.01 ? (dx * this.heading.x + dy * this.heading.y) / d : 1;
      return d - ahead * 0.8;
    };
    for (const e of st.entities.values()) {
      if (e.id === lead.id || e.dead || e.ownerUserId === st.userId) continue;
      const d = Math.hypot(e.x - lead.x, e.y - lead.y);
      if (e.hostile && d < 7) out.push({ info: this.r.hoverAt(e, { entityId: e.id }), verb: 'Attack', name: e.name, x: e.x, y: e.y, hostile: true, score: score(e.x, e.y) + 1.5 });
      else if (e.kind === 'npc' && !e.hostile && d < 3.2) out.push({ info: this.r.hoverAt(e, { entityId: e.id }), verb: e.marker === 'trade' ? 'Trade' : 'Talk', name: e.name, x: e.x, y: e.y, score: score(e.x, e.y) });
    }
    for (const f of st.zone?.features ?? []) {
      if (!INTERACTIVE.has(f.kind) || Math.hypot(f.x - lead.x, f.y - lead.y) > 2.6 || (f.kind === 'object' && !this.c.questThingOpen(f.id))) continue;
      const fs = st.features.get(f.id);
      if (f.kind === 'chest' && fs?.opened) continue;
      const verbs: Record<string, string> = { chest: 'Open', exit: 'Travel', sign: 'Read', lore: 'Read', craft_station: 'Craft', waypoint: 'Waypoint', object: 'Examine' };
      const verb = verbs[f.kind] ?? 'Use';
      out.push({ info: this.r.hoverAt(f, { featureId: f.id }), verb, name: f.name ?? f.kind, x: f.x, y: f.y, score: score(f.x, f.y) });
    }
    for (const l of st.lootPiles) {
      if (Math.hypot(l.x - lead.x, l.y - lead.y) > 2.6 || (l.ownerUserId && l.ownerUserId !== st.userId)) continue;
      out.push({ info: this.r.hoverAt(l, { lootId: l.id }), verb: 'Take', name: l.label, x: l.x, y: l.y, score: score(l.x, l.y) - 0.3 });
    }
    return out.sort((a, b) => a.score - b.score);
  }

  private nearestFoe(from: { x: number; y: number }, within: number): Target | undefined {
    let best: Target | undefined, bd = within;
    for (const e of this.c.state.entities.values()) {
      if (!e.hostile || e.dead) continue;
      const d = Math.hypot(e.x - from.x, e.y - from.y);
      if (d < bd) {
        bd = d;
        best = { info: this.r.hoverAt(e, { entityId: e.id }), verb: 'Attack', name: e.name, x: e.x, y: e.y, hostile: true };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------- combat

  private combat(pressed: (i: number) => boolean, s: { lx: number; ly: number }) {
    const c = this.c, st = c.state;
    if (!c.isMyTurn()) {
      this.r.setPadHover(null);
      if (st.padPrompt) c.update({ padPrompt: null });
      this.cursor = null;
      return;
    }
    const active = st.entities.get(st.combat!.activeId);
    if (!active) return;
    const foes = [...st.entities.values()].filter((e) => e.hostile && !e.dead && e.inCombat).sort((a, b) => Math.hypot(a.x - active.x, a.y - active.y) - Math.hypot(b.x - active.x, b.y - active.y));
    const allies = [...st.entities.values()].filter((e) => e.ownerUserId === st.userId && !e.dead);
    const skill = st.targeting?.skillId ? rx(c.r).skill.get(st.targeting.skillId) : undefined;
    const pool = skill?.targeting === 'ally' ? allies : foes;
    if (!this.cursor) {
      const first = pool[0] ?? active;
      this.cursor = { x: first.x, y: first.y };
    }
    // Snap between targets.
    if (pressed(B.RB) || pressed(B.LB)) {
      const at = pool.findIndex((e) => Math.hypot(e.x - this.cursor!.x, e.y - this.cursor!.y) < 0.3);
      const next = pool[(at + (pressed(B.RB) ? 1 : -1) + pool.length) % Math.max(1, pool.length)];
      if (next) this.cursor = { x: next.x, y: next.y };
    }
    // Free cursor: a metre per push, repeating while held.
    const now = performance.now();
    if (Math.hypot(s.lx, s.ly) > 0.45) {
      if (now >= this.repeatAt) {
        const d = this.r.screenDirToGround(s.lx, s.ly);
        const step = { x: Math.abs(d.x) > 0.38 ? Math.sign(d.x) : 0, y: Math.abs(d.y) > 0.38 ? Math.sign(d.y) : 0 };
        this.cursor = { x: this.cursor.x + step.x, y: this.cursor.y + step.y };
        this.repeatAt = now + (this.repeatAt === 0 ? 220 : 95);
      }
    } else this.repeatAt = 0;
    const on = [...st.entities.values()].find((e) => !e.dead && Math.hypot(e.x - this.cursor!.x, e.y - this.cursor!.y) < 0.6);
    const info = this.r.hoverAt(this.cursor, on ? { entityId: on.id } : {});
    this.r.setPadHover(info);
    const verb = skill ? `Use ${skill.name}` : on?.hostile ? 'Attack' : on ? '' : 'Move';
    const prompt = verb ? this.promptAt(verb, on?.name ?? '', this.cursor.x, this.cursor.y) : null;
    if (JSON.stringify(prompt) !== JSON.stringify(st.padPrompt)) c.update({ padPrompt: prompt });
    if (pressed(B.A)) this.act(info, 0);
    if (pressed(B.X) && foes[0]) this.act(this.r.hoverAt(foes[0], { entityId: foes[0].id }), 0);
    if (pressed(B.Y)) c.send({ t: 'end_turn' });
    // B backs out of aiming; with nothing to back out of, it flees (when no foe is near).
    if (pressed(B.B)) {
      if (st.targeting) c.update({ targeting: null });
      else c.send({ t: 'flee' });
    }
  }

  /** A button prompt placed above a spot on the map, in screen pixels (rounded so it only updates when it moves). */
  private promptAt(verb: string, name: string, x: number, y: number) {
    const p = this.r.groundToScreen(x, y);
    return { verb, name, x: Math.round(p.x), y: Math.round(p.y) };
  }

  // ---------------------------------------------------------------------------- wheels and party

  private crafting() {
    const r = this.c.state.world?.ruleset;
    return !!r && (r.crafting.enabled || r.crafting.upgrades.enabled || r.crafting.enchanting.enabled);
  }

  private actingChar() {
    const st = this.c.state;
    const id = st.combat ? st.combat.activeId : st.selectedCharId ?? st.player?.leaderId;
    return st.player?.party.find((p) => p.id === id) ?? st.player?.party[0];
  }

  private openSkills() {
    const ch = this.actingChar();
    if (!ch) return;
    const ix = rx(this.c.r);
    const items: WheelItem[] = ch.hotbar.filter((x): x is string => !!x).slice(0, 10).map((id) => {
      const sk = ix.skill.get(id);
      return { id, label: sk?.name ?? id, sub: sk ? `${sk.ap} ${this.c.r.terminology.actionPoints}` : '', icon: id, disabled: (ch.cooldowns?.[id] ?? 0) > 0 };
    });
    if (items.length) this.c.update({ wheel: { kind: 'skills', items, sel: 0 } });
  }

  private chooseWheel() {
    const c = this.c, w = c.state.wheel!;
    const item = w.items[w.sel];
    c.update({ wheel: null });
    if (!item || item.disabled) return;
    if (w.kind === 'panels') return c.update({ panel: item.id as GameClient['state']['panel'] });
    const ch = this.actingChar();
    if (!ch) return;
    const sk = rx(c.r).skill.get(item.id);
    if (sk?.targeting === 'self') return c.send({ t: 'use_skill', charId: ch.id, skillId: item.id });
    c.update({ targeting: { charId: ch.id, skillId: item.id } });
    // Aim at the nearest fitting target straight away.
    this.cursor = null;
    if (!c.state.combat) {
      const lead = c.leaderEntity();
      const foe = lead ? this.nearestFoe(lead, 12) : undefined;
      if (foe && sk?.targeting === 'enemy') {
        this.act(foe.info, 0);
      }
    }
  }

  private switchCharacter(dir: 1 | -1) {
    const st = this.c.state;
    if (!st.player || st.combat) return;
    const party = st.player.party;
    const i = party.findIndex((p) => p.id === (st.selectedCharId ?? st.player!.leaderId));
    const next = party[(i + dir + party.length) % party.length]!;
    this.c.update({ selectedCharId: next.id });
    this.c.send({ t: 'set_leader', charId: next.id });
  }
}
