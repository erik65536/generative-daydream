/** Check walk strips for painted-on pose skeletons with the art checker: tsx src/cli/skelcheck.ts <worldId> [filter] */
import fs from 'node:fs';
import path from 'node:path';
import { loadWorld, worldAssetDir } from '../storage';
import { skeletonDrawn } from '../genai/poses';

const [worldId, filter] = process.argv.slice(2);
const w = loadWorld(worldId!)!;
for (const a of Object.values(w.assets).filter((x) => x.variant === 'walk' && x.file && (!filter || x.key.includes(filter)))) {
  console.log(a.key, await skeletonDrawn(fs.readFileSync(path.join(worldAssetDir(w.id), a.file!))));
}
process.exit(0);
