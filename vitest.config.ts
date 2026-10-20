import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests never touch the real data or models: their own data dir, no genai config. Absolute paths, and
// packages/server/vitest.config.ts re-exports this, so a run from either folder gets the same settings.
const root = path.dirname(fileURLToPath(import.meta.url));
const dataTest = path.join(root, 'data-test');
export default defineConfig({
  root,
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 60000,
    env: { GD_DATA_DIR: dataTest, GD_GENAI_CONFIG: path.join(dataTest, 'no-genai.json'), GD_BALANCE: 'quick', GD_RETRY_WAIT_SCALE: '0' },
  },
});
