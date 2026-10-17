import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts'], testTimeout: 60000, env: { GD_DATA_DIR: './data-test' } } });
