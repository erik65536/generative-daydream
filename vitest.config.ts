import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts'], testTimeout: 60000, env: { GD_DATA_DIR: './data-test', GD_GENAI_CONFIG: './data-test/no-genai.json', GD_BALANCE: 'quick' } } });
