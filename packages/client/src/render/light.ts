/**
 * Characters and objects are painted studio-lit on nothing; this lights them like the place they stand in. The
 * place's light (measured from its painting when it was made) sets the colour from above; the painting just around
 * their feet sets how bright it is there and the colour bounced up from the ground; and a soft contact shadow in the
 * place's own shadow colour sets them down on it. A figure is tinted top to bottom (key light to ground bounce) with
 * a faint wash of the light from the upper left, as painted 2.5D games do it (Broken Age's gradient tint, Pillars of
 * Eternity's lights matched to each scene).
 */
import type { ZoneLook } from '@gd/shared';
import { hexToRgb, type RGB } from './color';

/** How a figure standing at one spot is lit. */
export interface FigureLight {
  /** Multiply colours (CSS) at the top of the figure and at its feet. */
  top: string;
  bottom: string;
  /** The light's wash on the lit side (CSS, with alpha). */
  wash: string;
  /** The contact shadow's colour (CSS rgb triple) and strength. */
  shadow: string;
  shadowAlpha: number;
}

const luma = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
/** A colour's hue at full brightness (its strongest channel at 1). */
const hue = (c: RGB): RGB => {
  const m = Math.max(1, ...c);
  return [c[0] / m, c[1] / m, c[2] / m];
};
const css = (c: RGB, k: number, toward: number) => `rgb(${c.map((v) => Math.round(Math.min(255, (1 + (v - 1) * toward) * k * 255))).join(',')})`;

/** A painting's light around each point: a tiny copy of it, blurred over a couple of metres. */
export class PlaceLight {
  private key = '';
  private map: Float32Array | null = null;
  private mw = 0;
  private mh = 0;
  private k = 1;
  private ox = 0;
  private oy = 0;
  private look: { level: number; key: RGB; shade: RGB } = { level: 0.4, key: [255, 240, 220], shade: [20, 20, 28] };

  /** Use this place's painting (`ox`, `oy`: where the picture's corner sits, picture px). */
  update(id: string, look: ZoneLook, img: HTMLImageElement, x0: number, y0: number) {
    if (this.key === id) return;
    this.key = id;
    const p = look.painted;
    this.look = p
      ? { level: p.level, key: hexToRgb(p.light), shade: hexToRgb(p.shade) }
      : { level: look.ambient * 0.55, key: hexToRgb(look.lightColor), shade: hexToRgb(look.fogColor) };
    this.ox = x0;
    this.oy = y0;
    // One sample per 24 picture px (under a metre across), then a box blur of two samples each way.
    this.k = 24;
    const w = (this.mw = Math.max(1, Math.ceil(img.naturalWidth / this.k))), h = (this.mh = Math.max(1, Math.ceil(img.naturalHeight / this.k)));
    try {
      const c = document.createElement('canvas');
      [c.width, c.height] = [w, h];
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      const blur = new Float32Array(w * h * 3);
      const R = 2;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let n = 0;
          const s = [0, 0, 0];
          for (let j = Math.max(0, y - R); j <= Math.min(h - 1, y + R); j++)
            for (let i = Math.max(0, x - R); i <= Math.min(w - 1, x + R); i++, n++) for (let ch = 0; ch < 3; ch++) s[ch]! += d[(j * w + i) * 4 + ch]!;
          for (let ch = 0; ch < 3; ch++) blur[(y * w + x) * 3 + ch] = s[ch]! / n;
        }
      this.map = blur;
    } catch {
      this.map = null;
    }
  }

  /** The painting's colour around a point (picture px), or the place's light where it has none. */
  private local(x: number, y: number): RGB {
    const m = this.map;
    if (!m) return this.look.key.map((v) => v * this.look.level * 1.6) as RGB;
    const i = Math.max(0, Math.min(this.mw - 1, Math.floor((x - this.ox) / this.k))), j = Math.max(0, Math.min(this.mh - 1, Math.floor((y - this.oy) / this.k)));
    const o = (j * this.mw + i) * 3;
    return [m[o]!, m[o + 1]!, m[o + 2]!];
  }

  /** How a figure whose feet are at this picture point is lit. */
  at(x: number, y: number): FigureLight {
    const L = this.local(x, y), { level, key, shade } = this.look;
    // Brightness from the ground around them (mostly) and the place as a whole: dark places dim figures, but they
    // always stay readable; daylight leaves them as painted.
    const lvl = luma(L) * 0.6 + level * 0.4;
    const b = Math.max(0.62, Math.min(1, 0.5 + lvl * 1.05));
    const k = hue(key), ground = hue(L);
    return {
      top: css(k, b, 0.35),
      bottom: css(ground, b * 0.84, 0.45),
      wash: `rgba(${key.join(',')},${(0.06 + level * 0.12).toFixed(3)})`,
      shadow: shade.map((v) => Math.round(v * 0.35)).join(','),
      shadowAlpha: 0.3 + Math.min(1, lvl) * 0.3,
    };
  }
}
