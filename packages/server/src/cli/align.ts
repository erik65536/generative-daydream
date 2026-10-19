/** Measure how a painting lines up with its block-out. Usage: tsx src/cli/align.ts <block.png> <painting.png> */
import fs from 'node:fs';
import { measureAlignment } from '../worldgen/painter';

const [block, paint] = process.argv.slice(2);
console.log(JSON.stringify(await measureAlignment(fs.readFileSync(block!), fs.readFileSync(paint!))));
