/** Transcribe an audio file with the configured speech model: tsx src/cli/stttest.ts <file> */
import fs from 'node:fs';
import { genai } from '../genai/service';

const file = process.argv[2]!;
const t0 = performance.now();
const text = await genai().transcribe('speech.input', fs.readFileSync(file), file.endsWith('.wav') ? 'audio/wav' : 'audio/webm');
console.log(`${((performance.now() - t0) / 1000).toFixed(2)}s: ${JSON.stringify(text)}`);
process.exit(0);
