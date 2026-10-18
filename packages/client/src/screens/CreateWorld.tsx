import { useState } from 'react';
import type { DifficultyId, RulesChoices } from '@gd/shared';
import { api, type Me } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';
import { navigate } from '../App';

const PRESETS: { name: string; setting: string; story?: string; notes?: string }[] = [
  {
    name: 'The Drowned Kingdom',
    setting: 'A once-great coastal kingdom slowly sinking into a warm, glowing sea. Bell towers poke out of tide pools, fishermen pole flat boats over flooded market squares, and the old royal family rules from a cathedral on stilts. Melancholy, beautiful, a little haunted.',
    story: 'The sea is rising because something beneath it is waking. The royal family knows and has been bargaining with it for generations.',
  },
  {
    name: 'Derelict Star Station',
    setting: 'A sprawling mining station orbiting a dying red star, half its rings abandoned after a mysterious accident. Rival crews scavenge the dark sections while the station AI keeps making cheerful announcements to people who are no longer there.',
    story: 'The accident was not an accident. The station AI is protecting something it found in the star.',
    notes: 'Gritty but with dry humor. No magic — tech and psionics instead.',
  },
  {
    name: 'Bramblewood Hollow',
    setting: 'A cozy woodland of talking animals: badger blacksmiths, hedgehog healers, mice running tea shops inside hollow logs. The seasons are turning strangely and spring has not arrived.',
    story: 'Someone has stolen the Spring Lantern. A gentle mystery, with friendship and courage more important than fighting.',
    notes: 'Suitable for children. Opponents are mischievous rather than evil; nothing gory.',
  },
  {
    name: 'The Last Printer',
    setting: 'A soul-crushing corporate office tower, present day. Fluorescent lights, endless cubicles, a breakroom with a fridge nobody has cleaned since 2009. Somewhere on the 40th floor is the last office printer — and it has become self-aware.',
    story: 'Find the last printer and shut it down before it prints the memo that ends the world. Office politics are deadlier than any monster.',
    notes: 'Comedy. Absurd but played completely straight.',
  },
  {
    name: 'Wonderland, Inside Out',
    setting: 'An insane, ever-shifting wonderland of impossible gardens, upside-down tea houses, staircases that argue, and a queen whose rules change every hour. Logic is a suggestion and riddles are currency.',
    story: 'You fell in. The only way out is to solve the Riddle of the Clockwork Queen.',
    notes: 'Puzzle-forward, whimsical, sharp dialogue.',
  },
];

type Tri = boolean | undefined;

/** Auto (the generator decides from the setting) / On / Off. */
function TriToggle({ label, hint, value, onChange }: { label: string; hint: string; value: Tri; onChange: (v: Tri) => void }) {
  return (
    <div className="tri">
      <div className="grow">
        <div className="t">{label}</div>
        <div className="tiny dim">{hint}</div>
      </div>
      <div className="seg">
        {([[undefined, 'Auto'], [true, 'On'], [false, 'Off']] as const).map(([v, t]) => (
          <button key={t} className={`btn sm ${value === v ? 'primary' : 'ghost'}`} onClick={() => onChange(v)}>{t}</button>
        ))}
      </div>
    </div>
  );
}

const DIFFS: [DifficultyId, string, string][] = [
  ['story', 'Story', 'For the tale.'],
  ['easy', 'Easy', 'Relaxed.'],
  ['normal', 'Normal', 'The intended balance.'],
  ['hard', 'Hard', 'Tactics matter.'],
  ['brutal', 'Brutal', 'Merciless.'],
];

