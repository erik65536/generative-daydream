import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (two levels above packages/server/src). */
export const ROOT_DIR = path.resolve(here, '..', '..', '..');
export const DATA_DIR = process.env.GD_DATA_DIR ? path.resolve(process.env.GD_DATA_DIR) : path.join(ROOT_DIR, 'data');
export const CONFIG_DIR = path.join(ROOT_DIR, 'config');
export const CLIENT_DIST = path.join(ROOT_DIR, 'packages', 'client', 'dist');
