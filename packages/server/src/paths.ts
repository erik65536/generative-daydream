import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (two levels above packages/server/src). */
export const ROOT_DIR = path.resolve(here, '..', '..', '..');
// Secrets such as API keys live in a .env file at the repository root (never committed).
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  /* no .env */
}
// A test run without the repository's vitest config would build worlds into the real data dir with the real
// models, and the dev worker would pick its jobs up: refuse instead.
if (process.env.VITEST && (!process.env.GD_DATA_DIR || !process.env.GD_GENAI_CONFIG))
  throw new Error('Tests need GD_DATA_DIR and GD_GENAI_CONFIG (set by vitest.config.ts): run vitest from the repository or packages/server');
export const DATA_DIR = process.env.GD_DATA_DIR ? path.resolve(process.env.GD_DATA_DIR) : path.join(ROOT_DIR, 'data');
export const CONFIG_DIR = path.join(ROOT_DIR, 'config');
export const CLIENT_DIST = path.join(ROOT_DIR, 'packages', 'client', 'dist');
