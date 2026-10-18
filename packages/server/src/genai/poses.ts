/**
 * Pose skeletons for animation frames. Qwen Image Edit takes the approved character (image 1) and an
 * OpenPose-style stick figure (image 2) and repaints the character in that pose — the role ControlNet played
 * for Stable Diffusion, without an extra model. The skeleton is drawn to the character's own framing, so every
 * frame comes out at the same size and place, and the frames are aligned again after cutting out.
 */
import sharp from 'sharp';
import { genai } from './service';
import { processSprite, referenceFrame, type ProcessedImage } from './matte';

/** OpenPose-18 keypoints: nose, neck, R shoulder/elbow/wrist, L shoulder/elbow/wrist, R hip/knee/ankle, L hip/knee/ankle, eyes, ears. */
type Pt = [number, number] | null;
export type Skeleton = Pt[];

const LIMBS: [number, number][] = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
const COLORS = ['#ff0000', '#ff5500', '#ffaa00', '#ffff00', '#aaff00', '#55ff00', '#00ff00', '#00ff55', '#00ffaa', '#00ffff', '#00aaff', '#0055ff', '#0000ff', '#5500ff', '#aa00ff', '#ff00ff', '#ff00aa', '#ff0055'];

/** One leg: thigh angle from vertical (degrees, + = forward) and knee bend. */
interface LegPose { thigh: number; knee: number }
/** One arm: upper-arm angle from hanging straight down (degrees, + = forward, 180 = straight up) and elbow bend. */
interface ArmPose { upper: number; elbow: number }
/** A whole-body pose. Near = the figure's left side, toward the viewer when facing left. */
interface Pose { legNear: LegPose; legFar: LegPose; armNear: ArmPose; armFar: ArmPose; rise?: number; lean?: number }

/**
 * A pose as an OpenPose skeleton, for a figure facing left in a slight three-quarter view, with height 1 (top of
 * head 0, soles 1) and its centre line at x = 0. `lean` tips the upper body forward (+) or back; `rise` lifts it.
 */
export function poseSkeleton(pose: Pose): Skeleton {
  const thigh = 0.235, shin = 0.235, upper = 0.15, fore = 0.14;
  const fwd = -1; // facing left: forward is -x
  const depth = 0.035; // the far side sits a little behind (three-quarter view)
  const rise = pose.rise ?? 0, lean = pose.lean ?? 0;
  const hipY = 0.5 - rise;
  // Upper body: points above the hips shift forward with the lean, more the higher they are.
  const U = (x: number, y: number): [number, number] => {
    const yy = y - rise;
    return [x + fwd * lean * (hipY - yy) * 1.4, yy];
  };
  const hipL: [number, number] = [-0.012, hipY], hipR: [number, number] = [0.012 + depth, hipY - 0.004];
  const leg = (hip: [number, number], p: LegPose): [[number, number], [number, number]] => {
    const t = (p.thigh * Math.PI) / 180, s = ((p.thigh - p.knee) * Math.PI) / 180;
    const knee: [number, number] = [hip[0] + fwd * Math.sin(t) * thigh, hip[1] + Math.cos(t) * thigh];
    return [knee, [knee[0] + fwd * Math.sin(s) * shin, knee[1] + Math.cos(s) * shin]];
  };
  const arm = (sho: [number, number], p: ArmPose): [[number, number], [number, number]] => {
    const a = (p.upper * Math.PI) / 180, b = ((p.upper + p.elbow) * Math.PI) / 180;
    const elb: [number, number] = [sho[0] + fwd * Math.sin(a) * upper, sho[1] + Math.cos(a) * upper];
    return [elb, [elb[0] + fwd * Math.sin(b) * fore, elb[1] + Math.cos(b) * fore]];
  };
  const [kneeL, ankL] = leg(hipL, pose.legNear), [kneeR, ankR] = leg(hipR, pose.legFar);
  const shoL = U(-0.05, 0.185), shoR = U(0.06 + depth, 0.18);
  const [elbL, wriL] = arm(shoL, pose.armNear), [elbR, wriR] = arm(shoR, pose.armFar);
  return [U(-0.045, 0.075), U(0.005, 0.155), shoR, elbR, wriR, shoL, elbL, wriL, hipR, kneeR, ankR, hipL, kneeL, ankL, U(-0.012, 0.058), U(-0.035, 0.06), null, U(0.02, 0.07)];
}

