/** Serving a world's generated images. */
import path from 'node:path';
import type { Response } from 'express';

/** File names the asset route serves. */
export const ASSET_FILE = /^[\w.-]+\.(png|webp)$/;

/**
 * Send one asset file from `dir`. Paintings of places carry a version in their name (.webp), so they can be kept for
 * a year; other art is repainted under the same name, so it is revalidated. The cache header goes only on the file
 * itself, never on a 404 (a missing file must be asked for again), and `dir` may sit under a dot-folder (the data of
 * a checkout in .claude/worktrees).
 */
export function sendAsset(res: Response, dir: string, file: string) {
  if (!ASSET_FILE.test(file)) return void res.status(400).end();
  res.sendFile(path.join(dir, file), { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': file.endsWith('.webp') ? 'public, max-age=31536000, immutable' : 'no-cache' } }, (err) => {
    if (err && !res.headersSent) res.status(404).setHeader('Cache-Control', 'no-store').end();
  });
}
