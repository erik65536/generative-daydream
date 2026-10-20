/**
 * The place's mist, in WebGL at half the view's size and drawn onto the game view as an image, twice a frame:
 *
 * - the ground pass, right after the painting: everything past the painting's edge, so there is never a border.
 *   Figures are drawn after it, so people walking out to a way at the edge stay crisp.
 * - the air pass, over the figures: unexplored ground (fog of war), a dim veil over ground out of sight, and a veil
 *   inside the edge, solid at the edge itself and thinning over a couple of metres (clear around the party), so the
 *   painting sinks softly into the mist past it.
 *
 * The view's light (night, gloom, the party's light) falls on both alike, after them.
 *
 * Both are the same drifting air: two layers of the place's tileable mist scrolling at different speeds (the nearer
 * one moving a little faster with the camera, for depth). Where the fog thins, the mist's own density erodes its
 * edge, so it breaks into wisps rather than a blur. The tile's brightness is its density (see docs/world-art.md); a
 * world without one gets a generated noise tile.
 */
import { ISO_X, ISO_Y } from '@gd/shared';
import type { RGB } from './color';

/** Party figures the edge veil clears around. */
const PARTY = 6;

const VERT = `attribute vec2 a; varying vec2 v; void main() { v = vec2(a.x, -a.y) * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `precision mediump float;
varying vec2 v;
uniform vec2 u_view, u_cam, u_fogSize;
uniform float u_zoom, u_t, u_hasFog, u_feather, u_tile, u_ground;
uniform vec4 u_rect;
uniform vec3 u_base, u_tint;
uniform sampler2D u_fog, u_mist;
/** The party's feet (picture px): the veil along the edge clears around them, so they always read. */
uniform vec2 u_party[${PARTY}];
const vec2 ISO = vec2(${ISO_X.toFixed(1)}, ${ISO_Y.toFixed(1)});
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
/** Coverage m (0 clear .. 1 solid) eroded by the mist's density n: wisps where it thins. */
float erode(float m, float n) { return smoothstep(0.0, 1.0, (m - 0.5) * 2.0 + 0.5 + (n - 0.5) * 1.0); }
void main() {
  vec2 w = (v * u_view - u_view * 0.5) / u_zoom + u_cam;
  vec2 g = vec2(w.y / ISO.y + w.x / ISO.x, w.y / ISO.y - w.x / ISO.x) * 0.5;
  // Two layers of drifting mist; the nearer, larger one moves a little faster with the camera.
  vec3 m1 = texture2D(u_mist, w / u_tile + u_t * vec2(0.007, 0.003)).rgb;
  vec3 m2 = texture2D(u_mist, (w + u_cam * 0.18) / (u_tile * 1.7) + u_t * vec2(-0.004, 0.0035) + 0.37).rgb;
  float n = (luma(m1) + luma(m2)) * 0.5;
  vec3 col = mix(u_base, (m1 + m2) * 0.5 * u_tint, clamp(n * 1.1, 0.0, 1.0) * 0.8);
  // Fog of war: r = unexplored, a = remembered but out of sight (a dim veil). A few taps soften the metre grid.
  float unseen = 0.0, dim = 0.0;
  if (u_hasFog > 0.5) {
    vec2 uv = (g + 0.5) / u_fogSize, o = 0.8 / u_fogSize;
    vec4 f = (2.0 * texture2D(u_fog, uv) + texture2D(u_fog, uv + vec2(o.x, 0.0)) + texture2D(u_fog, uv - vec2(o.x, 0.0)) + texture2D(u_fog, uv + vec2(0.0, o.y)) + texture2D(u_fog, uv - vec2(0.0, o.y))) / 6.0;
    unseen = f.r;
    dim = f.a;
  }
  // Distance inside the painting's edge (px across; up and down the picture counts double).
  vec2 d2 = min(w - u_rect.xy, u_rect.zw - w);
  float d = min(d2.x, d2.y * 2.0);
  // The passes overlap by a few screen pixels at the edge: the ground solid to just inside it, the air fading in
  // over it, so nothing shows through between them.
  float px = min(d2.x, d2.y) * u_zoom, seam = smoothstep(-4.0, 4.0, px);
  if (u_ground > 0.5) {
    if (px >= 4.0) discard;
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  if (seam <= 0.0) discard;
  // The veil inside the edge: solid over the last half metre (a painting's own outer rows are often darkened, as if
  // closed off), thinning over a couple of metres, where the ways out are.
  float e = 1.0 - smoothstep(0.0, u_feather * 0.45, d), rim = 1.0 - smoothstep(0.0, u_feather * 0.1, d);
  for (int i = 0; i < ${PARTY}; i++) {
    vec2 q = (w - u_party[i] - vec2(0.0, -40.0)) / vec2(42.0, 64.0);
    float clear = smoothstep(0.6, 1.0, length(q));
    e *= clear;
    rim *= clear;
  }
  float cover = max(erode(unseen, n), max(rim, e * e * (0.5 + 0.35 * n)));
  float veil = dim * (1.0 - cover);
  gl_FragColor = vec4(col * cover + u_base * veil, cover + veil) * seam;
}`;

export interface MistFrame {
  /** View size (CSS px), the camera's centre (picture px) and zoom. */
  W: number;
  H: number;
  camX: number;
  camY: number;
  zoom: number;
  t: number;
  /** Fog of war per square metre (two bytes each: unexplored, remembered-but-unseen), or null for none. */
  fog: { data: Uint8Array; w: number; h: number } | null;
  /** The painting's rectangle in picture px. */
  rect: [number, number, number, number];
  /** Mist where it is thin (its shadow colour) and the light its wisps take, 0..255. */
  base: RGB;
  tint: RGB;
  /** The mist tile, once loaded (null: the generated one). */
  tile: HTMLImageElement | null;
  /** Where the party's figures stand (picture px). */
  party: { x: number; y: number }[];
}

export class Mist {
  readonly canvas = document.createElement('canvas');
  private gl: WebGLRenderingContext | null;
  private prog: WebGLProgram | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private fogTex: WebGLTexture | null = null;
  private mistTex: WebGLTexture | null = null;
  private mistOf: HTMLImageElement | 'noise' | null = null;

  constructor() {
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (this.gl) this.setup(this.gl);
  }

  /** WebGL works (otherwise the renderer falls back to plain fog). */
  get ok() {
    return !!this.prog;
  }

  private setup(gl: WebGLRenderingContext) {
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[mist]', gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return;
    this.prog = p;
    gl.useProgram(p);
    for (const n of ['u_view', 'u_cam', 'u_fogSize', 'u_zoom', 'u_t', 'u_hasFog', 'u_feather', 'u_tile', 'u_rect', 'u_ground', 'u_base', 'u_tint', 'u_fog', 'u_mist', 'u_party']) this.loc[n] = gl.getUniformLocation(p, n);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, 'a');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(this.loc.u_fog!, 0);
    gl.uniform1i(this.loc.u_mist!, 1);
    this.fogTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.mistTex = gl.createTexture();
  }

  private bindTile(gl: WebGLRenderingContext, tile: HTMLImageElement | null) {
    const want = tile ?? 'noise';
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mistTex);
    if (this.mistOf === want) return;
    this.mistOf = want;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, tile ?? noiseTile());
    // Tiles are powers of two (1024, the generated 256), so they repeat and have mipmaps.
    gl.generateMipmap(gl.TEXTURE_2D);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT]] as const) gl.texParameteri(gl.TEXTURE_2D, k, v);
  }

  /** Draw one pass of the mist for this frame into `canvas` (half the view's size: the mist is soft). */
  render(f: MistFrame, pass: 'ground' | 'air'): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || !this.prog) return null;
    const cw = Math.max(1, Math.ceil(f.W / 2)), ch = Math.max(1, Math.ceil(f.H / 2));
    if (this.canvas.width !== cw || this.canvas.height !== ch) [this.canvas.width, this.canvas.height] = [cw, ch];
    gl.viewport(0, 0, cw, ch);
    const L = this.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    if (f.fog) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, f.fog.w, f.fog.h, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, f.fog.data);
      gl.uniform2f(L.u_fogSize!, f.fog.w, f.fog.h);
    }
    gl.uniform1f(L.u_hasFog!, f.fog ? 1 : 0);
    this.bindTile(gl, f.tile);
    gl.uniform2f(L.u_view!, f.W, f.H);
    gl.uniform2f(L.u_cam!, f.camX, f.camY);
    gl.uniform1f(L.u_zoom!, f.zoom);
    gl.uniform1f(L.u_t!, f.t);
    // The veil inside the edge spans about two metres; a tile spans 16 m.
    gl.uniform1f(L.u_feather!, 5 * ISO_X);
    gl.uniform1f(L.u_tile!, f.tile ? 1024 : 640);
    gl.uniform4f(L.u_rect!, ...f.rect);
    const party = new Float32Array(PARTY * 2).fill(-1e6);
    f.party.slice(0, PARTY).forEach((p, i) => party.set([p.x, p.y], i * 2));
    gl.uniform2fv(L.u_party!, party);
    gl.uniform1f(L.u_ground!, pass === 'ground' ? 1 : 0);
    gl.uniform3f(L.u_base!, f.base[0] / 255, f.base[1] / 255, f.base[2] / 255);
    gl.uniform3f(L.u_tint!, f.tint[0] / 255, f.tint[1] / 255, f.tint[2] / 255);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

let noise: HTMLCanvasElement | null = null;
/** A tileable fractal noise tile (256 px, grey), for places without a painted mist. */
function noiseTile(): HTMLCanvasElement {
  if (noise) return noise;
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!, img = g.createImageData(S, S);
  const hash = (x: number, y: number, o: number) => {
    const h = Math.sin(x * 127.1 + y * 311.7 + o * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let v = 0, amp = 0.5;
      for (let o = 0, n = 4; o < 5; o++, n *= 2, amp *= 0.5) {
        // Lattice of n×n cells wrapping at the tile's edge, smoothly interpolated.
        const fx = (x / S) * n, fy = (y / S) * n, x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const h = (i: number, j: number) => hash(i % n, j % n, o);
        v += amp * ((h(x0, y0) * (1 - sx) + h(x0 + 1, y0) * sx) * (1 - sy) + (h(x0, y0 + 1) * (1 - sx) + h(x0 + 1, y0 + 1) * sx) * sy);
      }
      const k = (y * S + x) * 4, b = Math.max(0, Math.min(255, (v - 0.2) * 420));
      img.data[k] = img.data[k + 1] = img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return (noise = c);
}
