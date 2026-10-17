import fs from 'node:fs';
import { cutoutSprite, makeSeamless } from '../genai/images';
const dir = process.argv[2]!;
const sprite = await cutoutSprite(fs.readFileSync(`${dir}/sprite_test.png`), 256);
fs.writeFileSync(`${dir}/sprite_cut.png`, sprite.png);
console.log('sprite', sprite.width, sprite.height, sprite.problems);
fs.writeFileSync(`${dir}/tex_seamless.png`, await makeSeamless(fs.readFileSync(`${dir}/tex_test.png`), 256));
