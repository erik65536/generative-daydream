import { useEffect, useMemo, useState } from 'react';
import { DIFFICULTIES, MAX_PARTY_SIZE, characterStats, modifierLabel, rx, type DifficultyId, type ItemInstance, type Ruleset } from '@gd/shared';
import { api, type CharSpec, type Me, type WorldSetup } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';
import { navigate } from '../App';
import { Portrait, SkillIcon, SkillTooltip, pressable, tip } from '../ui/common';
import { setRules } from '../rules';
import { loadImage } from '../render/sprites';
import { applyWorldTheme } from '../ui/theme';

const NAMES = ['Arin', 'Sela', 'Corvin', 'Mira', 'Tobin', 'Ysolde', 'Kael', 'Wren', 'Juno', 'Rook'];

type Draft = CharSpec;

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
      // Warm the image cache so switching class or kin shows art at once.
      for (const o of s.origins) for (const k of Object.values(o.assets ?? {})) if (k && s.assets[k]) loadImage(`/api/worlds/${worldId}/assets/${s.assets[k]}`);
      clear = applyWorldTheme({ concept: s.concept, ruleset: s.ruleset });
      setSetup(s);
      setDifficulty(s.difficulty);
      // A party the player controls is four heroes; otherwise one (with the world's companions, if it has them).
      setParty(Array.from({ length: s.combatMode === 'party_manual' ? MAX_PARTY_SIZE : 1 }, (_, i) => newDraft(s, i)));
    }, (e) => setError(e.message));
    return () => clear();
  }, [worldId]);

  const d = party[idx];
  const r = setup?.ruleset;

  const update = (patch: Partial<Draft>) => setParty((p) => p.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  const preview = useMemo(() => {
    if (!r || !d) return null;
    const equipment = starterGear(r, d.classId);
    // Only a hero alone gets the lone hero's strength (companions travel with the others).
    return { equipment, stats: characterStats(r, { classId: d.classId, kinId: d.kinId, level: 1, tree: {}, equipment, statuses: [] }, { solo: setup?.combatMode === 'solo' }) };
  }, [r, d?.classId, d?.kinId, setup?.combatMode]);

  if (!setup || !d || !r || !preview) return <div className="page"><Backdrop /><TopBar me={me} /><div className="page-inner">{error ? <div className="error-text">{error}</div> : <div className="spinner" />}</div></div>;

  const ix = rx(r);
  const t = r.terminology;
  const cls = ix.cls.get(d.classId)!;
  const kin = ix.kin.get(d.kinId);
  // A hero is painted for every class and kin (each kin is one gender).
  const art = (key?: string) => (key && setup.assets[key] ? `/api/worlds/${worldId}/assets/${setup.assets[key]}` : undefined);
  const sprite = art(setup.origins.find((o) => o.id === d.classId)?.assets?.[d.kinId]);
  const st = preview.stats;
  const start = async () => {
    setBusy(true);
    setError('');
    const specs: CharSpec[] = party.map(({ name, classId, kinId }) => ({ name: name.trim(), classId, kinId }));
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
        <p className="serif muted" style={{ fontSize: 16, marginTop: -6 }}>You are {setup.concept.playerRole.replace(/^you are\s+/i, '').replace(/^(A|An|The) /, (m) => m.toLowerCase()).replace(/\.$/, '')}.</p>

        {party.length > 1 && (
          <div className="row wrap" style={{ marginTop: 14 }}>
            {party.map((p, i) => (
              <button key={i} className={`btn ${i === idx ? 'primary' : ''}`} onClick={() => setIdx(i)}>{p.name || `Hero ${i + 1}`}<span className="tiny" style={{ opacity: 0.7, marginLeft: 6 }}>{ix.cls.get(p.classId)?.name}</span></button>
            ))}
          </div>
        )}
        {!!setup.companions.length && (
          <div className="panel panel-body row wrap" style={{ marginTop: 14, gap: 14 }}>
            <div className="label" style={{ width: '100%' }}>Travelling with you</div>
            {setup.companions.map((c) => (
              <div key={c.id} className="row" style={{ gap: 10 }}>
                <Portrait size={56} sprite={art(c.asset)} />
                <div className="col" style={{ gap: 2 }}>
                  <b>{c.name}</b>
                  <span className="tiny muted">{c.title} · {ix.kin.get(c.kinId)?.name} {ix.cls.get(c.classId)?.name}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="row create-layout" style={{ marginTop: 16, alignItems: 'flex-start', gap: 18 }}>
          <div className="panel ornate" style={{ width: 300, flex: 'none' }}>
            <div className="panel-body col" style={{ alignItems: 'center' }}>
              <div className="hero-stage">
                <Portrait full size={210} sprite={sprite} />
              </div>
              <div className="field" style={{ width: '100%' }}>
                <label>{idx === 0 ? 'Your name' : 'Their name'}</label>
                <input className="input" style={{ width: '100%', textAlign: 'center', fontSize: 18 }} value={d.name} maxLength={24} placeholder="Type a name" autoFocus={idx === 0} onChange={(e) => update({ name: e.target.value })} />
              </div>
              <div className="tiny muted">{kin?.name} {cls.name}</div>
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
              <div className="panel-head"><h3>{t.calling}</h3><span className="muted small">{r.classes.length} classes</span></div>
              <div className="panel-body">
                <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                  {r.classes.map((c) => (
                    <div key={c.id} className={`choice ${d.classId === c.id ? 'on' : ''}`} {...pressable(() => update({ classId: c.id }))}>
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
                <div className="panel-head"><h3>{t.kin}</h3></div>
                <div className="panel-body">
                  <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                    {r.kins.map((k) => (
                      <div key={k.id} className={`choice ${d.kinId === k.id ? 'on' : ''}`} {...pressable(() => update({ kinId: k.id }))}>
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
                  <label>Name this reverie</label>
                  <input className="input" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={party[0]?.name.trim() ? `${party[0].name.trim()}’s reverie` : 'A new reverie'} />
                </div>
              )}
              <div className="spacer" />
              {error && <div className="error-text">{error}</div>}
              <button className="btn ghost" onClick={() => navigate(`#/world/${worldId}`)}>Back</button>
              <button className="btn primary lg" disabled={busy || party.some((p) => !p.name.trim())} onClick={start}>{joinInstanceId ? 'Join' : 'Enter the daydream'}</button>
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
  return {
    // The player names their own hero; the others of a party they control start with a name to change.
    name: i === 0 ? '' : NAMES[(i * 3 + s.id.length) % NAMES.length]!,
    classId: r.classes[i % r.classes.length]!.id,
    kinId: r.kins[i % r.kins.length]!.id,
  };
}
