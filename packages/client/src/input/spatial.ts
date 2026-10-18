/**
 * Controller navigation for windows: a focus ring moves between the controls of the front window in the
 * direction pushed (nearest control that way), A presses, X opens an item's actions (its right-click menu),
 * LB/RB switch tabs, the right stick scrolls, B goes back (as Escape does).
 */
const FOCUSABLE = [
  'button:not([disabled])', '.item', '.tab', '.quest', '.replies li', '.node', '.attr', '.offer-row',
  '.ctx button', '.loot-row', '.recipe', '.wmark.travel', 'select', 'input', 'textarea', '[data-pad]',
].join(',');

const BTN = { A: 0, B: 1, X: 2, LB: 4, RB: 5, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;

export class PadNav {
  private el: HTMLElement | null = null;
  private repeatAt = 0;

  clear() {
    if (this.el) {
      this.el.classList.remove('pad-focus');
      this.el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    }
    this.el = null;
  }

  /** The front-most open surface: a context menu, a story card, a conversation, or the newest window. */
  private root(): HTMLElement | null {
    const q = (s: string) => [...document.querySelectorAll<HTMLElement>(s)].filter((e) => e.offsetParent !== null);
    return q('.ctx').pop() ?? q('.narration').pop() ?? q('.hud .window').pop() ?? null;
  }

  private candidates(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => {
      if (e.offsetParent === null) return false;
      const r = e.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && !e.closest('.pad-skip');
    });
  }

  private focus(el: HTMLElement | null) {
    if (el === this.el) return;
    if (this.el) {
      this.el.classList.remove('pad-focus');
      this.el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      this.el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    }
    this.el = el;
    if (!el) return;
    el.classList.add('pad-focus');
    // Keep it in view inside its own scrolling box (never scroll the game itself).
    let box = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (box && !box.matches('.game, .hud, body, html')) {
      const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (r.top < b.top) box.scrollTop -= b.top - r.top + 6;
      else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 6;
    }
    // Tooltips and hover states follow the ring.
    const r = el.getBoundingClientRect();
    const at = { clientX: r.right - 4, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, ...at }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, ...at }));
  }

  private move(list: HTMLElement[], dx: number, dy: number) {
    if (!this.el) return this.focus(list[0] ?? null);
    const a = this.el.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best: HTMLElement | null = null, bs = Infinity;
    for (const e of list) {
      if (e === this.el) continue;
      const r = e.getBoundingClientRect();
      const x = r.left + r.width / 2 - ax, y = r.top + r.height / 2 - ay;
      const along = x * dx + y * dy;
      if (along <= 2) continue;
      const across = Math.abs(x * dy - y * dx);
      const s = along + across * 2.2;
      if (s < bs) {
        bs = s;
        best = e;
      }
    }
    if (best) this.focus(best);
  }

  step(down: boolean[], pressed: (i: number) => boolean, stick: { x: number; y: number }, scroll: number) {
    const root = this.root();
    if (!root) return this.clear();
    const list = this.candidates(root);
    if (!this.el || !root.contains(this.el) || !this.el.isConnected) {
      this.el?.classList.remove('pad-focus');
      this.el = null;
      // Start on the main choice (a story card's button, the first reply), else the top-left control.
      const pos = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return r.top * 3 + r.left; };
      const content = list.filter((e) => !e.matches('.close-x, .tab')).sort((a, b) => pos(a) - pos(b));
      this.focus(list.find((e) => e.matches('.narration .btn.primary, .replies li')) ?? content[0] ?? list[0] ?? null);
    }
    // Direction: d-pad presses step once; the stick (or a held d-pad) repeats.
    const now = performance.now();
    let dx = 0, dy = 0;
    if (pressed(BTN.LEFT)) dx = -1;
    else if (pressed(BTN.RIGHT)) dx = 1;
    else if (pressed(BTN.UP)) dy = -1;
    else if (pressed(BTN.DOWN)) dy = 1;
    if (dx || dy) {
      this.repeatAt = now + 320;
      return this.move(list, dx, dy);
    }
    const sx = stick.x, sy = stick.y;
    const held = down[BTN.LEFT] ? [-1, 0] : down[BTN.RIGHT] ? [1, 0] : down[BTN.UP] ? [0, -1] : down[BTN.DOWN] ? [0, 1] : Math.hypot(sx, sy) > 0.55 ? (Math.abs(sx) > Math.abs(sy) ? [Math.sign(sx), 0] : [0, Math.sign(sy)]) : null;
    if (held) {
      if (now >= this.repeatAt) {
        this.repeatAt = now + (this.repeatAt === 0 ? 260 : 130);
        this.move(list, held[0]!, held[1]!);
      }
    } else this.repeatAt = 0;
    if (Math.abs(scroll) > 0.3) {
      const box = (this.el?.closest('.scroll, .panel-body') as HTMLElement | null) ?? root.querySelector<HTMLElement>('.scroll, .panel-body');
      box?.scrollBy({ top: scroll * 14 });
    }
    if (pressed(BTN.A) && this.el) {
      if (this.el.matches('input, textarea, select')) this.el.focus();
      else this.el.click();
    }
    if (pressed(BTN.X) && this.el) {
      const r = this.el.getBoundingClientRect();
      this.el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }));
    }
    if (pressed(BTN.LB) || pressed(BTN.RB)) {
      const tabs = [...root.querySelectorAll<HTMLElement>('.tabs .tab')].filter((t) => t.offsetParent !== null && !t.classList.contains('gold'));
      const at = tabs.findIndex((t) => t.classList.contains('on'));
      const next = tabs[(at + (pressed(BTN.RB) ? 1 : -1) + tabs.length) % Math.max(1, tabs.length)];
      next?.click();
    }
    if (pressed(BTN.B)) {
      if (document.activeElement && (document.activeElement as HTMLElement).blur) (document.activeElement as HTMLElement).blur();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  }
}
