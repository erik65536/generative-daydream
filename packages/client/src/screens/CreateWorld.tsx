import { useState } from 'react';
import { LENGTH_PROFILES, PROMPT_TOPICS, SIZE_PROFILES, buildEstimate, type CombatMode, type DifficultyId, type GameLength, type PromptTopic, type RulesChoices, type WorldSize } from '@gd/shared';
import { api, type Me } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';
import { navigate } from '../App';

type Prompt = { topic: PromptTopic; text: string };

const PRESETS: { name: string; theme: string; prompts?: Prompt[] }[] = [
  {
    name: 'The Drowned Kingdom',
    theme: 'A once-great coastal kingdom slowly sinking into a warm, glowing sea. Bell towers poke out of tide pools, fishermen pole flat boats over flooded market squares, and the old royal family rules from a cathedral on stilts. Melancholy, beautiful, a little haunted.',
    prompts: [{ topic: 'story', text: 'The sea is rising because something beneath it is waking. The royal family knows and has been bargaining with it for generations.' }],
  },
  {
    name: 'Derelict Star Station',
    theme: 'A sprawling mining station orbiting a dying red star, half its rings abandoned after a mysterious accident. Rival crews scavenge the dark sections while the station AI keeps making cheerful announcements to people who are no longer there. Gritty, with dry humour.',
    prompts: [
      { topic: 'story', text: 'The accident was not an accident. The station AI is protecting something it found in the star.' },
      { topic: 'rules', text: 'No magic: tech and psionics instead.' },
    ],
  },
  {
    name: 'Bramblewood Hollow',
    theme: 'A cozy woodland of talking animals: badger blacksmiths, hedgehog healers, mice running tea shops inside hollow logs. The seasons are turning strangely and spring has not arrived.',
    prompts: [
      { topic: 'story', text: 'Someone has stolen the Spring Lantern. A gentle mystery, with friendship and courage more important than fighting.' },
      { topic: 'monsters', text: 'Suitable for children: opponents are mischievous rather than evil, and nothing is gory.' },
    ],
  },
  {
    name: 'The Last Printer',
    theme: 'A soul-crushing corporate office tower, present day. Fluorescent lights, endless cubicles, a breakroom with a fridge nobody has cleaned since 2009. Somewhere on the 40th floor is the last office printer, and it has become self-aware. Comedy, absurd but played completely straight.',
    prompts: [{ topic: 'story', text: 'Find the last printer and shut it down before it prints the memo that ends the world. Office politics are deadlier than any monster.' }],
  },
  {
    name: 'Wonderland, Inside Out',
    theme: 'An insane, ever-shifting wonderland of impossible gardens, upside-down tea houses, staircases that argue, and a queen whose rules change every hour. Logic is a suggestion and riddles are currency.',
    prompts: [
      { topic: 'story', text: 'You fell in. The only way out is to solve the Riddle of the Clockwork Queen.' },
      { topic: 'people', text: 'Puzzle-forward, whimsical, sharp dialogue.' },
    ],
  },
];

const TOPIC: Record<PromptTopic, { label: string; hint: string }> = {
  story: { label: 'Story', hint: 'A villain, a twist, the quests you enjoy…' },
  places: { label: 'Places', hint: 'A town on stilts, a dungeon inside a whale…' },
  people: { label: 'People', hint: 'Make the merchants funny, everyone speaks in rhyme…' },
  monsters: { label: 'Monsters', hint: 'No undead, foes are mischievous rather than evil…' },
  rules: { label: 'Rules and words', hint: 'No magic, call the money credits…' },
  art: { label: 'Art', hint: 'Watercolour, ink outlines, a muted palette…' },
};

type Tri = boolean | undefined;

/** Auto (the generator decides from the theme) / On / Off. */
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

