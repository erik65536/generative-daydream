import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import express from 'express';
import { sendAsset } from '../src/assetroute';

describe('the asset route', () => {
  // Served from under a dot-folder, as a checkout in .claude/worktrees does.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-assets-'));
  const assets = path.join(dir, '.claude', 'worlds', 'assets');
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, 'spr_a.png'), Buffer.from('png'));
    fs.writeFileSync(path.join(assets, 'zone_1.webp'), Buffer.from('webp'));
    const app = express();
    app.get('/a/:file', (req, res) => sendAsset(res, assets, String(req.params.file)));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves files under a dot-folder, keeping versioned paintings and revalidating art', async () => {
    const png = await fetch(`${base}/a/spr_a.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('cache-control')).toBe('no-cache');
    const webp = await fetch(`${base}/a/zone_1.webp`);
    expect(webp.status).toBe(200);
    expect(webp.headers.get('cache-control')).toContain('immutable');
  });

  it('never caches a missing file', async () => {
    const res = await fetch(`${base}/a/zone_2.webp`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${base}/a/evil.txt`)).status).toBe(400);
  });
});