/**
 * A walk cycle in eight frames (contact, down, passing, up, then the same with the other leg leading).
 * Values follow the classic animation keys: the body dips just after contact and rises as the leg passes.
 */
const WALK_KEYS: { lead: LegPose; trail: LegPose; rise: number }[] = [
  { lead: { thigh: 24, knee: 4 }, trail: { thigh: -20, knee: 14 }, rise: 0 },
  { lead: { thigh: 16, knee: 18 }, trail: { thigh: -14, knee: 40 }, rise: -0.012 },
  { lead: { thigh: 2, knee: 8 }, trail: { thigh: 8, knee: 62 }, rise: 0.004 },
  { lead: { thigh: -12, knee: 4 }, trail: { thigh: 22, knee: 30 }, rise: 0.012 },
];
export const WALK_FRAMES = 8;

/** Walk frame `i` (0..7): frames 0-3 lead with the near leg, 4-7 with the far one; arms swing against the legs. */
export function walkSkeleton(i: number): Skeleton {
  const k = WALK_KEYS[i % 4]!;
  const nearLeads = i < 4;
  const legNear = nearLeads ? k.lead : k.trail, legFar = nearLeads ? k.trail : k.lead;
  const swing = (l: LegPose): ArmPose => ({ upper: -l.thigh * 0.85, elbow: 18 + Math.max(0, l.thigh) * 0.4 });
  return poseSkeleton({ legNear, legFar, armNear: swing(legNear), armFar: swing(legFar), rise: k.rise });
}

/** Attacks: four frames (ready, wind-up, strike, follow-through), painted from edit instructions. */
export const STRIKE_FRAMES = 4;

/**
 * Draw a skeleton as an OpenPose-style image (coloured limbs on black) at a figure height and foot line, so it
 * overlays the character in a reference frame of the same size.
 */
export async function drawSkeleton(sk: Skeleton, width: number, height: number, figure: { height: number; footY: number; centerX: number }): Promise<Buffer> {
  const P = (p: [number, number]) => [figure.centerX + p[0] * figure.height, figure.footY - (1 - p[1]) * figure.height] as const;
  const w = Math.max(3, Math.round(figure.height * 0.022));
  const parts: string[] = [];
  // Far limbs first, so the near ones read on top.
  const order = LIMBS.map((l, i) => ({ l, i })).sort((a, b) => (isFar(b.l) ? 1 : 0) - (isFar(a.l) ? 1 : 0));
  for (const { l, i } of order) {
    const a = sk[l[0]], b = sk[l[1]];
    if (!a || !b) continue;
    const [x1, y1] = P(a), [x2, y2] = P(b);
    parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${COLORS[i % COLORS.length]}" stroke-width="${w}" stroke-linecap="round" opacity="0.75"/>`);
  }
  sk.forEach((p, i) => {
    if (!p) return;
    const [x, y] = P(p);
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(w * 0.9).toFixed(1)}" fill="${COLORS[i % COLORS.length]}"/>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/>${parts.join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const FAR = new Set([2, 3, 4, 8, 9, 10, 14, 16]);
const isFar = (l: [number, number]) => FAR.has(l[0]) && FAR.has(l[1]) || (l[0] === 1 && FAR.has(l[1]));

/**
 * Put cut-out frames on one canvas: the same scale (each frame's figure height relative to the standing pose),
 * feet on one line, and the head and torso (which move least in a walk) on one vertical axis.
 */
export async function alignFrames(frames: { png: Buffer; rel: number }[], baseHeight: number): Promise<{ frames: Buffer[]; width: number; height: number }> {
  const scaled = await Promise.all(frames.map(async (f) => {
    const h = Math.round(baseHeight * f.rel);
    const png = await sharp(f.png).resize({ height: h }).png().toBuffer();
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // Centre of the upper body: alpha-weighted mean x over the top 45% of rows.
    let sx = 0, n = 0;
    for (let y = 0; y < Math.round(info.height * 0.45); y++)
      for (let x = 0; x < info.width; x++) {
        const a = data[(y * info.width + x) * 4 + 3]!;
        if (a > 64) { sx += x; n++; }
      }
    return { png, w: info.width, h: info.height, cx: n ? sx / n : info.width / 2 };
  }));
  const left = Math.max(...scaled.map((s) => s.cx)), right = Math.max(...scaled.map((s) => s.w - s.cx));
  const W = Math.ceil(left + right) + 4, H = Math.max(...scaled.map((s) => s.h)) + 2;
  const out = await Promise.all(scaled.map((s) =>
    sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: s.png, left: Math.round(left - s.cx) + 2, top: H - s.h - 1 }])
      .png()
      .toBuffer(),
  ));
  return { frames: out, width: W, height: H };
}

