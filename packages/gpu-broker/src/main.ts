/**
 * The GPU broker: the only way to the GPU for every installation of the game (production on the game box,
 * development here). Started by hand next to ComfyUI:
 *
 *   npm run broker
 *
 * Reads config/broker.json (GD_BROKER_CONFIG to use another file). See docs/gpu-broker.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Broker } from './scheduler';
import { ComfyAdapter } from './adapters/comfyui';
import { HoldAdapter } from './adapters/hold';
import { createFront } from './http';

interface BrokerConfig {
  listen?: { host?: string; port?: number };
  /** Client name → bearer token ("env:NAME" reads an environment variable). */
  clients?: Record<string, string>;
  adapters: { comfyui: { url: string; freeBetweenModels?: boolean } };
  holdMs?: number;
  graceMs?: number;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const file = process.env.GD_BROKER_CONFIG ? path.resolve(process.env.GD_BROKER_CONFIG) : path.join(root, 'config', 'broker.json');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* no .env */
}
if (!fs.existsSync(file)) {
  console.error(`No broker config at ${file}: copy config/broker.example.json to config/broker.json`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as BrokerConfig;

const secret = (v: string) => (v.startsWith('env:') ? process.env[v.slice(4)] : v);
const clients: Record<string, string> = {};
for (const [name, v] of Object.entries(cfg.clients ?? {})) {
  const token = secret(v);
  if (token) clients[name] = token;
  else console.warn(`[broker] client "${name}" has no token (${v} is empty): it cannot connect`);
}

const comfy = new ComfyAdapter(cfg.adapters.comfyui);
const broker = new Broker({ comfyui: comfy, hold: new HoldAdapter() }, { holdMs: cfg.holdMs, graceMs: cfg.graceMs });
const host = cfg.listen?.host ?? '0.0.0.0';
const port = cfg.listen?.port ?? 8190;
createFront(broker, comfy, { clients }).listen(port, host, async () => {
  console.log(`[broker] on http://${host}:${port} → ComfyUI ${comfy.url} (${(await comfy.alive()) ? 'answering' : 'not answering yet'}); clients: local${Object.keys(clients).map((c) => `, ${c}`).join('')}`);
});

const stop = () => {
  broker.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