function Choices<T extends string | number>({ value, onChange, options, columns }: { value: T; onChange: (v: T) => void; options: [T, string, string][]; columns?: number }) {
  return (
    <div className={`choice-grid${columns ? ' cols' : ''}`} style={columns ? ({ '--cols': columns } as React.CSSProperties) : undefined}>
      {options.map(([v, t, d]) => (
        <div key={String(v)} role="button" tabIndex={0} className={`choice ${value === v ? 'on' : ''}`} onClick={() => onChange(v)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onChange(v)}>
          <div className="t">{t}</div>
          <div className="d">{d}</div>
        </div>
      ))}
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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sizeText = (s: WorldSize) => {
  const p = SIZE_PROFILES[s];
  return `${plural(p.towns, 'town', 'towns')}, ${plural(p.wilds, 'wild', 'wilds')}, ${plural(p.dungeons, 'dungeon', 'dungeons')}`;
};
const hours = (h: number) => (h < 1 ? `${Math.max(10, Math.round((h * 60) / 10) * 10)} minutes` : `${Math.round(h * 2) / 2} hours`);

export function CreateWorld({ me }: { me: Me }) {
  const [theme, setTheme] = useState('');
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [size, setSize] = useState<WorldSize>('small');
  const [length, setLength] = useState<GameLength>('short');
  const [combatMode, setCombatMode] = useState<CombatMode>('party_npc');
  const [difficulty, setDifficulty] = useState<DifficultyId>('normal');
  const [communication, setCommunication] = useState(2);
  const [seed, setSeed] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [rules, setRules] = useState<RulesChoices>({});
  const setRule = <K extends keyof RulesChoices>(k: K, v: RulesChoices[K]) => setRules((r) => {
    const next = { ...r, [k]: v };
    if (v === undefined) delete next[k];
    return next;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const est = buildEstimate(size, length, combatMode);

  const setPrompt = (i: number, patch: Partial<Prompt>) => setPrompts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const extra = prompts.filter((p) => p.text.trim()).map((p) => ({ topic: p.topic, text: p.text.trim() }));
      const { worldId } = await api.createWorld({ theme, prompts: extra.length ? extra : undefined, size, length, communication, combatMode, seed: seed || undefined, difficulty, rules: Object.keys(rules).length ? rules : undefined });
      navigate(`#/world/${worldId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const comm = [
    { t: 'Private', d: 'People keep what you tell them to themselves.' },
    { t: 'Close circles', d: 'News reaches their friends and family.' },
    { t: 'Small-town', d: 'Whole towns hear about what you do. Tell one person your birthday is tomorrow, and the town might throw you a party.' },
    { t: 'Legend', d: 'Your deeds ripple across the entire world.' },
  ];

  return (
    <div className="page">
      <Backdrop />
      <TopBar me={me} />
      <div className="page-inner" style={{ maxWidth: 980 }}>
        <h1 className="h1">Dream a new daydream</h1>
        <p className="lede">Describe a theme. Everything else is made for this daydream alone before you start: its towns, wilds and dungeons, its people, monsters and items, its rules, and a main story with its twists.</p>

        <div className="panel panel-body col" style={{ marginTop: 18, gap: 18, padding: 22 }}>
          <div className="field">
            <label htmlFor="theme">Theme *</label>
            <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
              <span className="tiny dim">Try one:</span>
              {PRESETS.map((p) => (
                <button key={p.name} className="chip" onClick={() => { setTheme(p.theme); setPrompts(p.prompts ?? []); }}>{p.name}</button>
              ))}
            </div>
            <textarea id="theme" className="input" rows={5} value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="A frozen archipelago where whale-riders trade with sky-ships…" />
          </div>

          <div className="field">
            <label>Extra prompts (optional)</label>
            <div className="hint">Each prompt reaches only the part of the build it is about.</div>
            <div className="col" style={{ gap: 8, marginTop: 4 }}>
              {prompts.map((p, i) => (
                <div key={i} className="row prompt-row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <select className="input" style={{ width: 170, flex: 'none' }} value={p.topic} aria-label="What the prompt is about" onChange={(e) => setPrompt(i, { topic: e.target.value as PromptTopic })}>
                    {PROMPT_TOPICS.map((t) => <option key={t} value={t}>{TOPIC[t].label}</option>)}
                  </select>
                  <textarea className="input grow" rows={2} value={p.text} placeholder={TOPIC[p.topic].hint} aria-label={`${TOPIC[p.topic].label} prompt`} onChange={(e) => setPrompt(i, { text: e.target.value })} />
                  <button className="btn ghost sm" aria-label="Remove this prompt" onClick={() => setPrompts((ps) => ps.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
              {prompts.length < 12 && (
                <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setPrompts((ps) => [...ps, { topic: PROMPT_TOPICS[ps.length % PROMPT_TOPICS.length]!, text: '' }])}>+ Add a prompt</button>
              )}
            </div>
          </div>

          <div className="field">
            <label>World size</label>
            <Choices value={size} onChange={setSize} columns={3} options={[['small', 'Small', sizeText('small')], ['medium', 'Medium', sizeText('medium')], ['large', 'Large', sizeText('large')]]} />
          </div>
          <div className="field">
            <label>Story length</label>
            <Choices value={length} onChange={setLength} columns={4} options={(['short', 'medium', 'long', 'epic'] as const).map((l) => [l, l[0]!.toUpperCase() + l.slice(1), `${LENGTH_PROFILES[l].arcs} story arcs · up to level ${LENGTH_PROFILES[l].maxLevel}`])} />
          </div>
          <div className="field">
            <label>Party</label>
            <Choices value={combatMode} onChange={setCombatMode} columns={3} options={[
              ['solo', 'Solo', 'One hero, stronger alone.'],
              ['party_manual', 'Four heroes', 'Make four heroes and control them all.'],
              ['party_npc', 'You and three companions', 'Make your hero; three heroes of this world travel and fight with you.'],
            ]} />
          </div>
          <div className="field">
            <label>Difficulty</label>
            <Choices value={difficulty} onChange={setDifficulty} columns={5} options={DIFFS} />
            <div className="hint">Each reverie picks its own difficulty when it starts and can change it later.</div>
          </div>

          <div className="studio-ai small">
            Making it takes about {hours(est.buildHours)} on the GPU before you can play, and about {hours(est.animationHours)} more while its people and creatures are animated (they move once theirs is done). It costs about ${est.usd.toFixed(2)} of OpenAI.
          </div>

          <div className="field">
            <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>{advanced ? '▾' : '▸'} Advanced</button>
            {advanced && (
              <div className="col advanced" style={{ gap: 14 }}>
                <div className="hint">Every daydream gets its own rules: classes, skills, resources, damage types and items, designed from your theme. Leave a choice on Auto to let the theme decide.</div>
                <div className="tri-grid">
                  <div className="tri">
                    <div className="grow">
                      <div className="t">Fast travel</div>
                      <div className="tiny dim">Travel between towns you have visited from their waypoints.</div>
                    </div>
                    <div className="seg">
                      {([[true, 'On'], [false, 'Off']] as const).map(([v, t]) => (
                        <button key={t} className={`btn sm ${!!rules.fastTravel === v ? 'primary' : 'ghost'}`} onClick={() => setRule('fastTravel', v || undefined)}>{t}</button>
                      ))}
                    </div>
                  </div>
                  <TriToggle label="Crafting" hint="Recipes from materials, at each town's workshop." value={rules.crafting} onChange={(v) => setRule('crafting', v)} />
                  <TriToggle label="Item upgrades" hint="Improve gear with materials." value={rules.upgrades} onChange={(v) => setRule('upgrades', v)} />
                  <TriToggle label="Enchanting" hint="Reroll an item's bonuses." value={rules.enchanting} onChange={(v) => setRule('enchanting', v)} />
                  <TriToggle label="Critical hits" hint="Lucky hits for extra damage." value={rules.crit} onChange={(v) => setRule('crit', v)} />
                  <TriToggle label="Dodging" hint="Attacks can miss." value={rules.dodge} onChange={(v) => setRule('dodge', v)} />
                  <TriToggle label="Crowd control" hint="Root, silence, disarm and slow." value={rules.control} onChange={(v) => setRule('control', v)} />
                  <TriToggle label="Surfaces" hint="Lingering ground effects that combine." value={rules.surfaces} onChange={(v) => setRule('surfaces', v)} />
                  <TriToggle label="Traps" hint="Hidden traps to spot and disarm." value={rules.traps} onChange={(v) => setRule('traps', v)} />
                  <TriToggle label="Locks" hint="Locked chests." value={rules.locks} onChange={(v) => setRule('locks', v)} />
                </div>
                <div className="field">
                  <label>Reviving downed allies</label>
                  <Choices value={rules.revive ?? 'auto'} onChange={(v) => setRule('revive', v === 'auto' ? undefined : v)} columns={4} options={[
                    ['auto', 'Auto', 'Chosen to fit the daydream.'],
                    ['heal', 'Any healing', 'Healing a downed ally brings them back.'],
                    ['special', 'Special only', 'Only revive skills and items work in a fight.'],
                    ['after_combat', 'After the fight', 'Downed allies stay down until the battle ends.'],
                  ]} />
                </div>
                <div className="field">
                  <label>Classes</label>
                  <div className="seg" style={{ alignSelf: 'flex-start' }}>
                    {([undefined, 3, 4, 5, 6] as const).map((n) => (
                      <button key={String(n)} className={`btn sm ${rules.classes === n ? 'primary' : 'ghost'}`} onClick={() => setRule('classes', n)}>{n ?? 'Auto'}</button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>How far your deeds travel</label>
                  <Choices value={communication} onChange={setCommunication} columns={4} options={comm.map((c, i) => [i, c.t, c.d])} />
                </div>
                <div className="field" style={{ width: 220 }}>
                  <label htmlFor="seed">Seed (optional)</label>
                  <input id="seed" className="input" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" />
                </div>
              </div>
            )}
          </div>

          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="row">
            <div className="spacer" />
            <button className="btn ghost" onClick={() => navigate('#/')}>Cancel</button>
            <button className="btn primary lg" disabled={busy || theme.trim().length < 10} onClick={submit}>
              Begin dreaming
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