/**
 * Share of the image covered by skeleton colours (fully saturated, bright pure hues), to catch a frame where the
 * model painted the stick figure onto the character instead of only following it.
 */
export async function skeletonLeak(png: Buffer, ignore?: [number, number, number]): Promise<number> {
  const { data, info } = await sharp(png).resize(256, 256, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let hits = 0;
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) {
    const r = data[i * 3]!, g = data[i * 3 + 1]!, b = data[i * 3 + 2]!;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (ignore && Math.abs(r - ignore[0]) + Math.abs(g - ignore[1]) + Math.abs(b - ignore[2]) < 90) continue;
    if (mx > 225 && mn < 40 && (mx - mn) / mx > 0.85) hits++;
  }
  return hits / n;
}

/** Sheet layout: 4 x 2 cells, each framed like a single character generation. */
const CELL_W = 416, CELL_H = 608;

/**
 * Animation strips. A walk is painted as one sheet guided by pose skeletons (consistent props, facing and detail
 * across frames). Attack poses are too far from standing for a sheet, and Qwen Edit follows stick figures poorly
 * for them, so each attack frame is painted on its own from the character and a plain edit instruction.
 */
const STRIPS = {
  walk: { frames: WALK_FRAMES, sheet: true, cols: 4, rows: 2, skeleton: walkSkeleton, names: [] as string[] },
  strike: {
    frames: STRIKE_FRAMES, sheet: false, cols: 1, rows: 1, skeleton: walkSkeleton,
    // Attack keys as edit instructions (Qwen Edit follows these far better than a stick figure for dramatic poses).
    names: [
      'in a fighting stance facing left: knees bent, feet apart, weapon (or claws, or casting hand) raised and ready in front of the body',
      'winding up to strike toward the left: the weapon arm drawn far back and up behind the shoulder, the body twisted and leaning back, weight on the back foot',
      'striking toward the left at full extension: a deep forward lunge with the front knee bent, the weapon arm driven all the way forward (a ranged or magic attacker looses the shot or spell straight ahead)',
      'following through after the blow toward the left: the weapon arm swept down and across past the body, still leaning forward in the lunge',
    ],
  },
} as const;
export type StripKind = keyof typeof STRIPS;

export function paintWalkStrip(sprite: Buffer, description: string, seed: number): Promise<ProcessedImage> {
  return paintPoseStrip('walk', sprite, description, seed);
}

/** Generate until no skeleton was painted in (pixel check, then the art checker); returns the last try and whether it is clean. */
async function paintClean(req: { prompt: string; width: number; height: number; references: Buffer[] }, seed: number, bg: [number, number, number]): Promise<{ raw: Buffer; clean: boolean }> {
  let raw: Buffer = Buffer.alloc(0);
  for (let attempt = 0; attempt < 3; attempt++) {
    raw = await genai().image('image.sprite', { ...req, seed: seed + attempt * 7919, transparent: true });
    if ((await skeletonLeak(raw, bg)) < 0.0002 && !(await skeletonDrawn(raw))) return { raw, clean: true };
  }
  return { raw, clean: false };
}

/**
 * Paint an animation strip from pose skeletons, key out its background, cut it into frames, clean them, scale
 * them to a common height and align them. `figureRatio` is the frames' height relative to the reference framing.
 */
