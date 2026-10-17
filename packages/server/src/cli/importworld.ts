/** Dev helper: copy a world.json (e.g. from data-test) into the live catalog under a given owner. Usage: tsx src/cli/importworld.ts <world.json> <ownerId> <ownerName> */
import fs from 'node:fs';
import type { WorldDefinition } from '@gd/shared';
import { saveWorld } from '../storage';

const [file, ownerId, ownerName] = process.argv.slice(2);
if (!file || !ownerId) throw new Error('usage: importworld <world.json> <ownerId> [ownerName]');
const w = JSON.parse(fs.readFileSync(file, 'utf8')) as WorldDefinition;
w.ownerId = ownerId;
w.ownerName = ownerName ?? 'dev';
saveWorld(w);
console.log(`imported ${w.id}: ${w.concept.title}`);
