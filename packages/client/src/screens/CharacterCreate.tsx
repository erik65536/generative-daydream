import { useEffect, useMemo, useState } from 'react';
import { DIFFICULTIES, characterStats, modifierLabel, rx, type DifficultyId, type ItemInstance, type Presentation, type Ruleset } from '@gd/shared';
import { api, type CharSpec, type Me, type WorldSetup } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';
import { navigate } from '../App';
import { Portrait, SkillIcon, SkillTooltip, tip } from '../ui/common';
import { setRules, weaponVisual } from '../rules';
import { applyWorldTheme } from '../ui/theme';

const PALETTES = [
  ['#4a6a9a', '#2a3448', '#e0c060'],
  ['#8a3a32', '#3a2420', '#f0c070'],
  ['#3e6a42', '#25332a', '#c8e070'],
  ['#5a4a7a', '#2a2238', '#d0a0ff'],
  ['#8a7a5a', '#3a3428', '#f0e0b0'],
  ['#2a5a6a', '#1a2a32', '#80e0f0'],
];

const NAMES = ['Arin', 'Sela', 'Corvin', 'Mira', 'Tobin', 'Ysolde', 'Kael', 'Wren', 'Juno', 'Rook'];
const PRONOUNS: Record<Presentation, string> = { feminine: 'she/her', masculine: 'he/him', androgynous: 'they/them' };

interface Draft extends CharSpec {
  colors: string[];
}

function starterGear(r: Ruleset, classId: string): Record<string, ItemInstance> {
  const cls = rx(r).cls.get(classId);
  const out: Record<string, ItemInstance> = {};
  for (const [slot, baseId] of Object.entries(cls?.startingGear ?? {})) out[slot] = { id: `${slot}_${baseId}`, baseId, level: 1, rarityId: r.rarities[0]!.id, affixes: [], qty: 1 };
  return out;
}

