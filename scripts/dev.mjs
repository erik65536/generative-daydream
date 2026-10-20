// Development: the game server (restarts on every change), the job worker (restarts at a safe point when
// server code changes, so world builds pause and resume instead of dying) and the Vite client.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.GD_DATA_DIR ? path.resolve(process.env.GD_DATA_DIR) : path.join(root, 'data');
const reloadFile = path.join(dataDir, '.worker-reload');
let stopping = false;

const run = (name, args, color, env = {}, cmd = 'npm', cwd = root) => {
  const p = spawn(cmd, args, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const out = (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => tag + l).join('\n') + '\n');
  p.stdout.on('data', out);
  p.stderr.on('data', out);
  return { p, tag };
};

const fatal = ({ p, tag }) =>
  p.on('exit', (code) => {
    if (stopping) return;
    console.log(`${tag}exited with ${code}`);
    stop();
  });

// GD_PORT and GD_CLIENT_PORT move both (a second checkout running beside the first).
const clientPort = process.env.GD_CLIENT_PORT ?? '5173';
const server = run('server', ['run', 'dev', '-w', '@gd/server'], 33, { GD_WORKER: 'external', GD_DEV_CLIENT: `http://localhost:${clientPort}` });
const client = run('client', ['run', 'dev', '-w', '@gd/client'], 36);
fatal(server);
fatal(client);

// The worker comes back after a code-change restart (exit 75) or a crash.
let worker;
const startWorker = () => {
  // Run directly (not as an npm script): npm reports the deliberate restart exit code as an error.
  worker = run('worker', ['tsx', 'src/worker.ts'], 35, {}, 'npx', path.join(root, 'packages', 'server'));
  worker.p.on('exit', (code) => {
    if (stopping) return;
    console.log(`${worker.tag}${code === 75 ? 'restarting with the new code' : `exited with ${code}; restarting in 2s`}`);
    setTimeout(startWorker, code === 75 ? 0 : 2000);
  });
};
startWorker();

// Server or shared code changed: ask the worker to restart at its next safe point.
let pending = null;
for (const dir of ['packages/server/src', 'packages/shared/src'])
  fs.watch(path.join(root, dir), { recursive: true }, (_e, file) => {
    if (!file || !/\.(ts|json)$/.test(file)) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(reloadFile, String(Date.now()));
    }, 500);
  });

// Children run through a shell; on Windows killing the shell leaves its node processes running (and holding
// ports), so the whole tree is ended.
const killTree = (p) => {
  if (!p?.pid || p.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  else p.kill();
};

function stop() {
  stopping = true;
  for (const x of [server, client, worker]) killTree(x?.p);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
