/**
 * Renders an actor's clips to sprite sheets: the rig (rig.json, tex.png, clips.json in its job directory) is posed
 * by page/clips.js and drawn by three.js at the game's camera in a headless Chromium (Playwright), then each
 * sheet is saved as WebP. One browser serves a batch and closes when idle.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { Browser } from 'playwright-core';
import type { AnimClip, ClipName } from '@gd/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.join(here, 'page');
const THREE_DIR = path.dirname(createRequire(import.meta.url).resolve('three'));
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

export interface Rendered {
  cell: [number, number];
  anchor: [number, number];
  clips: Partial<Record<ClipName, AnimClip>>;
  /** WebP sheet per clip. */
  sheets: Partial<Record<ClipName, Buffer>>;
}

/** Job directories the page may read, by token. */
const jobs = new Map<string, string>();
let server: { url: string; close: () => void } | null = null;
let browser: Browser | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;

function serve(): Promise<{ url: string; close: () => void }> {
  if (server) return Promise.resolve(server);
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      let file: string | undefined;
      const m = /^\/job\/([\w-]+)\/([\w.-]+)$/.exec(url);
      if (m && jobs.has(m[1]!)) file = path.join(jobs.get(m[1]!)!, m[2]!);
      else if (url.startsWith('/three/')) file = path.join(THREE_DIR, path.basename(url));
      else if (url.startsWith('/page/')) file = path.join(PAGE_DIR, path.basename(url));
      if (!file || !fs.existsSync(file)) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      server = { url: `http://127.0.0.1:${port}`, close: () => s.close() };
      resolve(server);
    });
  });
}

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const { chromium } = await import('playwright-core');
  // The GPU is used when there is one (ANGLE); otherwise WebGL falls back to software, which is slower but the same.
  browser = await chromium.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=default'] });
  return browser;
}

/** Close the browser and page server now (a CLI calls this before exiting). */
export async function closeRenderer() {
  if (idle) clearTimeout(idle);
  idle = null;
  await browser?.close().catch(() => undefined);
  browser = null;
  server?.close();
  server = null;
}

export interface RenderOptions {
  clips: readonly ClipName[];
  /** Sheet pixels per game picture pixel. */
  scale?: number;
  /** Supersampling before the sheet is reduced to `scale`. */
  ss?: number;
  /** Ink outline width in metres. */
  outline?: number;
}

export async function renderSheets(jobDir: string, opts: RenderOptions): Promise<Rendered> {
  if (idle) clearTimeout(idle);
  const token = Math.random().toString(36).slice(2);
  jobs.set(token, jobDir);
  const { url } = await serve();
  const page = await (await getBrowser()).newPage();
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${url}/page/render.html`);
    await page.waitForFunction(() => (globalThis as unknown as { READY?: boolean }).READY, null, { timeout: 30_000 }).catch(() => {
      throw new Error(`render page did not start: ${errors.join('; ') || 'timeout'}`);
    });
    const out = (await page.evaluate(
      (spec) => (globalThis as unknown as { renderActor: (s: unknown) => Promise<unknown> }).renderActor(spec),
      { job: token, clips: opts.clips, scale: opts.scale ?? 2, ss: opts.ss ?? 2, outline: opts.outline ?? 0.014 },
    )) as { cell: [number, number]; anchor: [number, number]; clips: Rendered['clips']; sheets: Record<string, string> };
    const sheets: Rendered['sheets'] = {};
    for (const [name, data] of Object.entries(out.sheets)) {
      const png = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
      sheets[name as ClipName] = await sharp(png).webp({ quality: 92, alphaQuality: 100, effort: 5 }).toBuffer();
    }
    return { cell: out.cell, anchor: out.anchor, clips: out.clips, sheets };
  } finally {
    jobs.delete(token);
    await page.close().catch(() => undefined);
    idle = setTimeout(() => void closeRenderer(), 60_000);
    idle.unref?.();
  }
}
