/**
 * World theming. The layout never changes; each world restyles it:
 * - colours and typefaces from the world's palette and genre,
 * - panel material and corner ornaments from the ruleset's `ui`,
 * - colour grading of the game view (tint, saturation, contrast, vignette, grain).
 */
import type { Ruleset } from '@gd/shared';

type Hsl = { h: number; s: number; l: number };

function hexToHsl(hex: string): Hsl | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

const hsl = (c: Hsl, a = 1) => `hsla(${c.h.toFixed(0)}, ${(c.s * 100).toFixed(0)}%, ${(c.l * 100).toFixed(0)}%, ${a})`;
const clampL = (c: Hsl, lo: number, hi: number, maxS = 1): Hsl => ({ h: c.h, s: Math.min(maxS, c.s), l: Math.max(lo, Math.min(hi, c.l)) });

interface Fonts {
  display: string;
  serif: string;
}

/** Typefaces by genre keywords (all loaded in index.html). */
function fontsFor(text: string): Fonts {
  const t = text.toLowerCase();
  if (/sci|space|cyber|star|android|robot|galac|future|mech/.test(t)) return { display: "'Exo 2', 'Inter', sans-serif", serif: "'Inter', system-ui, sans-serif" };
  if (/horror|gothic|dread|eldritch|haunt|cosmic|grim|plague/.test(t)) return { display: "'IM Fell English SC', Georgia, serif", serif: "'IM Fell English', Georgia, serif" };
  if (/cozy|whims|fairy|pastoral|cute|storybook|farm|tea/.test(t)) return { display: "'Fraunces', Georgia, serif", serif: "'Lora', Georgia, serif" };
  if (/modern|noir|urban|detective|city|contemporary|wasteland|post-apoc/.test(t)) return { display: "'Oswald', 'Inter', sans-serif", serif: "'Lora', Georgia, serif" };
  return { display: "'Cinzel', 'Trajan Pro', Georgia, serif", serif: "'EB Garamond', Georgia, serif" };
}

const VARS = [
  '--gold', '--gold-2', '--accent', '--accent-glow', '--line', '--line-strong', '--panel', '--panel-solid', '--panel-2', '--bg', '--display', '--serif',
  '--grade-tint', '--grade-tint-a', '--grade-filter', '--grade-vignette', '--grade-grain', '--btn-primary-a', '--btn-primary-b', '--btn-primary-edge',
];

export interface ThemeSource {
  concept: { palette: { primary: string; secondary: string; accent: string; ui: string }; genre: string; tone: string; artStyle?: string };
  ruleset?: Pick<Ruleset, 'ui'> | null;
}

/** Apply a world's look to the document; returns a function that restores the default look. */
export function applyWorldTheme(world: ThemeSource | null | undefined): () => void {
  const el = document.documentElement;
  const root = el.style;
  const clear = () => {
    VARS.forEach((v) => root.removeProperty(v));
    delete el.dataset.material;
    delete el.dataset.ornament;
  };
  if (!world) return clear;
  const p = world.concept.palette;
  const primary = hexToHsl(p.primary);
  const accent = hexToHsl(p.accent);
  const ui = hexToHsl(p.ui) ?? hexToHsl(p.secondary);
  if (primary) {
    // Titles and lines must stay readable on dark panels whatever the palette says.
    const title = clampL(primary, 0.58, 0.72, 0.75);
    root.setProperty('--gold', hsl(title));
    root.setProperty('--gold-2', hsl({ ...title, l: Math.min(0.86, title.l + 0.14) }));
    root.setProperty('--line', hsl(title, 0.28));
    root.setProperty('--line-strong', hsl(title, 0.6));
    root.setProperty('--btn-primary-a', hsl({ ...title, l: 0.55, s: Math.min(0.6, title.s) }));
    root.setProperty('--btn-primary-b', hsl({ ...title, l: 0.33, s: Math.min(0.6, title.s) }));
    root.setProperty('--btn-primary-edge', hsl({ ...title, l: 0.7 }));
  }
  if (accent) {
    const a = clampL(accent, 0.5, 0.66, 0.85);
    root.setProperty('--accent', hsl(a));
    root.setProperty('--accent-glow', hsl(a, 0.28));
  }
  const material = world.ruleset?.ui.material ?? 'parchment';
  if (ui) {
    // Light materials still render as dark panels (readability); they just warm or cool the base.
    const lo = material === 'glass' || material === 'neon' ? 0.06 : 0.08;
    const base = clampL(ui, lo, lo + 0.03, material === 'neon' ? 0.5 : 0.35);
    const alpha = material === 'glass' ? 0.78 : 0.94;
    root.setProperty('--panel', hsl(base, alpha));
    root.setProperty('--panel-solid', hsl(base));
    root.setProperty('--panel-2', hsl({ ...base, l: base.l + 0.05 }, 0.92));
    root.setProperty('--bg', hsl({ ...base, l: 0.05 }));
  }
  const f = fontsFor(`${world.concept.genre} ${world.concept.tone} ${world.concept.artStyle ?? ''}`);
  root.setProperty('--display', f.display);
  root.setProperty('--serif', f.serif);
  if (world.ruleset) {
    const u = world.ruleset.ui;
    el.dataset.material = u.material;
    el.dataset.ornament = u.ornament;
    const g = u.grading;
    const tint = hexToHsl(g.tint);
    // White means "no tint"; the strength grows with how coloured the tint is.
    root.setProperty('--grade-tint', g.tint);
    root.setProperty('--grade-tint-a', tint ? String(Math.min(0.35, tint.s * 0.3 * (1 - Math.abs(tint.l - 0.5)))) : '0');
    root.setProperty('--grade-filter', `saturate(${clamp(g.saturation, 0.4, 1.6)}) contrast(${clamp(g.contrast, 0.8, 1.3)})`);
    root.setProperty('--grade-vignette', String(clamp(g.vignette, 0, 0.8)));
    root.setProperty('--grade-grain', String(clamp(g.grain, 0, 0.12)));
  }
  return clear;
}

const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo);