export function CharacterCreate({ me, worldId, joinInstanceId }: { me: Me; worldId: string; joinInstanceId?: string }) {
  const [setup, setSetup] = useState<WorldSetup | null>(null);
  const [error, setError] = useState('');
  const [party, setParty] = useState<Draft[]>([]);
  const [idx, setIdx] = useState(0);
  const [saveName, setSaveName] = useState('');
  const [difficulty, setDifficulty] = useState<DifficultyId>('normal');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let clear = () => {};
    api.setup(worldId).then((s) => {
      setRules(s.ruleset);
      clear = applyWorldTheme({ concept: s.concept, ruleset: s.ruleset });
      setSetup(s);
      setDifficulty(s.difficulty);
      setParty([newDraft(s, 0)]);
    }, (e) => setError(e.message));
    return () => clear();
  }, [worldId]);

  const maxParty = setup?.combatMode === 'party_manual' ? 4 : 1;
  const d = party[idx];
  const r = setup?.ruleset;

  const update = (patch: Partial<Draft>) => setParty((p) => p.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  const preview = useMemo(() => {
    if (!r || !d) return null;
    const equipment = starterGear(r, d.classId);
    return { equipment, stats: characterStats(r, { classId: d.classId, kinId: d.kinId, level: 1, tree: {}, equipment, statuses: [] }, { solo: party.length <= 1 }) };
  }, [r, d?.classId, d?.kinId, party.length]);

  if (!setup || !d || !r || !preview) return <div className="page"><Backdrop /><TopBar me={me} /><div className="page-inner">{error ? <div className="error-text">{error}</div> : <div className="spinner" />}</div></div>;

  const ix = rx(r);
  const t = r.terminology;
  const cls = ix.cls.get(d.classId)!;
  const kin = ix.kin.get(d.kinId);
  const look = setup.origins.find((o) => o.id === d.classId);
  const sprite = look?.asset && setup.assets[look.asset] ? `/api/worlds/${worldId}/assets/${setup.assets[look.asset]}` : undefined;
  const st = preview.stats;
  const start = async () => {
    setBusy(true);
    setError('');
    const specs: CharSpec[] = party.map(({ name, classId, kinId, presentation, pronouns, colors }) => ({ name: name.trim(), classId, kinId, presentation, pronouns: pronouns.trim() || PRONOUNS[presentation], colors }));
    try {
      if (joinInstanceId) {
        await api.joinInstance(joinInstanceId, specs);
        navigate(`#/play/${joinInstanceId}`);
      } else {
        const { instanceId } = await api.createInstance(worldId, saveName, specs, difficulty);
        navigate(`#/play/${instanceId}`);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const attrTotal = (id: string) => r.attributeBase + (cls.attributes[id] ?? 0) + (kin?.attributes[id] ?? 0);

  return (
    <div className="page">
      <Backdrop palette={setup.concept.palette} />
      <TopBar me={me} />
      <div className="page-inner">
        <h1 className="h1">{setup.concept.title}</h1>
        <p className="lede">{setup.concept.pitch}</p>
        <p className="serif muted" style={{ fontSize: 16, marginTop: -6 }}>You are {setup.concept.playerRole.replace(/^(A|An|The) /, (m) => m.toLowerCase()).replace(/\.$/, '')}.</p>

        {maxParty > 1 && (
          <div className="row" style={{ marginTop: 14 }}>
            {party.map((p, i) => (
              <button key={i} className={`btn ${i === idx ? 'primary' : ''}`} onClick={() => setIdx(i)}>{p.name || `Hero ${i + 1}`}<span className="tiny" style={{ opacity: 0.7, marginLeft: 6 }}>{ix.cls.get(p.classId)?.name}</span></button>
            ))}
            {party.length < maxParty && (
              <button className="btn" onClick={() => { setParty((p) => [...p, newDraft(setup, p.length)]); setIdx(party.length); }}>+ Add {t.party.toLowerCase()} member</button>
            )}
            {party.length > 1 && <button className="btn ghost sm" onClick={() => { setParty((p) => p.filter((_, i) => i !== idx)); setIdx(0); }}>Remove</button>}
          </div>
        )}

        <div className="row create-layout" style={{ marginTop: 16, alignItems: 'flex-start', gap: 18 }}>
          <div className="panel ornate" style={{ width: 300, flex: 'none' }}>
            <div className="panel-body col" style={{ alignItems: 'center' }}>
              <div className="hero-stage">
                <Portrait full size={210} sprite={sprite} colors={d.colors} archetype={cls.aiRole} weapon={weaponVisual({ equipment: preview.equipment })} seed={d.name + d.classId} />
              </div>
              <input className="input" style={{ width: '100%', textAlign: 'center', fontSize: 18 }} value={d.name} maxLength={24} onChange={(e) => update({ name: e.target.value })} />
              <div className="seg" style={{ width: '100%' }}>
                {(['feminine', 'masculine', 'androgynous'] as const).map((p) => (
                  <button key={p} className={`btn sm ${d.presentation === p ? 'primary' : 'ghost'}`} onClick={() => update({ presentation: p, pronouns: Object.values(PRONOUNS).includes(d.pronouns) ? PRONOUNS[p] : d.pronouns })}>{{ feminine: 'Feminine', masculine: 'Masculine', androgynous: 'Androgynous' }[p]}</button>
                ))}
              </div>
              <div className="field" style={{ width: '100%' }}>
                <label>Pronouns</label>
                <input className="input" value={d.pronouns} maxLength={24} onChange={(e) => update({ pronouns: e.target.value })} placeholder="they/them" />
              </div>
              {!sprite && (
                <div className="row" style={{ gap: 6 }}>
                  {PALETTES.map((p) => (
                    <div key={p.join()} onClick={() => update({ colors: p })} className={`swatch-btn ${d.colors[0] === p[0] ? 'on' : ''}`} style={{ background: `linear-gradient(135deg, ${p[0]}, ${p[1]})` }} />
                  ))}
                </div>
              )}
              <div className="ornament" style={{ width: '100%' }} />
              <div className="label" style={{ alignSelf: 'flex-start' }}>At {t.level.toLowerCase()} 1</div>
              <div className="kv" style={{ width: '100%' }}>
                <span>{r.health.name}</span><span className="v">{st.maxHp}</span>
                {r.pools.map((p) => <span key={p.id} style={{ display: 'contents' }}><span>{p.name}</span><span className="v">{st.pools[p.id]?.max ?? 0}</span></span>)}
                <span>Weapon</span><span className="v">{Math.round(st.weapon.min)}–{Math.round(st.weapon.max)}{st.weapon.melee ? '' : ` · range ${Math.round(st.weapon.range)}`}</span>
                <span>{t.actionPoints}</span><span className="v">{st.apPerTurn} per turn</span>
              </div>
              <div style={{ width: '100%', marginTop: 6 }}>
                {r.attributes.map((a) => (
                  <div className="attr" key={a.id} {...tip(<div><div className="tname gold">{a.name}</div><div className="tdesc" style={{ marginTop: 0 }}>{a.description}</div>{a.perPoint.map((m, i) => <div key={i} className="tline">{modifierLabel(r, m, 1)} per point</div>)}</div>)}>
                    <span className="n">{a.name}{cls.primaryAttributes.includes(a.id) && <span className="badge gray" style={{ marginLeft: 6 }}>key</span>}</span>
                    <span className="val">{attrTotal(a.id)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="col grow" style={{ gap: 18, minWidth: 0 }}>
            <div className="panel ornate">
              <div className="panel-head"><h3>Calling</h3><span className="muted small">{r.classes.length} classes</span></div>
              <div className="panel-body">
                <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                  {r.classes.map((c) => (
                    <div key={c.id} className={`choice ${d.classId === c.id ? 'on' : ''}`} onClick={() => update({ classId: c.id })}>
                      <div className="row" style={{ gap: 6 }}>
                        <div className="t grow">{c.name}</div>
                        <span className="badge gray">{c.role}</span>
                      </div>
                      <div className="d">{c.description}</div>
                      <div className="row" style={{ gap: 4, marginTop: 6 }}>
                        {c.startingSkills.map((s) => (
                          <span key={s} {...tip(<SkillTooltip id={s} r={r} />)}><SkillIcon id={s} size={28} /></span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="ornament" />
                <div className="label">{cls.name} branches</div>
                <div className="row wrap" style={{ gap: 10 }}>
                  {cls.branches.map((b) => (
                    <div key={b.id} className="branch-chip" {...tip(<div><div className="tname gold">{b.name}</div><div className="tdesc" style={{ marginTop: 0 }}>{b.description}</div><div className="tsub">{cls.nodes.filter((n) => n.branch === b.id && n.kind === 'skill').map((n) => ix.skill.get(n.skillId ?? '')?.name).filter(Boolean).join(' · ')}</div></div>)}>
                      <b>{b.name}</b>
                      <span className="tiny muted">{b.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {r.kins.length > 1 && (
              <div className="panel ornate">
                <div className="panel-head"><h3>Kin</h3></div>
                <div className="panel-body">
                  <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                    {r.kins.map((k) => (
                      <div key={k.id} className={`choice ${d.kinId === k.id ? 'on' : ''}`} onClick={() => update({ kinId: k.id })}>
                        <div className="t">{k.name}</div>
                        <div className="d">{k.description}</div>
                        <div className="tiny dim" style={{ marginTop: 4 }}>
                          {[...Object.entries(k.attributes).filter(([, v]) => v).map(([a, v]) => `${v > 0 ? '+' : ''}${v} ${ix.attr.get(a)?.name ?? a}`), ...k.modifiers.map((m) => modifierLabel(r, m, 1))].join(' · ')}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {!joinInstanceId && (
              <div className="panel ornate">
                <div className="panel-head"><h3>Difficulty</h3><span className="muted small">changeable later from the menu</span></div>
                <div className="panel-body col">
                  <div className="seg">
                    {DIFFICULTIES.map((x) => (
                      <button key={x} className={`btn sm ${difficulty === x ? 'primary' : 'ghost'}`} onClick={() => setDifficulty(x)}>{r.difficulty[x].name}</button>
                    ))}
                  </div>
                  <div className="hint">{DIFFICULTY_TEXT[difficulty]}</div>
                </div>
              </div>
            )}
            <div className="panel panel-body row">
              {!joinInstanceId && (
                <div className="field grow">
                  <label>Name this journey</label>
                  <input className="input" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={`${party[0]?.name}’s journey`} />
                </div>
              )}
              <div className="spacer" />
              {error && <div className="error-text">{error}</div>}
              <button className="btn ghost" onClick={() => navigate(`#/world/${worldId}`)}>Back</button>
              <button className="btn primary lg" disabled={busy || party.some((p) => !p.name.trim())} onClick={start}>{joinInstanceId ? 'Join' : 'Enter the world'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const DIFFICULTY_TEXT: Record<DifficultyId, string> = {
  story: 'For the tale: foes are gentle and mistakes are forgiven.',
  easy: 'A relaxed adventure with room to experiment.',
  normal: 'The intended balance: fights are winnable but cost something.',
  hard: 'Tougher, more numerous foes. Tactics and preparation matter.',
  brutal: 'Merciless. Every fight is a puzzle; expect to fall.',
};

function newDraft(s: WorldSetup, i: number): Draft {
  const r = s.ruleset;
  const presentation: Presentation = (['feminine', 'masculine', 'androgynous'] as const)[(i + s.id.length) % 2]!;
  return {
    name: NAMES[(i * 3 + s.id.length) % NAMES.length]!,
    classId: r.classes[i % r.classes.length]!.id,
    kinId: r.kins[0]!.id,
    presentation,
    pronouns: PRONOUNS[presentation],
    colors: PALETTES[i % PALETTES.length]!,
  };
}
