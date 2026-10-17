// Runs the game server (tsx watch) and the Vite client together.
import { spawn } from 'node:child_process';

const run = (name, args, color) => {
  const p = spawn('npm', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const out = (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => tag + l).join('\n') + '\n');
  p.stdout.on('data', out);
  p.stderr.on('data', out);
  p.on('exit', (code) => {
    console.log(`${tag}exited with ${code}`);
    process.exit(code ?? 0);
  });
  return p;
};

const procs = [run('server', ['run', 'dev', '-w', '@gd/server'], 33), run('client', ['run', 'dev', '-w', '@gd/client'], 36)];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
