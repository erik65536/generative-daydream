import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTransient, loadGenAIConfig, reloadGenAI } from '../src/genai/service';
import { GenAIError, NotConfigured } from '../src/genai/types';

describe('model gateway', () => {
  const before = process.env.GD_GENAI_CONFIG;
  afterEach(() => {
    process.env.GD_GENAI_CONFIG = before;
    reloadGenAI();
  });

  it('retries only what a provider may recover from', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(new Error('HTTP 429: rate limit exceeded'))).toBe(true);
    expect(isTransient(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isTransient(new Error('HTTP 400: invalid request'))).toBe(false);
    expect(isTransient(new GenAIError('model not configured', false))).toBe(false);
    expect(isTransient(new NotConfigured('npc.decision'))).toBe(false);
  });

  it('says plainly when a purpose has no model, and refuses provider types it does not have', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-cfg-'));
    process.env.GD_GENAI_CONFIG = path.join(dir, 'missing.json');
    const g = reloadGenAI();
    expect(g.configured('npc.decision')).toBe(false);
    expect(() => g.purpose('npc.decision')).toThrow(NotConfigured);
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ providers: { llm: { type: 'openai-chat', baseUrl: 'http://127.0.0.1:9931/v1' } }, purposes: {} }));
    process.env.GD_GENAI_CONFIG = path.join(dir, 'old.json');
    expect(() => loadGenAIConfig()).toThrow(/openai-chat/);
  });
});
