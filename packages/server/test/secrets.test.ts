import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSecret } from '../src/genai/providers';

describe('provider keys', () => {
  const saved = process.env.CREDENTIALS_DIRECTORY;
  afterEach(() => {
    if (saved === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = saved;
  });

  it('reads literal keys, environment variables and systemd credentials', () => {
    expect(resolveSecret('sk-literal')).toBe('sk-literal');
    process.env.GD_TEST_KEY = 'from-env';
    expect(resolveSecret('env:GD_TEST_KEY')).toBe('from-env');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-cred-'));
    fs.writeFileSync(path.join(dir, 'openai'), 'from-credential\n');
    process.env.CREDENTIALS_DIRECTORY = dir;
    expect(resolveSecret('credential:openai')).toBe('from-credential');
    expect(resolveSecret('credential:missing')).toBeUndefined();
    expect(resolveSecret('credential:../openai')).toBeUndefined();
    delete process.env.CREDENTIALS_DIRECTORY;
    expect(resolveSecret('credential:openai')).toBeUndefined();
  });
});
