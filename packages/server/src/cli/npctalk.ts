/**
 * Talk to a daydream's people with the configured NPC model, without saving anything: prints each reply with
 * what the person did (quests, gifts, leads…), timings and model cost. For tuning NPC prompts.
 *
 *   tsx src/cli/npctalk.ts <worldId> [npc name filter]
 */
import type { InstanceState } from '@gd/shared';
import { loadWorld } from '../storage';
import { GameInstance } from '../game/instance';
import { openaiCost, openaiUsage } from '../genai/providers';

const [worldId, filter] = process.argv.slice(2);
const w = worldId ? loadWorld(worldId) : null;
if (!w) throw new Error('usage: npctalk <worldId> [npc name filter]');
const state: InstanceState = {
  id: 'i_npctalk', worldId: w.id, ownerId: 'u1', name: 'npc tuning', createdAt: Date.now(), updatedAt: Date.now(), clock: 9 * 60, open: false,
  players: {}, npcs: {}, zones: {}, dynamicQuests: [], events: [], rumors: [], lastActiveAt: Date.now(), difficulty: 'normal',
};
const inst = new GameInstance(state, w);
const cls = w.ruleset.classes[0]!;
inst.addPlayer('u1', 'Tester', [{ name: 'Ash', classId: cls.id, kinId: w.ruleset.kins[0]!.id }]);
const p = inst.state.players.u1!;
let last = 0;
inst.join({
  userId: 'u1',
  send: (m) => {
    if (m.t !== 'dialog' || !m.dialog || m.dialog.thinking) return;
    for (const msg of m.dialog.messages.slice(last)) if (msg.speaker !== 'player') console.log(`   ${msg.speaker === 'npc' ? `${m.dialog.npcName} [${msg.emotion}]` : '>>'}: ${msg.text}`);
    last = m.dialog.messages.length;
  },
});

const town = w.zones.find((z) => z.id === p.zoneId);
const people = w.npcs.filter((n) => (filter ? n.name.toLowerCase().includes(filter.toLowerCase()) : n.zoneId === town?.id));
const pick = filter ? people.slice(0, 1) : [people.find((n) => n.essential), people.find((n) => n.role === 'merchant'), w.npcs.find((n) => n.companion), people.find((n) => !n.essential && n.role === 'commoner') ?? people.find((n) => !n.essential && n.role !== 'merchant')].filter((n, i, a): n is NonNullable<typeof n> => !!n && a.indexOf(n) === i);

const SCRIPT = [
  'Hello. I am new here — who are you, and what is going on in this place?',
  'That sounds hard. Is there anything I can do to help you?',
  'I will do it. I helped a family on the road get home last night, if that counts for anything. What should I watch out for?',
  'Thank you. I trust you — is there anything you have not told anyone?',
];
for (const npc of pick) {
  console.log(`\n=== ${npc.name}, ${npc.title} (${npc.role}${npc.essential ? ', story' : ''}${npc.companion ? ', companion' : ''})`);
  last = 0;
  const before = p.journal.length;
  const quests = Object.keys(p.quests).length;
  await inst.dialogue.open('u1', npc.id);
  for (const line of SCRIPT) {
    console.log(`   Ash: ${line}`);
    const t0 = performance.now();
    await inst.dialogue.say('u1', line);
    console.log(`   (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  }
  inst.dialogue.close('u1');
  const got = p.journal.slice(before).map((j) => `[${j.kind}] ${j.text}`);
  console.log(`   journal +${got.length}${got.length ? `:\n     ${got.join('\n     ')}` : ''}; quests ${quests} -> ${Object.keys(p.quests).length}`);
}
console.log(`\nusage: ${JSON.stringify(openaiUsage)}  ≈ $${openaiCost().toFixed(4)}`);
process.exit(0);
