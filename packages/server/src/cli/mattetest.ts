/** Dev check: re-run sprite cleanup on existing PNGs. Usage: tsx src/cli/mattetest.ts <dir> <regex> <outDir> */
import fs from 'node:fs';
import path from 'node:path';
import { processSprite } from '../genai/matte';

const [dir, pattern, out] = process.argv.slice(2);
fs.mkdirSync(out!, { recursive: true });
for (const f of fs.readdirSync(dir!).filter((x) => new RegExp(pattern!).test(x))) {
  const r = await processSprite(fs.readFileSync(path.join(dir!, f)), 256);
  fs.writeFileSync(path.join(out!, f), r.png);
  if (r.problems.length) console.log(f, '->', r.problems.join('; '));
}
