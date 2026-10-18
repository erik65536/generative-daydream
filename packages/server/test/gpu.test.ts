import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { GpuScheduler } from '../src/genai/gpu';
import { isTransient } from '../src/genai/service';
import { GenAIError } from '../src/genai/types';
import type { ProviderConfig } from '../src/genai/types';

const cfg: ProviderConfig = { type: 'openai-chat', gpu: 'test' } as ProviderConfig;

describe('GPU scheduling', () => {
  it('runs one call at a time, most urgent first', async () => {
    const g = new GpuScheduler(() => 0).group(`test_${Date.now()}`);
    const order: string[] = [];
    let active = 0;
    const call = (name: string, rank: number, ms = 30) =>
      g.run('p', 'm', cfg, async () => {
        active++;
        expect(active).toBe(1);
        order.push(name);
        await new Promise((r) => setTimeout(r, ms));
        active--;
        return name;
      }, rank);
    const first = call('build-1', 2, 80);
    await new Promise((r) => setTimeout(r, 10));
    const rest = [call('build-2', 2), call('build-3', 2), call('player', 0), call('studio', 1)];
    await Promise.all([first, ...rest]);
    expect(order).toEqual(['build-1', 'player', 'studio', 'build-2', 'build-3']);
  });

  it('shares the GPU between processes: a second process waits for the first', async () => {
    const group = `xproc_${Date.now()}`;
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'fixtures', 'gpuhold.ts'), group, '1500'], { env: process.env, cwd: process.cwd() });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise((r) => child.on('exit', r));
    for (let i = 0; i < 200 && !out.includes('start'); i++) await new Promise((r) => setTimeout(r, 50));
    expect(out).toContain('start ');
    const g = new GpuScheduler(() => 0).group(group);
    let mineAt = 0;
    await g.run('p', 'parent-model', { ...cfg, gpu: group }, async () => {
      mineAt = Date.now();
    }, 0);
    await exited;
    const endAt = Number(/end (\d+)/.exec(out)?.[1]);
    expect(mineAt).toBeGreaterThanOrEqual(endAt);
  }, 20_000);

  it('retries only what a provider may recover from', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(new Error('HTTP 429: rate limit exceeded'))).toBe(true);
    expect(isTransient(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isTransient(new Error('HTTP 400: invalid request'))).toBe(false);
    expect(isTransient(new GenAIError('model not configured', false))).toBe(false);
  });
});
