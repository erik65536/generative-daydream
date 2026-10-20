/** Run the art checker over images of known quality and print its raw answers (prompt calibration). */
import type { AssetKind } from '../genai/promptprofiles';
import fs from 'node:fs';
import path from 'node:path';
import { qualityCheck } from '../genai/images';
import { openaiCost } from '../genai/providers';
import { loadWorld, worldAssetDir } from '../storage';

process.env.GD_DEBUG_CHECK = '1';
const cases: [string, string, 'good' | 'bad'][] = [
  ['w_livemvd05zun', 'spr_npc_n_brenda_kowalski_0', 'good'],
  ['w_livemvd05zun', 'spr_origin_cl_synergy_specialist_masculine', 'good'],
  ['w_livemvd05zun', 'tex_ts_t0_0_in_floorAlt', 'good'],
  ['w_livemvd05zun', 'obj_ts_t0_0_in_plant', 'good'],
  ['w_livemvd05zun', 'icon_m_staples', 'good'],
  ['w_livemvcizlax', 'obj_ts_w1_0_shrine', 'good'],
  ['w_livemvd05zun', 'tex_ts_d0_0_water', 'bad'],
  ['w_livemvd05zun', 'obj_ts_t0_0_sign', 'bad'],
  ['w_livemvcizlax', 'spr_origin_o_mage', 'bad'],
  ['w_livemvd05zun', 'tex_ts_d1_0_water', 'bad'],
];
for (const [wid, key, truth] of cases) {
  const w = loadWorld(wid)!;
  const a = w.assets[key];
  if (!a?.file) continue;
  const r = await qualityCheck(fs.readFileSync(path.join(worldAssetDir(wid), a.file)), a.kind as AssetKind, a.prompt);
  console.log(`${truth.padEnd(4)} ${key.padEnd(46)} score ${r?.score.toFixed(1)}  ${r?.problems.join('; ')}`);
}
console.log(`≈ $${openaiCost().toFixed(4)}`);
process.exit(0);