export function CreateWorld({ me }: { me: Me }) {
  const [setting, setSetting] = useState('');
  const [story, setStory] = useState('');
  const [notes, setNotes] = useState('');
  const [size, setSize] = useState<'small' | 'medium' | 'large' | 'huge'>('small');
  const [length, setLength] = useState<'short' | 'medium' | 'long' | 'epic'>('short');
  const [communication, setCommunication] = useState(2);
  const [combatMode, setCombatMode] = useState<'solo' | 'party_manual' | 'party_npc'>('party_npc');
  const [art, setArt] = useState<'none' | 'essential' | 'full'>('full');
  const [seed, setSeed] = useState('');
  const [difficulty, setDifficulty] = useState<DifficultyId>('normal');
  const [advanced, setAdvanced] = useState(false);
  const [rules, setRules] = useState<RulesChoices>({});
  const setRule = <K extends keyof RulesChoices>(k: K, v: RulesChoices[K]) => setRules((r) => {
    const next = { ...r, [k]: v };
    if (v === undefined) delete next[k];
    return next;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const { worldId } = await api.createWorld({ setting, story: story || undefined, notes: notes || undefined, size, length, communication, combatMode, art, seed: seed || undefined, difficulty, rules: Object.keys(rules).length ? rules : undefined });
      navigate(`#/world/${worldId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const comm = [
    { t: 'Private', d: 'NPCs keep what you tell them to themselves.' },
    { t: 'Close circles', d: 'News reaches their friends and family.' },
    { t: 'Small-town', d: 'Whole towns hear about what you do. Tell one person your birthday is tomorrow, and the town might throw you a party.' },
    { t: 'Legend', d: 'Your deeds ripple across the entire world.' },
  ];

  return (
    <div className="page">
      <Backdrop />
      <TopBar me={me} />
      <div className="page-inner" style={{ maxWidth: 980 }}>
        <h1 className="h1">Dream a world</h1>
        <p className="lede">Describe the feel of the place. Everything else — towns, dungeons, people, monsters, items, the main story and its twists — is generated before you start.</p>

        <div className="panel panel-body col" style={{ marginTop: 18, gap: 18, padding: 22 }}>
          <div className="field">
            <label>Setting, world & feel *</label>
            <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
              <span className="tiny dim">Try one:</span>
              {PRESETS.map((p) => (
                <span key={p.name} className="chip" onClick={() => { setSetting(p.setting); setStory(p.story ?? ''); setNotes(p.notes ?? ''); }}>
                  {p.name}
                </span>
              ))}
            </div>
            <textarea className="input" rows={5} value={setting} onChange={(e) => setSetting(e.target.value)} placeholder="A frozen archipelago where whale-riders trade with sky-ships…" />
          </div>
          <div className="row" style={{ alignItems: 'stretch', gap: 16 }}>
            <div className="field grow">
              <label>Story, lore & quest ideas (optional)</label>
              <textarea className="input" rows={4} value={story} onChange={(e) => setStory(e.target.value)} placeholder="Influences, a villain, a twist you'd like, the kind of quests you enjoy…" />
            </div>
            <div className="field grow">
              <label>Notes for the generator (optional)</label>
              <textarea className="input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Tone, content limits, 'make the merchants funny', 'no undead'…" />
            </div>
          </div>

          <div className="field">
            <label>World size</label>
            <div className="choice-grid">
              {([
                ['small', 'Small', '2 towns, 2 wilds, 3 dungeons'],
                ['medium', 'Medium', '3 towns, 4 wilds, 5 dungeons'],
                ['large', 'Large', '4 towns, 6 wilds, 8 dungeons'],
                ['huge', 'Huge', '6 towns, 9 wilds, 12 dungeons'],
              ] as const).map(([v, t, d]) => (
                <div key={v} className={`choice ${size === v ? 'on' : ''}`} onClick={() => setSize(v)}>
                  <div className="t">{t}</div>
                  <div className="d">{d}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Game length</label>
            <div className="choice-grid">
              {([
                ['short', 'Short', '2 story arcs · max level 8'],
                ['medium', 'Medium', '3 arcs · max level 14'],
                ['long', 'Long', '4 arcs · max level 20'],
                ['epic', 'Epic', '5 arcs · max level 30'],
              ] as const).map(([v, t, d]) => (
                <div key={v} className={`choice ${length === v ? 'on' : ''}`} onClick={() => setLength(v)}>
                  <div className="t">{t}</div>
                  <div className="d">{d}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="field">
            <label>NPC communication — how far your actions ripple</label>
            <div className="choice-grid">
              {comm.map((c, i) => (
                <div key={i} className={`choice ${communication === i ? 'on' : ''}`} onClick={() => setCommunication(i)}>
                  <div className="t">{c.t}</div>
                  <div className="d">{c.d}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Combat</label>
            <div className="choice-grid">
              {([
                ['solo', 'Lone hero', 'One character, stronger alone.'],
                ['party_manual', 'Full party', 'Create up to four characters and control them all.'],
                ['party_npc', 'Companions', 'Play one character; recruit NPCs who fight alongside you.'],
              ] as const).map(([v, t, d]) => (
                <div key={v} className={`choice ${combatMode === v ? 'on' : ''}`} onClick={() => setCombatMode(v)}>
                  <div className="t">{t}</div>
                  <div className="d">{d}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
            <div className="field grow">
              <label>Generated art</label>
              <div className="choice-grid">
                {([
                  ['none', 'Painted by engine', 'Procedural art only. Fast.'],
                  ['essential', 'Places & characters', 'Surfaces, props and landmarks for every place, and every character.'],
                  ['full', 'Everything', 'Also walking and attack poses for every character, and item icons. Slowest, and worth it.'],
                ] as const).map(([v, t, d]) => (
                  <div key={v} className={`choice ${art === v ? 'on' : ''}`} onClick={() => setArt(v)}>
                    <div className="t">{t}</div>
                    <div className="d">{d}</div>
                  </div>
                ))}
              </div>
              <div className="hint">Image generation only runs if an image model is configured. You can add art to a world later.</div>
            </div>
            <div className="field" style={{ width: 200 }}>
              <label>Seed (optional)</label>
              <input className="input" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" />
            </div>
          </div>
          <div className="field">
            <label>Default difficulty</label>
            <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
              {DIFFS.map(([v, t, d]) => (
                <div key={v} className={`choice ${difficulty === v ? 'on' : ''}`} onClick={() => setDifficulty(v)}>
                  <div className="t">{t}</div>
                  <div className="d">{d}</div>
                </div>
              ))}
            </div>
            <div className="hint">Each journey picks its own difficulty when it starts and can change it later. Rules are balanced by simulating thousands of fights for every difficulty.</div>
          </div>

          <div className="field">
            <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdvanced((v) => !v)}>{advanced ? '▾' : '▸'} Advanced rules</button>
            {advanced && (
              <div className="col advanced" style={{ gap: 14 }}>
                <div className="hint">Every world gets its own ruleset — classes, skills, resources, damage types, items — designed from your setting. Leave a choice on Auto to let the setting decide.</div>
                <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
                  <div className="field grow">
                    <label>Turns</label>
                    <div className="choice-grid">
                      <div className="choice on"><div className="t">Action points</div><div className="d">Move and act freely within a budget each turn.</div></div>
                      <div className="choice disabled"><div className="t">Rounds <span className="badge gray">later</span></div><div className="d">One move and one action per round.</div></div>
                    </div>
                  </div>
                  <div className="field grow">
                    <label>When the party falls</label>
                    <div className="choice-grid">
                      <div className="choice on"><div className="t">Corpse run</div><div className="d">Wake in town; your pack waits on your body. Equipment stays.</div></div>
                    </div>
                  </div>
                </div>
                <div className="field">
                  <label>Reviving downed allies</label>
                  <div className="choice-grid">
                    {([
                      [undefined, 'Auto', 'Chosen to fit the world.'],
                      ['heal', 'Any healing', 'Healing a downed ally brings them back.'],
                      ['special', 'Special only', 'Only revive skills and items work in a fight.'],
                      ['after_combat', 'After the fight', 'Downed allies stay down until the battle ends.'],
                    ] as const).map(([v, t, d]) => (
                      <div key={t} className={`choice ${rules.revive === v ? 'on' : ''}`} onClick={() => setRule('revive', v)}>
                        <div className="t">{t}</div>
                        <div className="d">{d}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="tri-grid">
                  <TriToggle label="Critical hits" hint="Lucky hits for extra damage." value={rules.crit} onChange={(v) => setRule('crit', v)} />
                  <TriToggle label="Dodging" hint="Attacks can miss." value={rules.dodge} onChange={(v) => setRule('dodge', v)} />
                  <TriToggle label="Crowd control" hint="Root, silence, disarm and slow." value={rules.control} onChange={(v) => setRule('control', v)} />
                  <TriToggle label="Surfaces" hint="Lingering ground effects that combine." value={rules.surfaces} onChange={(v) => setRule('surfaces', v)} />
                  <TriToggle label="Traps" hint="Hidden traps to spot and disarm." value={rules.traps} onChange={(v) => setRule('traps', v)} />
                  <TriToggle label="Locks" hint="Locked chests and doors." value={rules.locks} onChange={(v) => setRule('locks', v)} />
                  <TriToggle label="Crafting" hint="Recipes from materials." value={rules.crafting} onChange={(v) => setRule('crafting', v)} />
                  <TriToggle label="Item upgrades" hint="Improve gear with materials." value={rules.upgrades} onChange={(v) => setRule('upgrades', v)} />
                  <TriToggle label="Enchanting" hint="Reroll an item's bonuses." value={rules.enchanting} onChange={(v) => setRule('enchanting', v)} />
                </div>
                <div className="field">
                  <label>Classes</label>
                  <div className="seg" style={{ alignSelf: 'flex-start' }}>
                    {([undefined, 3, 4, 5, 6] as const).map((n) => (
                      <button key={String(n)} className={`btn sm ${rules.classes === n ? 'primary' : 'ghost'}`} onClick={() => setRule('classes', n)}>{n ?? 'Auto'}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {error && <div className="error-text">{error}</div>}
          <div className="row">
            <div className="spacer" />
            <button className="btn ghost" onClick={() => navigate('#/')}>Cancel</button>
            <button className="btn primary lg" disabled={busy || setting.trim().length < 10} onClick={submit}>
              Begin dreaming
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
