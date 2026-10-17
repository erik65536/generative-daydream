import { useEffect, useMemo, useState } from 'react';
import { ATTRIBUTES, ATTRIBUTE_INFO, STARTING_SKILL_POINTS, type AttributeId } from '@gd/shared';
import { api, type CharSpec, type Me, type WorldSetup } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';
import { navigate } from '../App';
import { Portrait, SkillIcon, tip } from '../ui/common';

const PALETTES = [
  ['#4a6a9a', '#2a3448', '#e0c060'],
  ['#8a3a32', '#3a2420', '#f0c070'],
  ['#3e6a42', '#25332a', '#c8e070'],
  ['#5a4a7a', '#2a2238', '#d0a0ff'],
  ['#8a7a5a', '#3a3428', '#f0e0b0'],
  ['#2a5a6a', '#1a2a32', '#80e0f0'],
];

const NAMES = ['Arin', 'Sela', 'Corvin', 'Mira', 'Tobin', 'Ysolde', 'Kael', 'Wren', 'Juno', 'Rook'];

interface Draft {
  name: string;
  originId: string;
  bonus: Partial<Record<AttributeId, number>>;
  skills: string[];
  colors: string[];
}

export function CharacterCreate({ me, worldId, joinInstanceId }: { me: Me; worldId: string; joinInstanceId?: string }) {
  const [setup, setSetup] = useState<WorldSetup | null>(null);
  const [error, setError] = useState('');
  const [party, setParty] = useState<Draft[]>([]);
  const [idx, setIdx] = useState(0);
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.setup(worldId).then((s) => {
      setSetup(s);
      const o = s.origins[0]!;
      setParty([newDraft(s, 0, o.id)]);
    }, (e) => setError(e.message));
  }, [worldId]);

  const maxParty = setup?.combatMode === 'party_manual' ? 4 : 1;
  const d = party[idx];
  const t = setup?.terminology;

  const update = (patch: Partial<Draft>) => setParty((p) => p.map((x, i) => (i === idx ? { ...x, ...patch } : x)));

  const origin = useMemo(() => setup?.origins.find((o) => o.id === d?.originId), [setup, d?.originId]);
  const startSkills = useMemo(() => setup?.skills.filter((s) => s.minLevel <= 1) ?? [], [setup]);

  if (!setup || !d || !t) return <div className="page"><Backdrop /><TopBar me={me} /><div className="page-inner">{error ? <div className="error-text">{error}</div> : <div className="spinner" />}</div></div>;

  const bonusUsed = Object.values(d.bonus).reduce((a, b) => a + (b ?? 0), 0);
  const start = async () => {
    setBusy(true);
    setError('');
    const specs: CharSpec[] = party.map((p) => ({ name: p.name, originId: p.originId, attributes: p.bonus as Record<string, number>, skills: p.skills, colors: p.colors }));
    try {
      if (joinInstanceId) {
        await api.joinInstance(joinInstanceId, specs);
        navigate(`#/play/${joinInstanceId}`);
      } else {
        const { instanceId } = await api.createInstance(worldId, saveName, specs);
        navigate(`#/play/${instanceId}`);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <Backdrop palette={setup.concept.palette} />
      <TopBar me={me} />
      <div className="page-inner">
        <h1 className="h1">{setup.concept.title}</h1>
        <p className="lede">{setup.concept.pitch}</p>
        <p className="serif muted" style={{ fontSize: 16, marginTop: -6 }}>You are {setup.concept.playerRole}.</p>

        {maxParty > 1 && (
          <div className="row" style={{ marginTop: 14 }}>
            {party.map((p, i) => (
              <button key={i} className={`btn ${i === idx ? 'primary' : ''}`} onClick={() => setIdx(i)}>{p.name || `Hero ${i + 1}`}</button>
            ))}
            {party.length < maxParty && (
              <button className="btn" onClick={() => { setParty((p) => [...p, newDraft(setup, p.length, setup.origins[p.length % setup.origins.length]!.id)]); setIdx(party.length); }}>+ Add {t.party.toLowerCase()} member</button>
            )}
            {party.length > 1 && <button className="btn ghost sm" onClick={() => { setParty((p) => p.filter((_, i) => i !== idx)); setIdx(0); }}>Remove</button>}
          </div>
        )}

        <div className="row" style={{ marginTop: 16, alignItems: 'flex-start', gap: 18 }}>
          <div className="panel" style={{ width: 280, flex: 'none' }}>
            <div className="panel-body col" style={{ alignItems: 'center' }}>
              <div style={{ width: 200, height: 200, borderRadius: 14, border: '1px solid var(--line)', background: 'radial-gradient(circle at 50% 35%, #2c2434, #0e0b12)', overflow: 'hidden' }}>
                <Portrait full size={200} sprite={origin?.asset ? `/api/worlds/${worldId}/assets/${setup.assets[origin.asset] ?? ''}` : undefined} colors={d.colors} archetype={origin?.template.archetype} weapon={weaponIcon(origin?.template.weapon)} seed={d.name + d.originId} />
              </div>
              <input className="input" style={{ width: '100%', textAlign: 'center', fontSize: 18 }} value={d.name} maxLength={24} onChange={(e) => update({ name: e.target.value })} />
              {!origin?.asset && (
                <div className="row" style={{ gap: 6 }}>
                  {PALETTES.map((p) => (
                    <div key={p.join()} onClick={() => update({ colors: p })} style={{ width: 22, height: 22, borderRadius: 6, cursor: 'pointer', background: `linear-gradient(135deg, ${p[0]}, ${p[1]})`, border: d.colors[0] === p[0] ? '2px solid var(--gold)' : '1px solid var(--line)' }} />
                  ))}
                </div>
              )}
              <div className="ornament" style={{ width: '100%' }} />
              <div className="label" style={{ alignSelf: 'flex-start' }}>Attributes · {3 - bonusUsed} to spend</div>
              <div style={{ width: '100%' }}>
                {ATTRIBUTES.map((a) => {
                  const base = 10 + (origin?.template.attributes[a] ?? 0);
                  const bonus = d.bonus[a] ?? 0;
                  return (
                    <div className="attr" key={a} {...tip(<div><div className="tname gold">{t.attributes[a]}</div><div>{ATTRIBUTE_INFO[a].effect}</div></div>)}>
                      <span className="n">{t.attributes[a]}</span>
                      <button className="btn sm ghost" disabled={!bonus} onClick={() => update({ bonus: { ...d.bonus, [a]: bonus - 1 } })}>−</button>
                      <span className="val">{base + bonus}</span>
                      <button className="btn sm ghost" disabled={bonusUsed >= 3} onClick={() => update({ bonus: { ...d.bonus, [a]: bonus + 1 } })}>+</button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="col grow" style={{ gap: 18 }}>
            <div className="panel">
              <div className="panel-head"><h3>Origin</h3></div>
              <div className="panel-body">
                <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                  {setup.origins.map((o) => (
                    <div key={o.id} className={`choice ${d.originId === o.id ? 'on' : ''}`} onClick={() => update({ originId: o.id, skills: o.template.suggestedSkills.filter((s) => startSkills.some((x) => x.id === s)).slice(0, STARTING_SKILL_POINTS), bonus: {} })}>
                      <div className="t">{o.name}</div>
                      <div className="d">{o.description || o.appearance}</div>
                      <div className="tiny dim" style={{ marginTop: 4 }}>{Object.entries(o.template.attributes).map(([k, v]) => `+${v} ${t.attributes[k as AttributeId]}`).join(' · ')}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="panel">
              <div className="panel-head"><h3>Starting skills</h3><span className="muted small">choose {STARTING_SKILL_POINTS}</span></div>
              <div className="panel-body">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
                  {startSkills.map((s) => {
                    const on = d.skills.includes(s.id);
                    const suggested = origin?.template.suggestedSkills.includes(s.id);
                    return (
                      <div key={s.id} className={`skill-card ${on ? 'known' : ''}`} style={{ cursor: 'pointer', borderColor: on ? 'var(--gold)' : undefined }} onClick={() => update({ skills: on ? d.skills.filter((x) => x !== s.id) : [...d.skills, s.id].slice(-STARTING_SKILL_POINTS) })}>
                        <SkillIcon id={s.id} />
                        <div className="grow">
                          <div className="sn">{s.name} {suggested && <span className="badge gray">suggested</span>}</div>
                          <div className="tiny muted">{t.schools[s.school as keyof typeof t.schools]}{s.passive ? ' · passive' : ''}</div>
                          <div className="small" style={{ marginTop: 3 }}>{s.summary}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="panel panel-body row">
              {!joinInstanceId && (
                <div className="field grow">
                  <label>Name this journey</label>
                  <input className="input" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={`${party[0]?.name}'s journey`} />
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

function newDraft(s: WorldSetup, i: number, originId: string): Draft {
  const o = s.origins.find((x) => x.id === originId)!;
  return {
    name: NAMES[(i * 3 + s.id.length) % NAMES.length]!,
    originId,
    bonus: {},
    skills: o.template.suggestedSkills.filter((id) => s.skills.some((x) => x.id === id && x.minLevel <= 1)).slice(0, STARTING_SKILL_POINTS),
    colors: PALETTES[i % PALETTES.length]!,
  };
}

export function weaponIcon(baseId?: string) {
  return baseId === 'w_bow' ? 'bow' : baseId === 'w_staff' ? 'staff' : baseId === 'w_wand' ? 'wand' : baseId === 'w_dagger' ? 'dagger' : baseId === 'w_heavy' ? 'axe' : 'sword';
}