export async function paintPoseStrip(kind: StripKind, sprite: Buffer, description: string, seed: number): Promise<ProcessedImage> {
  const spec = STRIPS[kind];
  // Painted on a flat colour far from every colour of the character, so it can be keyed out exactly —
  // including the gaps between limbs, and without eating white shirts or grey suits.
  const bg = await contrastingBackground(sprite);
  const problems: string[] = [];
  const cellsRaw: Buffer[] = [];
  let ratioRef = 0.8;
  const keep = 'Keep everything else the same as picture 1: the same face, hair, clothing, colours, gear (held in the same hand), proportions, art style and size, full body visible, on the same flat plain background colour as picture 1. The skeleton is only a guide: draw no lines, dots or coloured sticks.';
  if (spec.sheet) {
    const reference = await referenceFrame(sprite, CELL_W, CELL_H, bg.hex);
    ratioRef = reference.figureRatio;
    const cellFig = { height: CELL_H * reference.figureRatio, footY: CELL_H * 0.92, centerX: CELL_W / 2 };
    const cells = await Promise.all(Array.from({ length: spec.frames }, (_, i) => drawSkeleton(spec.skeleton(i), CELL_W, CELL_H, cellFig)));
    const sheet = await sharp({ create: { width: CELL_W * spec.cols, height: CELL_H * spec.rows, channels: 3, background: '#000' } })
      .composite(cells.map((c, i) => ({ input: c, left: (i % spec.cols) * CELL_W, top: Math.floor(i / spec.cols) * CELL_H })))
      .png()
      .toBuffer();
    const { raw, clean } = await paintClean({
      prompt: `Picture 1 shows a game character: ${description}. Picture 2 is a sheet of eight pose skeletons (coloured OpenPose stick figures on black) in a grid of 4 columns and 2 rows: the frames of a walk cycle toward the left. Draw a walk-cycle sprite sheet: the character from picture 1 eight times, one in each cell of the same grid, each in exactly the pose of the skeleton in that cell. Every copy is the same character with the same face, hair, clothing, colours, gear (held in the same hand every time), proportions, art style and size, full body visible, on one flat plain background of exactly the same colour as picture 1's background, with nothing between the cells. The skeletons are only a guide: draw no lines, dots or coloured sticks.`,
      width: CELL_W * spec.cols,
      height: CELL_H * spec.rows,
      references: [reference.png, sheet],
    }, seed, bg.rgb);
    if (!clean) problems.push('pose skeleton lines painted into the frames');
    const meta = await sharp(raw).metadata();
    const cw = Math.floor((meta.width ?? CELL_W * spec.cols) / spec.cols), ch = Math.floor((meta.height ?? CELL_H * spec.rows) / spec.rows);
    for (let i = 0; i < spec.frames; i++) cellsRaw.push(await sharp(raw).extract({ left: (i % spec.cols) * cw, top: Math.floor(i / spec.cols) * ch, width: cw, height: ch }).png().toBuffer());
  } else {
    const FW = 832, FH = 1216;
    const reference = await referenceFrame(sprite, FW, FH, bg.hex);
    ratioRef = reference.figureRatio;
    for (let i = 0; i < spec.frames; i++) {
      const { raw, clean } = await paintClean({
        prompt: `This picture shows a game character: ${description}. Change only the pose: show the same character ${spec.names[i]}, using the weapon, claws or power they already carry in the original — add no new weapon or object (someone holding no weapon strikes with a fist, keeping whatever they hold in the same hand). ${keep.replace(/picture 1/g, 'the original').replace(' The skeleton is only a guide: draw no lines, dots or coloured sticks.', '')}`,
        width: FW,
        height: FH,
        references: [reference.png],
      }, seed + i * 31, bg.rgb);
      if (!clean && !problems.length) problems.push('pose skeleton lines painted into the frames');
      cellsRaw.push(raw);
    }
  }
  const cut: { png: Buffer; ratio: number }[] = [];
  for (const raw of cellsRaw) {
    const img = await processSprite(await keyOut(raw, bg.rgb), 384);
    for (const p of img.problems) if (!problems.includes(p)) problems.push(p);
    cut.push({ png: img.png, ratio: img.figureRatio ?? ratioRef });
  }
  // Frames share one scale (heights differ only by the pose: a step's dip, an arm raised overhead).
  const ratios = cut.map((c) => c.ratio).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)]!;
  const aligned = await alignFrames(cut.map((c) => ({ png: c.png, rel: Math.max(0.8, Math.min(1.25, c.ratio / median)) })), 256);
  const strip = await sharp({ create: { width: aligned.width * spec.frames, height: aligned.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(aligned.frames.map((f, i) => ({ input: f, left: i * aligned.width, top: 0 })))
    .png()
    .toBuffer();
  return { png: strip, width: aligned.width * spec.frames, height: aligned.height, anchorY: 0.99, figureRatio: median, problems, frames: spec.frames };
}

/** One frame of a walk strip (for checking it like a single sprite). */
export async function stripFrame(strip: Buffer, frames: number, i: number): Promise<Buffer> {
  const m = await sharp(strip).metadata();
  const fw = Math.floor((m.width ?? 0) / frames);
  return sharp(strip).extract({ left: fw * i, top: 0, width: fw, height: m.height ?? 0 }).png().toBuffer();
}

/** Flat background candidates: the one farthest from all of the character's colours wins. */
const BACKGROUNDS: [number, number, number][] = [[214, 214, 214], [40, 40, 44], [62, 168, 82], [196, 64, 196], [52, 96, 210], [222, 196, 64]];

export async function contrastingBackground(sprite: Buffer): Promise<{ hex: string; rgb: [number, number, number] }> {
  const { data, info } = await sharp(sprite).ensureAlpha().resize(64, 64, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  let best = BACKGROUNDS[0]!, bestScore = -1;
  for (const c of BACKGROUNDS) {
    // How much of the character sits close to this colour (lower is better); ties go to the earlier, calmer colour.
    let near = 0, n = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      if (data[i * 4 + 3]! < 128) continue;
      n++;
      const d = Math.abs(data[i * 4]! - c[0]) + Math.abs(data[i * 4 + 1]! - c[1]) + Math.abs(data[i * 4 + 2]! - c[2]);
      if (d < 120) near++;
    }
    const score = 1 - near / Math.max(1, n);
    if (score > bestScore + 0.01) {
      bestScore = score;
      best = c;
    }
  }
  return { hex: `#${best.map((v) => v.toString(16).padStart(2, '0')).join('')}`, rgb: best };
}

/** Make every pixel close to the key colour transparent (soft edge), wherever it is — gaps between limbs included. */
async function keyOut(png: Buffer, key: [number, number, number]): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < info.width * info.height; i++) {
    const d = Math.abs(data[i * 4]! - key[0]) + Math.abs(data[i * 4 + 1]! - key[1]) + Math.abs(data[i * 4 + 2]! - key[2]);
    if (d < 60) data[i * 4 + 3] = 0;
    else if (d < 100) data[i * 4 + 3] = Math.min(data[i * 4 + 3]!, Math.round(((d - 60) / 40) * 255));
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Ask the art checker whether a pose skeleton was painted over the characters of a sheet. */
export async function skeletonDrawn(sheet: Buffer): Promise<boolean> {
  const g = genai();
  if (g.isProcedural('image.check')) return false;
  const view = await sharp(sheet).resize(1024, 1024, { fit: 'inside' }).png().toBuffer();
  const q = 'Are coloured stick-figure lines, joint dots or a pose skeleton drawn on top of any of the characters (lines that are not part of their clothing or gear)?';
  try {
    if (g.isDecision('image.check')) {
      const a = await g.decide('image.check', { state: 'A sprite sheet of one game character walking.', images: [view], questions: { lines: { type: 'noul', instructions: q } } });
      return a.lines?.type === 'noul' && a.lines.noul > 0.5;
    }
    const { z } = await import('zod');
    const r = await g.structured('image.check', { system: 'Judge only what you see.', prompt: q, schema: z.object({ lines: z.boolean() }), name: 'skeleton_check', images: [view], maxTokens: 40 });
    return r.lines;
  } catch {
    return false;
  }
}
