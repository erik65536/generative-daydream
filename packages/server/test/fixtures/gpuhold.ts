// Child process for gpu.test.ts: holds a GPU group for a while, printing when it starts and ends.
import { GpuScheduler } from '../../src/genai/gpu';
const [group, ms] = process.argv.slice(2);
const g = new GpuScheduler(() => 0).group(group!);
await g.run('p', 'child-model', { type: 'openai-chat', gpu: group } as never, async () => {
  console.log(`start ${Date.now()}`);
  await new Promise((r) => setTimeout(r, Number(ms)));
  console.log(`end ${Date.now()}`);
});
process.exit(0);
