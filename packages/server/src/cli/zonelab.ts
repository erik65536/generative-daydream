/** Painted-zone prototype lab. Usage: tsx src/cli/zonelab.ts sam <image> <outdir> "<prompt>" [threshold] */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { segment } from '../worldgen/comfy';

const [cmd, ...a] = process.argv.slice(2);
if (cmd === 'sam') {
  const [img, out, prompt, th] = a;
  const png = await sharp(img!).png().toBuffer();
  fs.mkdirSync(out!, { recursive: true });
  const t0 = Date.now();
  const masks = await segment(png, prompt!, th ? Number(th) : 0.4);
  console.log(`${masks.length} masks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  masks.forEach((m, i) => fs.writeFileSync(path.join(out!, `${prompt!.replace(/\W+/g, '_')}_${i}.png`), m));
}
if (cmd === 't2i') {
  // t2i <promptfile> <outprefix> <w> <h> <seeds comma>
  const { textToImage } = await import('../worldgen/comfy');
  const [pf, out, w, h, seeds] = a;
  const prompt = fs.readFileSync(pf!, 'utf8').trim();
  for (const s of seeds!.split(',').map(Number)) {
    const t0 = Date.now();
    fs.writeFileSync(`${out}_${s}.png`, await textToImage(prompt, Number(w), Number(h), s));
    console.log(`seed ${s}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
if (cmd === 'grid') {
  // grid <promptfile> <outprefix> <w> <h> <seeds> <cellW>
  const { edit, freeGpu } = await import('../worldgen/comfy');
  const [pf, out, w, h, seeds, cell] = a;
  // The grid only shows the angles, so a half-size reference is enough (and halves the edit's memory).
  const W = Number(w) / 2, H = Number(h) / 2, C = Number(cell ?? 64) / 2;
  const lines: string[] = [];
  for (let k = -H * 2; k < W + H * 2; k += C) {
    lines.push(`<line x1="${k}" y1="0" x2="${k + H * 2}" y2="${H}" />`, `<line x1="${k}" y1="0" x2="${k - H * 2}" y2="${H}" />`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#8a8578"/><g stroke="#5e5a50" stroke-width="2">${lines.join('')}</g></svg>`;
  const grid = await sharp(Buffer.from(svg)).png().toBuffer();
  fs.writeFileSync(`${out}_grid.png`, grid);
  const prompt = fs.readFileSync(pf!, 'utf8').trim();
  for (const s of seeds!.split(',').map(Number)) {
    await freeGpu();
    fs.writeFileSync(`${out}_${s}.png`, await edit([grid], prompt, W * 2, H * 2, s));
    console.log(`seed ${s}`);
  }
}
if (cmd === 'zone') {
  // zone <worldId> <zoneId> <outdir> <seeds> [--prompt file] [--guidance text]
  const { loadWorld } = await import('../storage');
  const zp = await import('../worldgen/zonepaint');
  const [worldId, zoneId, out, seeds] = a;
  const opt = (n: string) => (a.indexOf(`--${n}`) >= 0 ? a[a.indexOf(`--${n}`) + 1] : undefined);
  const w = loadWorld(worldId!)!;
  const z = w.zones.find((x) => x.id === zoneId)!;
  fs.mkdirSync(out!, { recursive: true });
  const t0 = Date.now();
  const say = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  const pf = opt('prompt') ?? path.join(out!, 'prompt.txt');
  let prompt = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : '';
  if (!prompt) {
    prompt = await zp.writeZonePrompt(w, z, opt('guidance'));
    fs.writeFileSync(pf, prompt);
  }
  say(`prompt: ${prompt.slice(0, 200)}…`);
  const need = zp.needsOf(w, z);
  for (const s of seeds!.split(',').map(Number)) {
    const file = path.join(out!, `paint_${s}.png`);
    const png = fs.existsSync(file) ? fs.readFileSync(file) : await zp.paintZoneImage(prompt, s);
    fs.writeFileSync(file, png);
    say(`painted seed ${s}`);
    const rf = path.join(out!, `reading_${s}.json`);
    const read = fs.existsSync(rf) && !a.includes('--reread') ? JSON.parse(fs.readFileSync(rf, 'utf8')).read : await zp.readPainting(w, z, png);
    say(`read: ${JSON.stringify(read)}`);
    const r = await zp.analyseZone(png, read, { report: say, needDoors: need.buildings.length });
    fs.writeFileSync(path.join(out!, `overlay_${s}.jpg`), await zp.overlay(png, r));
    fs.writeFileSync(path.join(out!, `reading_${s}.json`), JSON.stringify({ read, checks: r.checks, doors: r.doors, landmarks: r.landmarks, exits: r.exits, pxPerMetre: r.pxPerMetre, upscale: r.upscale }, null, 2));
    for (const c of r.checks) say(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
  }
  const { freeGpu } = await import('../worldgen/comfy');
  await freeGpu();
}
if (cmd === 'moge') {
  const { geometry } = await import('../worldgen/comfy');
  const [img, out] = a;
  const t0 = Date.now();
  const g = await geometry(await sharp(img!).png().toBuffer());
  fs.writeFileSync(`${out}_normal.png`, g.normal);
  fs.writeFileSync(`${out}_depth.png`, g.depth);
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
if (cmd === 'outpaint') {
  // outpaint <worldId> <zoneId> <outdir> <cols> <rows> <seed>
  const { loadWorld } = await import('../storage');
  const op = await import('../worldgen/outpaint');
  const [worldId, zoneId, out, cols, rows, seed] = a;
  const opt2 = (n: string) => (a.indexOf(`--${n}`) >= 0 ? a[a.indexOf(`--${n}`) + 1] : undefined);
  const w = loadWorld(worldId!)!;
  const z = w.zones.find((x) => x.id === zoneId)!;
  fs.mkdirSync(out!, { recursive: true });
  const t0 = Date.now();
  const say = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  const pf = path.join(out!, `plan_${cols}x${rows}.json`);
  const plan = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : await op.planChunks(w, z, Number(cols), Number(rows));
  fs.writeFileSync(pf, JSON.stringify(plan, null, 2));
  say(`plan: ${plan.style.slice(0, 160)}…`);
  const r = await op.outpaintZone(plan, Number(seed), { report: say, edges: (opt2('edges') ?? 'closed') as never, onChunk: (c, i) => fs.writeFileSync(path.join(out!, `canvas_${seed}${(opt2('tag') ?? '')}_step${i}.png`), c) });
  fs.writeFileSync(path.join(out!, `canvas_${seed}${(opt2('tag') ?? '')}.png`), r.canvas);
  say(`canvas ${r.width}x${r.height}`);
  const { freeGpu } = await import('../worldgen/comfy');
  await freeGpu();
}
if (cmd === 'read') {
  // read <worldId> <zoneId> <image> <outprefix> [--reread]
  const { loadWorld } = await import('../storage');
  const zp = await import('../worldgen/zonepaint');
  const [worldId, zoneId, img, out] = a;
  const w = loadWorld(worldId!)!;
  const z = w.zones.find((x) => x.id === zoneId)!;
  const t0 = Date.now();
  const say = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  const png = await sharp(img!).png().toBuffer();
  const rf = `${out}_reading.json`;
  const read = fs.existsSync(rf) && !a.includes('--reread') ? JSON.parse(fs.readFileSync(rf, 'utf8')).read : await zp.readPainting(w, z, png);
  say(`read: ${JSON.stringify(read)}`);
  const r = await zp.analyseZone(png, read, { report: say, needDoors: zp.needsOf(w, z).buildings.length });
  fs.writeFileSync(`${out}_overlay.jpg`, await zp.overlay(png, r, 2400));
  fs.writeFileSync(rf, JSON.stringify({ read, checks: r.checks, doors: r.doors, landmarks: r.landmarks, exits: r.exits, pxPerMetre: r.pxPerMetre, upscale: r.upscale }, null, 2));
  for (const c of r.checks) say(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
}
if (cmd === 'flatten') {
  const { flattenVignette } = await import('../worldgen/outpaint');
  const [img, out, st] = a;
  const { data, info } = await sharp(img!).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const f = await flattenVignette(data, info.width, info.height, st ? Number(st) : 1);
  const before = await sharp(img!).resize(1000).png().toBuffer();
  const after = await sharp(f, { raw: { width: info.width, height: info.height, channels: 3 } }).resize(1000).png().toBuffer();
  const h = Math.round((1000 * info.height) / info.width);
  await sharp({ create: { width: 2010, height: h, channels: 3, background: '#fff' } }).composite([{ input: before, left: 0, top: 0 }, { input: after, left: 1010, top: 0 }]).jpeg({ quality: 85 }).toFile(out!);
}
if (cmd === 'redraw') {
  // redraw <sketch> <out> <width> <height> <seed> <refres> <promptfile>: repaint a stitched sketch in one pass.
  const { edit, freeGpu } = await import('../worldgen/comfy');
  const [img, out, w, h, seed, refres, pf] = a;
  const ref = await sharp(img!).resize(Number(w), Number(h), { fit: 'fill' }).png().toBuffer();
  const t0 = Date.now();
  await freeGpu();
  fs.writeFileSync(out!, await edit([ref], fs.readFileSync(pf!, 'utf8').trim(), Number(w), Number(h), Number(seed), Number(refres)));
  console.log(`redrawn in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await freeGpu();
}
if (cmd === 'img2img') {
  // img2img <sketch> <out> <w> <h> <seed> <base weight> <promptfile> [seam weight] [seams "x:1900,x:2600,y:963"]
  // Repaint a resized sketch partially; the mask is the per-pixel repaint weight (Differential Diffusion).
  const { inpaint, freeGpu } = await import('../worldgen/comfy');
  const [img, out, w, h, seed, base, pf, seamW, seams] = a;
  const W = Number(w), H = Number(h);
  const meta = await sharp(img!).metadata();
  const sx = W / meta.width!, sy = H / meta.height!;
  const init = await sharp(img!).resize(W, H, { fit: 'fill' }).png().toBuffer();
  const lines = (seams ?? '').split(',').filter(Boolean).map((s) => ({ axis: s[0], at: Number(s.slice(2)) * (s[0] === 'x' ? sx : sy) }));
  const mask = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let wgt = Number(base);
      for (const l of lines) {
        const d = Math.abs((l.axis === 'x' ? x : y) - l.at);
        if (d < 150) wgt = Math.max(wgt, Number(base) + (Number(seamW) - Number(base)) * (1 - d / 150));
      }
      mask[y * W + x] = Math.round(255 * wgt);
    }
  const maskPng = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  fs.writeFileSync(out!.replace(/\.png$/, '_mask.png'), maskPng);
  const t0 = Date.now();
  await freeGpu();
  // ZP_I2I_REF=1: hybrid, the model also looks at the sketch (encoded at about 1 MP) as an edit reference.
  fs.writeFileSync(out!, await inpaint(init, maskPng, fs.readFileSync(pf!, 'utf8').trim(), W, H, Number(seed), process.env.ZP_I2I_REF === '1' ? init : null, 1024));
  console.log(`img2img in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await freeGpu();
}
if (cmd === 'sheet') {
  // sheet <image> <out> <label> <crops "x,y;x,y;x,y"> [--native]: overview + three 1:1 crops (600×400 from x,y).
  // Crops are in a 2784×1152 frame, or with --native in the image's own pixels (its aspect kept).
  const [img, out, label, crops] = a;
  const meta = await sharp(img!).metadata();
  const native = a.includes('--native');
  const FW = native ? meta.width! : 2784, FH = native ? meta.height! : 1152;
  const src = native ? await sharp(img!).removeAlpha().png().toBuffer() : await sharp(img!).resize(FW, FH, { fit: 'fill' }).png().toBuffer();
  const over = await sharp(src).resize(1800).png().toBuffer();
  const oh = Math.round((1800 * FH) / FW);
  const pts = crops!.split(';').map((p) => p.split(',').map(Number) as [number, number]);
  const tiles = await Promise.all(pts.map(([x, y]) => sharp(src).extract({ left: x, top: y, width: 600, height: 400 }).png().toBuffer()));
  const boxes = a.includes('--boxes') ? pts.map(([x, y]) => `<rect x="${(x * 1800) / FW}" y="${(y * 1800) / FW}" width="${(600 * 1800) / FW}" height="${(400 * 1800) / FW}" fill="none" stroke="#ff0" stroke-width="2"/>`).join('') : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="${oh + 400}">${boxes}<rect x="0" y="0" width="${label!.length * 13 + 20}" height="34" fill="#000" opacity="0.7"/><text x="10" y="24" font-size="22" font-family="Arial" fill="#fff">${label}</text></svg>`;
  await sharp({ create: { width: 1800, height: oh + 400, channels: 3, background: '#000' } })
    .composite([{ input: over, left: 0, top: 0 }, ...tiles.map((t, i) => ({ input: t, left: i * 600, top: oh })), { input: Buffer.from(svg), left: 0, top: 0 }])
    .jpeg({ quality: 88 })
    .toFile(out!);
}
if (cmd === 'grade') {
  // grade <image> <reference> <out> [strength]: transfer the reference's overall tone and colour (per-channel mean
  // and spread in CIE Lab) onto the image, leaving its structure alone.
  const [img, refImg, out, st] = a;
  const k = st ? Number(st) : 1;
  const { data, info } = await sharp(img!).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ref = await sharp(refImg!).removeAlpha().resize(info.width, info.height, { fit: 'fill' }).raw().toBuffer();
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const gam = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const fx = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fi = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const toLab = (buf: Buffer) => {
    const o = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i += 3) {
      const r = lin(buf[i]!), g = lin(buf[i + 1]!), b = lin(buf[i + 2]!);
      const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
      const x = fx(X), y = fx(Y), z = fx(Z);
      o[i] = 116 * y - 16; o[i + 1] = 500 * (x - y); o[i + 2] = 200 * (y - z);
    }
    return o;
  };
  const A = toLab(data), R = toLab(ref);
  const stats = (v: Float32Array, ch: number) => {
    let sum = 0, ss = 0, n = 0;
    for (let i = ch; i < v.length; i += 3) { sum += v[i]!; ss += v[i]! * v[i]!; n++; }
    const m = sum / n;
    return [m, Math.sqrt(Math.max(1e-6, ss / n - m * m))] as const;
  };
  for (let ch = 0; ch < 3; ch++) {
    const [ma, sa] = stats(A, ch), [mr, sr] = stats(R, ch);
    for (let i = ch; i < A.length; i += 3) A[i] = A[i]! + (((A[i]! - ma) * sr) / sa + mr - A[i]!) * k;
  }
  const outBuf = Buffer.alloc(data.length);
  for (let i = 0; i < A.length; i += 3) {
    const y = (A[i]! + 16) / 116, x = y + A[i + 1]! / 500, z = y - A[i + 2]! / 200;
    const X = fi(x) * 0.95047, Y = fi(y), Z = fi(z) * 1.08883;
    const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
    outBuf[i] = Math.max(0, Math.min(255, Math.round(gam(Math.max(0, r)))));
    outBuf[i + 1] = Math.max(0, Math.min(255, Math.round(gam(Math.max(0, g)))));
    outBuf[i + 2] = Math.max(0, Math.min(255, Math.round(gam(Math.max(0, b)))));
  }
  await sharp(outBuf, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toFile(out!);
}
if (cmd === 'seampass') {
  // seampass <canvas> <seams.png> <plan.json> <out> [half]: repaint a strip along every seam with Krea AnyPaint.
  const { repaintSeams } = await import('../worldgen/outpaint');
  const [img, seamFile, planFile, out, half] = a;
  const plan = JSON.parse(fs.readFileSync(planFile!, 'utf8'));
  const prompt = `One seamless isometric video game level; surfaces, light and textures continue smoothly. ${plan.style}`;
  const t0 = Date.now();
  fs.writeFileSync(out!, await repaintSeams(fs.readFileSync(img!), fs.readFileSync(seamFile!), prompt, 9, { half: half ? Number(half) : 32, report: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`) }));
}
if (cmd === 'upscale') {
  // upscale <in> <out> [factor]: SeedVR2 (tiled) upscale.
  const { upscaleTiled } = await import('../worldgen/painter');
  const [img, out, f] = a;
  const t0 = Date.now();
  const { freeGpu } = await import('../worldgen/comfy');
  await freeGpu();
  const up = await upscaleTiled(fs.readFileSync(img!), Number(f ?? 2), 7, (m) => console.log(m));
  if (!up) throw new Error('upscale unavailable');
  fs.writeFileSync(out!, up);
  console.log(`upscaled in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
if (cmd === 'rechunk') {
  // rechunk <canvas-before.png> <plan.json> <col> <row> <x0> <y0> <knownRows> <seed> <out>: repaint one chunk window
  // with Krea AnyPaint (known = the window's top <knownRows> rows), to compare settings on identical input.
  const { chunkPrompt } = await import('../worldgen/outpaint');
  const { kreaAnyPaint } = await import('../worldgen/comfy');
  const [img, planFile, col, row, x0, y0, knownRows, seed, out] = a;
  const PW = Number(process.env.ZP_W ?? 1728), PH = Number(process.env.ZP_H ?? 864);
  const plan = JSON.parse(fs.readFileSync(planFile!, 'utf8'));
  const prompt = chunkPrompt(plan, Number(col), Number(row), false).replace(/^Part of this level is already painted\.[^.]*\.\s*/, '');
  const win = await sharp(img!).removeAlpha().extract({ left: Number(x0), top: Number(y0), width: PW, height: PH }).png().toBuffer();
  const m = Buffer.alloc(PW * PH);
  for (let y = Number(knownRows); y < PH; y++) m.fill(255, y * PW, (y + 1) * PW);
  const mask = await sharp(m, { raw: { width: PW, height: PH, channels: 1 } }).png().toBuffer();
  const t0 = Date.now();
  fs.writeFileSync(out!, await kreaAnyPaint(win, mask, prompt, Number(seed), Number(process.env.ZP_REDRAW ?? 32)));
  console.log(`refmax ${process.env.ZP_REFMAX ?? 384}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
