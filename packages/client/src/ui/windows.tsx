import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ATTRIBUTES, ATTRIBUTE_INFO, EQUIP_SLOTS, ITEM_BASE, RECIPES, SKILLS, SCHOOLS, getSkill, itemName, itemPrice, skillName, xpForLevel,
  type AttributeId, type EquipSlot, type ItemInstance, type QuestDef, type QuestObjective,
} from '@gd/shared';
import { client, useGame } from '../net/game';
import { ItemIcon, ItemTooltip, Portrait, SkillIcon, SkillTooltip, Window, hideTip, tip } from './common';
import { navigate } from '../App';

const iconUrl = (baseId: string) => client().assetUrl(`icon_${baseId}`);

function ItemCell({ item, onClick, onContext, selected, price }: { item: ItemInstance; onClick?: (e: React.MouseEvent) => void; onContext?: (e: React.MouseEvent) => void; selected?: boolean; price?: number }) {
  const c = client();
  const naming = c.naming()!;
  const base = ITEM_BASE[item.baseId];
  return (
    <div
      className={`item r-${item.rarity} ${base?.category === 'quest' || item.uniqueId ? 'quest' : ''} ${selected ? 'sel' : ''}`}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext?.(e);
      }}
      {...tip(<ItemTooltip item={item} ctx={naming} price={price} />)}
    >
      <ItemIcon item={item} url={iconUrl(item.baseId)} />
      {item.qty > 1 && <span className="qty">{item.qty}</span>}
      {price !== undefined && <span className="qty" style={{ color: '#ffe08a', left: 3, right: 'auto', fontSize: 10 }}>{price}</span>}
    </div>
  );
}

// =================================================================================== dialog

export function DialogWindow() {
  const { dialog, player, world } = useGame((s) => ({ dialog: s.dialog, player: s.player, world: s.world }));
  const c = client();
  const [text, setText] = useState('');
  const [give, setGive] = useState('');
  const [gold, setGold] = useState(0);
  const [skill, setSkill] = useState('');
  const msgsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: 'smooth' });
  }, [dialog?.messages.length, dialog?.thinking]);
  useEffect(() => {
    inputRef.current?.focus();
  }, [dialog?.npcId, dialog?.thinking]);
  if (!dialog || !player || !world) return null;
  const naming = c.naming()!;
  const leader = player.party.find((x) => x.id === player.leaderId) ?? player.party[0]!;
  const send = (t?: string) => {
    const msg = (t ?? text).trim();
    if (!msg && !give && !gold && !skill) return;
    c.send({ t: 'talk', npcId: dialog.npcId, text: msg, giveItemId: give || undefined, giveGold: gold || undefined, useSkillId: skill || undefined });
    setText('');
    setGive('');
    setGold(0);
    setSkill('');
  };
  const close = () => c.send({ t: 'end_dialog' });
  const disp = dialog.disposition;
  const dispLabel = disp > 60 ? 'Devoted' : disp > 25 ? 'Friendly' : disp > -10 ? 'Neutral' : disp > -40 ? 'Wary' : 'Hostile';
  const giftable = player.inventory.filter((i) => !ITEM_BASE[i.baseId]?.slot || true);
  const actives = leader.skills.filter((s) => !SKILLS[s]?.passive);
  return (
    <div className="window panel dialog" onMouseDown={(e) => e.stopPropagation()}>
      <div className="npc-head">
        <div className="npc-portrait">
          <Portrait size={72} sprite={c.assetUrl(dialog.sprite)} colors={dialog.colors} seed={dialog.npcId} kind="npc" />
        </div>
        <div className="grow">
          <div className="display gold" style={{ fontSize: 18 }}>{dialog.npcName}</div>
          <div className="serif muted" style={{ fontSize: 15, fontStyle: 'italic' }}>{dialog.npcTitle}</div>
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <div style={{ width: 90, height: 5, borderRadius: 3, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
              <div style={{ width: `${(disp + 100) / 2}%`, height: '100%', background: disp >= 0 ? 'linear-gradient(90deg,#8a7a40,#9fe07a)' : 'linear-gradient(90deg,#e0604a,#8a5a40)' }} />
            </div>
            <span className="tiny muted">{dispLabel}</span>
          </div>
        </div>
        <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={close} title="Leave (Esc)">✕</button>
      </div>
      <div className="msgs" ref={msgsRef}>
        {dialog.messages.map((m, i) => (
          <div key={i} className={`msg ${m.speaker}`}>
            {m.speaker === 'npc' && <span className="who">{dialog.npcName}{m.emotion && m.emotion !== 'neutral' ? ` · ${m.emotion}` : ''}</span>}
            {m.text}
          </div>
        ))}
        {dialog.thinking && (
          <div className="thinking">
            <span /><span /><span />
          </div>
        )}
      </div>
      <div className="compose">
        {!dialog.thinking && !dialog.ended && (
          <div className="suggest">
            {dialog.suggestions.map((s) => (
              <span key={s} className="chip" onClick={() => (s === 'Farewell.' ? close() : send(s))}>{s}</span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="input"
          rows={2}
          style={{ minHeight: 0 }}
          placeholder={dialog.ended ? 'The conversation is over.' : `Say anything to ${dialog.npcName.split(' ')[0]}…`}
          value={text}
          disabled={dialog.thinking || dialog.ended}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            if (e.key === 'Escape') close();
          }}
        />
        <div className="attach">
          <select className="input" style={{ padding: '5px 8px', maxWidth: 150 }} value={give} onChange={(e) => setGive(e.target.value)}>
            <option value="">Give item…</option>
            {giftable.map((i) => (
              <option key={i.id} value={i.id}>{itemName(naming, i)}{i.qty > 1 ? ` ×${i.qty}` : ''}</option>
            ))}
          </select>
          <input className="input" type="number" min={0} max={player.gold} style={{ width: 80, padding: '5px 8px' }} value={gold || ''} placeholder={world.terminology.gold} onChange={(e) => setGold(Math.max(0, Math.min(player.gold, Number(e.target.value))))} />
          <select className="input" style={{ padding: '5px 8px', maxWidth: 140 }} value={skill} onChange={(e) => setSkill(e.target.value)}>
            <option value="">Use skill…</option>
            {actives.map((s) => (
              <option key={s} value={s}>{skillName(naming, s)}</option>
            ))}
          </select>
          <div className="spacer" />
          <button className="btn primary sm" disabled={dialog.thinking || dialog.ended} onClick={() => send()}>Say</button>
        </div>
        <div className="row">
          {dialog.canTrade && <button className="btn sm" onClick={() => send('Show me your wares.')}>Trade</button>}
          <div className="spacer" />
          <button className="btn sm ghost" onClick={close}>Leave</button>
        </div>
      </div>
    </div>
  );
}

// =================================================================================== inventory

const SLOT_LABEL: Record<EquipSlot, string> = { mainhand: 'Weapon', offhand: 'Off-hand', head: 'Head', chest: 'Body', hands: 'Hands', feet: 'Feet', ring: 'Ring', amulet: 'Neck' };

export function InventoryWindow({ onClose }: { onClose: () => void }) {
  const { player, selected, trade, world, combat } = useGame((s) => ({ player: s.player, selected: s.selectedCharId, trade: s.trade, world: s.world, combat: s.combat }));
  const c = client();
  const [filter, setFilter] = useState<'all' | 'gear' | 'use' | 'mat' | 'quest'>('all');
  const [menu, setMenu] = useState<{ x: number; y: number; item: ItemInstance } | null>(null);
  if (!player || !world) return null;
  const naming = c.naming()!;
  const ch = player.party.find((x) => x.id === selected) ?? player.party[0]!;
  const items = player.inventory.filter((i) => {
    const b = ITEM_BASE[i.baseId];
    if (!b) return false;
    if (filter === 'gear') return !!b.slot;
    if (filter === 'use') return b.category === 'consumable' || b.category === 'tool';
    if (filter === 'mat') return b.category === 'material' || b.category === 'valuable';
    if (filter === 'quest') return b.category === 'quest' || b.category === 'key' || !!i.uniqueId;
    return true;
  });
  const primary = (item: ItemInstance) => {
    const b = ITEM_BASE[item.baseId];
    if (trade) return c.send({ t: 'sell', npcId: trade.npcId, itemId: item.id, qty: 1 });
    if (b?.slot) return c.send({ t: 'equip', charId: ch.id, itemId: item.id });
    if (b?.consumable) {
      if (b.consumable.kind === 'bomb') {
        c.update({ targeting: { charId: ch.id, itemId: item.id }, panel: null });
        return;
      }
      c.send({ t: 'use_item', charId: ch.id, itemId: item.id, targetId: ch.id });
    }
  };
  const stats = c.charStats(ch);
  return (
    <Window title={trade ? 'Your pack — click to sell' : 'Inventory'} onClose={onClose} style={{ left: trade ? 700 : 260, top: 70, width: 640 }}>
      <div className="tabs">
        {player.party.map((p) => (
          <div key={p.id} className={`tab ${p.id === ch.id ? 'on' : ''}`} onClick={() => c.update({ selectedCharId: p.id })}>{p.name}</div>
        ))}
        <div className="spacer" />
        <div className="tab gold" style={{ cursor: 'default' }}>{player.gold} {world.terminology.gold}</div>
      </div>
      <div className="panel-body row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <div className="col" style={{ width: 270, flex: 'none' }}>
          <div className="equip">
            {EQUIP_SLOTS.map((slot) => {
              const it = ch.equipment[slot];
              return (
                <div className="slotbox" key={slot}>
                  {it ? (
                    <ItemCell item={it} onClick={() => !combat && c.send({ t: 'unequip', charId: ch.id, slot })} />
                  ) : (
                    <div className="item" style={{ opacity: 0.35 }} />
                  )}
                  <span>{SLOT_LABEL[slot]}</span>
                </div>
              );
            })}
          </div>
          <div className="kv" style={{ marginTop: 8 }}>
            <span>Damage</span><span className="v">{stats.weaponMin}–{stats.weaponMax} {world.terminology.damageTypes[stats.weaponType]}</span>
            <span>{world.terminology.physArmor}</span><span className="v">{stats.maxPhys}</span>
            <span>{world.terminology.magArmor}</span><span className="v">{stats.maxMag}</span>
            <span>{world.terminology.health}</span><span className="v">{stats.maxHp}</span>
            <span>Critical</span><span className="v">{stats.critChance}%</span>
          </div>
          <div className="hint">Click equipped items to remove them. Right-click inventory items for options.</div>
        </div>
        <div className="grow col">
          <div className="row" style={{ gap: 4 }}>
            {(['all', 'gear', 'use', 'mat', 'quest'] as const).map((f) => (
              <span key={f} className="chip" style={filter === f ? { borderColor: 'var(--gold)', color: 'var(--gold-2)' } : undefined} onClick={() => setFilter(f)}>
                {{ all: 'All', gear: 'Gear', use: 'Usable', mat: 'Materials', quest: 'Story' }[f]}
              </span>
            ))}
          </div>
          <div className="items" style={{ maxHeight: 420, overflow: 'auto' }}>
            {items.map((it) => (
              <ItemCell key={it.id} item={it} price={trade ? Math.max(1, Math.round(itemPrice({ ...it, qty: 1 }) * trade.sellMult)) : undefined} onClick={() => primary(it)} onContext={(e) => setMenu({ x: e.clientX, y: e.clientY, item: it })} />
            ))}
            {!items.length && <div className="muted small">Nothing here.</div>}
          </div>
        </div>
      </div>
      {menu && (
        <div className="ctx panel" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          <div className="menu-list">
            <div className="tiny muted" style={{ padding: '2px 8px' }}>{itemName(naming, menu.item)}</div>
            {ITEM_BASE[menu.item.baseId]?.slot && player.party.map((p) => (
              <button key={p.id} className="btn sm ghost" onClick={() => { c.send({ t: 'equip', charId: p.id, itemId: menu.item.id }); setMenu(null); hideTip(); }}>Equip on {p.name}</button>
            ))}
            {ITEM_BASE[menu.item.baseId]?.consumable && player.party.map((p) => (
              <button key={p.id} className="btn sm ghost" onClick={() => { primaryFor(p.id, menu.item); setMenu(null); }}>Use on {p.name}</button>
            ))}
            {trade && <button className="btn sm ghost" onClick={() => { c.send({ t: 'sell', npcId: trade.npcId, itemId: menu.item.id, qty: menu.item.qty }); setMenu(null); }}>Sell all</button>}
            {!menu.item.bound && <button className="btn sm ghost" onClick={() => { c.send({ t: 'drop_item', itemId: menu.item.id }); setMenu(null); hideTip(); }}>Drop</button>}
          </div>
        </div>
      )}
    </Window>
  );
}

function primaryFor(charId: string, item: ItemInstance) {
  const c = client();
  const b = ITEM_BASE[item.baseId];
  if (b?.consumable?.kind === 'bomb') c.update({ targeting: { charId, itemId: item.id }, panel: null });
  else c.send({ t: 'use_item', charId, itemId: item.id, targetId: charId });
}

// =================================================================================== trade

export function TradeWindow() {
  const { trade, player, world } = useGame((s) => ({ trade: s.trade, player: s.player, world: s.world }));
  const c = client();
  if (!trade || !player || !world) return null;
  return (
    <Window title={`${trade.npcName}'s wares`} onClose={() => c.send({ t: 'end_trade' })} style={{ left: 260, top: 70, width: 420 }}>
      <div className="panel-body col">
        <div className="row small">
          <span className="muted">They have {trade.npcGold} {world.terminology.gold}</span>
          <div className="spacer" />
          <span className="gold">You have {player.gold} {world.terminology.gold}</span>
        </div>
        <div className="items" style={{ maxHeight: 420, overflow: 'auto' }}>
          {trade.stock.map((it) => (
            <ItemCell key={it.id} item={it} price={it.price} onClick={(e) => c.send({ t: 'buy', npcId: trade.npcId, itemId: it.id, qty: e.shiftKey ? it.qty : 1 })} />
          ))}
        </div>
        <div className="hint">Click to buy (Shift-click for the whole stack). Open your inventory (I) and click items to sell.</div>
      </div>
    </Window>
  );
}

// =================================================================================== loot

export function LootWindow() {
  const { loot, world } = useGame((s) => ({ loot: s.loot, world: s.world }));
  const c = client();
  if (!loot || !world) return null;
  const naming = c.naming()!;
  const close = () => c.send({ t: 'close_loot' });
  return (
    <Window title={loot.label} onClose={close} style={{ left: '50%', top: '30%', width: 320, transform: 'translateX(-50%)' }}>
      <div className="panel-body col">
        {loot.gold > 0 && (
          <div className="row" style={{ cursor: 'pointer' }} onClick={() => c.send({ t: 'take_loot', sourceId: loot.id, itemId: 'gold' })}>
            <span className="gold" style={{ fontSize: 16 }}>◉</span> {loot.gold} {world.terminology.gold}
          </div>
        )}
        {loot.items.map((it) => (
          <div key={it.id} className="row" style={{ cursor: 'pointer' }} onClick={() => c.send({ t: 'take_loot', sourceId: loot.id, itemId: it.id })}>
            <ItemCell item={it} />
            <div className="grow small">{itemName(naming, it)}{it.qty > 1 ? ` ×${it.qty}` : ''}</div>
          </div>
        ))}
        {!loot.items.length && !loot.gold && <div className="muted small">Empty.</div>}
        <div className="row">
          <div className="spacer" />
          <button className="btn primary" autoFocus onClick={() => c.send({ t: 'take_loot', sourceId: loot.id, all: true })}>Take all</button>
        </div>
      </div>
    </Window>
  );
}

// =================================================================================== character

export function CharacterWindow({ onClose }: { onClose: () => void }) {
  const { player, selected, world } = useGame((s) => ({ player: s.player, selected: s.selectedCharId, world: s.world }));
  const c = client();
  if (!player || !world) return null;
  const t = world.terminology;
  const ch = player.party.find((x) => x.id === selected) ?? player.party[0]!;
  const s = c.charStats(ch);
  const origin = world.origins.find((o) => o.id === ch.originId);
  return (
    <Window title="Character" onClose={onClose} style={{ left: 260, top: 70, width: 560 }}>
      <div className="tabs">
        {player.party.map((p) => (
          <div key={p.id} className={`tab ${p.id === ch.id ? 'on' : ''}`} onClick={() => c.update({ selectedCharId: p.id })}>{p.name}{p.unspentAttributes ? ' •' : ''}</div>
        ))}
      </div>
      <div className="panel-body row" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div className="col" style={{ width: 230 }}>
          <div className="display gold" style={{ fontSize: 20 }}>{ch.name}</div>
          <div className="muted">{t.level} {ch.level} {origin?.name}{ch.npcId ? ' (companion)' : ''}</div>
          <div className="small dim">{t.xp}: {ch.xp} / {xpForLevel(ch.level + 1)}</div>
          <div className="ornament" />
          <div className="label">{ch.unspentAttributes ? `${ch.unspentAttributes} points to spend` : 'Attributes'}</div>
          {ATTRIBUTES.map((a) => (
            <div key={a} className="attr" {...tip(<div><div className="tname gold">{t.attributes[a]}</div>{ATTRIBUTE_INFO[a].effect}</div>)}>
              <span className="n">{t.attributes[a]}</span>
              <span className="val">{s.attributes[a]}</span>
              <button className="btn sm ghost" disabled={!ch.unspentAttributes} onClick={() => c.send({ t: 'allocate', charId: ch.id, attribute: a })}>+</button>
            </div>
          ))}
        </div>
        <div className="grow">
          <div className="kv">
            <span>{t.health}</span><span className="v">{Math.round(ch.hp)} / {s.maxHp}</span>
            <span>{t.physArmor}</span><span className="v">{Math.round(ch.physArmor)} / {s.maxPhys}</span>
            <span>{t.magArmor}</span><span className="v">{Math.round(ch.magArmor)} / {s.maxMag}</span>
            <span>{t.stamina}</span><span className="v">{Math.round(ch.stamina)} / {s.maxStamina}</span>
            {world.systems.dualEnergy && <><span>{t.focus}</span><span className="v">{Math.round(ch.focus)} / {s.maxFocus}</span></>}
            <span>Weapon damage</span><span className="v">{s.weaponMin}–{s.weaponMax}</span>
            <span>Damage type</span><span className="v">{t.damageTypes[s.weaponType]}</span>
            <span>Range</span><span className="v">{s.weaponRange > 2 ? s.weaponRange : 'Melee'}</span>
            <span>Critical chance</span><span className="v">{s.critChance}%</span>
            <span>Critical damage</span><span className="v">{Math.round(s.critMult * 100)}%</span>
            <span>Evasion</span><span className="v">{s.evasion}%</span>
            <span>Initiative</span><span className="v">{s.initiative}</span>
            <span>{t.actionPoints} per turn</span><span className="v">{s.apPerTurn}</span>
            <span>Movement per AP</span><span className="v">{s.tilesPerAp.toFixed(1)} tiles</span>
            {s.damagePct ? <><span>Bonus damage</span><span className="v">+{s.damagePct}%</span></> : null}
            {s.lifesteal ? <><span>Lifesteal</span><span className="v">{s.lifesteal}%</span></> : null}
            {Object.entries(s.resist).filter(([, v]) => v).map(([k, v]) => <><span key={k}>{t.damageTypes[k as keyof typeof t.damageTypes]} resistance</span><span className="v">{v}%</span></>)}
          </div>
          {player.loneWolf && <div className="hint" style={{ marginTop: 10 }}>Travelling alone: bonus {t.health.toLowerCase()}, armor and {t.actionPoints.toLowerCase()}.</div>}
        </div>
      </div>
    </Window>
  );
}

// =================================================================================== skills

export function SkillsWindow({ onClose }: { onClose: () => void }) {
  const { player, selected, world } = useGame((s) => ({ player: s.player, selected: s.selectedCharId, world: s.world }));
  const c = client();
  const [pick, setPick] = useState<string | null>(null);
  if (!player || !world) return null;
  const t = world.terminology;
  const naming = c.naming()!;
  const ch = player.party.find((x) => x.id === selected) ?? player.party[0]!;
  const enabled = Object.keys(world.skills);
  const assign = (slot: number) => {
    if (!pick) return;
    const hb = Array.from({ length: 10 }, (_, i) => ch.hotbar[i] ?? null);
    const existing = hb.indexOf(pick);
    if (existing >= 0) hb[existing] = null;
    hb[slot] = pick;
    c.send({ t: 'set_hotbar', charId: ch.id, hotbar: hb });
    setPick(null);
  };
  return (
    <Window title="Skills" onClose={onClose} style={{ left: 260, top: 70, width: 720 }}>
      <div className="tabs">
        {player.party.map((p) => (
          <div key={p.id} className={`tab ${p.id === ch.id ? 'on' : ''}`} onClick={() => c.update({ selectedCharId: p.id })}>{p.name}{p.unspentSkillPoints ? ' •' : ''}</div>
        ))}
        <div className="spacer" />
        <div className="tab gold" style={{ cursor: 'default' }}>{ch.unspentSkillPoints} skill point{ch.unspentSkillPoints === 1 ? '' : 's'}</div>
      </div>
      <div className="panel-body col">
        <div className="label">Hotbar {pick ? '— click a slot to place the selected skill' : '— click a known skill, then a slot'}</div>
        <div className="row" style={{ gap: 5 }}>
          {Array.from({ length: 10 }, (_, i) => {
            const id = ch.hotbar[i];
            return (
              <div key={i} className={`slot ${pick ? 'on' : ''}`} onClick={() => (pick ? assign(i) : id && c.send({ t: 'set_hotbar', charId: ch.id, hotbar: ch.hotbar.map((x, j) => (j === i ? null : x)) }))} {...tip(id ? <SkillTooltip id={id} ctx={naming} terms={t} /> : 'Empty')}>
                <span className="key">{(i + 1) % 10}</span>
                {id && <SkillIcon id={id} />}
              </div>
            );
          })}
        </div>
        <div className="ornament" />
        {SCHOOLS.map((school) => {
          const list = enabled.filter((id) => SKILLS[id]?.school === school);
          if (!list.length) return null;
          return (
            <div key={school}>
              <div className="label" style={{ margin: '6px 0' }}>{t.schools[school]}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 6 }}>
                {list.map((id) => {
                  const s = SKILLS[id]!;
                  const known = ch.skills.includes(id);
                  const canLearn = !known && ch.unspentSkillPoints > 0 && s.minLevel <= ch.level;
                  return (
                    <div key={id} className={`skill-card ${known ? 'known' : ''}`} style={{ opacity: known || s.minLevel <= ch.level ? 1 : 0.5, cursor: known && !s.passive ? 'pointer' : 'default', borderColor: pick === id ? 'var(--gold)' : undefined }} onClick={() => known && !s.passive && setPick(pick === id ? null : id)} {...tip(<SkillTooltip id={id} ctx={naming} terms={t} known={known} />)}>
                      <SkillIcon id={id} />
                      <div className="grow">
                        <div className="sn">{skillName(naming, id)}</div>
                        <div className="tiny muted">{s.passive ? 'Passive' : `${s.ap} AP`}{s.minLevel > 1 ? ` · ${t.level} ${s.minLevel}` : ''}</div>
                        {canLearn && <button className="btn sm primary" style={{ marginTop: 4 }} onClick={(e) => { e.stopPropagation(); c.send({ t: 'learn_skill', charId: ch.id, skillId: id }); }}>Learn</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="hint">You gain a skill point every {t.level.toLowerCase()}. Trainers can also teach skills, and skill books can be found or bought.</div>
      </div>
    </Window>
  );
}

// =================================================================================== quests

export function QuestWindow({ onClose }: { onClose: () => void }) {
  const { player, world } = useGame((s) => ({ player: s.player, world: s.world }));
  const c = client();
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'quests' | 'journal'>('quests');
  const quests = useMemo(() => {
    if (!player) return [];
    return Object.values(player.quests).map((p) => ({ p, d: player.questDefs[p.questId]! })).filter((x) => x.d);
  }, [player]);
  if (!player || !world) return null;
  const t = world.terminology;
  const active = quests.filter((q) => q.p.status === 'active');
  const main = active.filter((q) => q.d.main);
  const side = active.filter((q) => !q.d.main);
  const done = quests.filter((q) => q.p.status !== 'active');
  const cur = quests.find((q) => q.d.id === sel) ?? main[0] ?? side[0] ?? done[0];
  const objs = (q: { d: QuestDef; p: (typeof quests)[number]['p'] }): QuestObjective[] => q.p.overrides ?? q.d.objectives;
  const row = (q: (typeof quests)[number]) => (
    <div key={q.d.id} className={`quest ${cur?.d.id === q.d.id ? 'on' : ''}`} onClick={() => setSel(q.d.id)}>
      <div className="qt">{q.d.title}</div>
      <div className="tiny muted">{q.d.main && q.d.arcIndex !== undefined ? world.arcs[q.d.arcIndex]?.title : t.level + ' ' + q.d.level}{q.p.status !== 'active' ? ` · ${q.p.status}` : ''}</div>
    </div>
  );
  return (
    <Window title={`${t.quest} log`} onClose={onClose} style={{ left: 260, top: 70, width: 760, height: 'min(640px, calc(100% - 160px))' }}>
      <div className="tabs">
        <div className={`tab ${tab === 'quests' ? 'on' : ''}`} onClick={() => setTab('quests')}>{t.quest}s</div>
        <div className={`tab ${tab === 'journal' ? 'on' : ''}`} onClick={() => setTab('journal')}>Journal</div>
      </div>
      {tab === 'journal' ? (
        <div className="panel-body scroll" style={{ flex: 1 }}>
          {[...player.journal].reverse().map((j, i) => (
            <div key={i} className="row" style={{ alignItems: 'flex-start', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,.04)' }}>
              <span className="tiny dim" style={{ width: 56, flex: 'none' }}>Day {j.day}</span>
              <span className={j.kind === 'story' ? 'serif' : 'small'} style={j.kind === 'story' ? { fontSize: 15, color: 'var(--gold-2)' } : undefined}>{j.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="row" style={{ alignItems: 'stretch', flex: 1, minHeight: 0 }}>
          <div className="scroll" style={{ width: 260, borderRight: '1px solid var(--line)', padding: 8 }}>
            {main.length > 0 && <div className="label" style={{ padding: '6px 10px' }}>Main story</div>}
            {main.map(row)}
            {side.length > 0 && <div className="label" style={{ padding: '6px 10px' }}>{t.quest}s</div>}
            {side.map(row)}
            {done.length > 0 && <div className="label" style={{ padding: '6px 10px' }}>Finished</div>}
            {done.map(row)}
            {!quests.length && <div className="muted small" style={{ padding: 10 }}>No {t.quest.toLowerCase()}s yet. Talk to people.</div>}
          </div>
          <div className="grow scroll panel-body">
            {cur && (
              <div className="col" style={{ gap: 8 }}>
                <div className="display gold" style={{ fontSize: 20 }}>{cur.d.title}</div>
                {cur.d.main && cur.d.arcIndex !== undefined && <div className="tiny muted" style={{ letterSpacing: '.12em', textTransform: 'uppercase' }}>{world.arcs[cur.d.arcIndex]?.title}</div>}
                <div className="serif" style={{ fontSize: 17, lineHeight: 1.5 }}>{cur.d.summary}</div>
                <div className="ornament" />
                {(() => {
                  const list = objs(cur);
                  const curIdx = list.findIndex((o) => !cur.p.objectives[o.id]?.done && !o.optional);
                  return list.map((o, i) => {
                    const st = cur.p.objectives[o.id];
                    const hidden = o.hidden && i > curIdx && curIdx >= 0 && cur.p.status === 'active';
                    return (
                      <div key={o.id} className={`obj ${st?.done ? 'done' : ''} ${hidden ? 'hidden' : ''}`}>
                        <span className="chk">{st?.done ? '✓' : ''}</span>
                        <span>{hidden ? '???' : o.description}{!hidden && (o.count ?? 1) > 1 ? ` (${st?.progress ?? 0}/${o.count})` : ''}{o.optional ? ' (optional)' : ''}</span>
                      </div>
                    );
                  });
                })()}
                <div className="small muted" style={{ marginTop: 6 }}>Reward: {cur.d.rewards.xp} {t.xp}, {cur.d.rewards.gold} {t.gold}{cur.d.rewards.items.length ? ', and an item' : ''}</div>
                <div className="ornament" />
                {cur.p.log.slice(-8).map((l, i) => (
                  <div key={i} className="tiny dim">Day {l.day}: {l.text}</div>
                ))}
                {!cur.d.main && cur.p.status === 'active' && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => confirm('Abandon this quest?') && c.send({ t: 'abandon_quest', questId: cur.d.id })}>Abandon</button>}
              </div>
            )}
          </div>
        </div>
      )}
    </Window>
  );
}

// =================================================================================== map

export function MapWindow({ onClose }: { onClose: () => void }) {
  const { player, world, zone } = useGame((s) => ({ player: s.player, world: s.world, zone: s.zone }));
  const c = client();
  if (!player || !world || !zone) return null;
  const outer = zone.kind === 'interior' ? zone.parentZoneId : zone.id;
  const known = world.zones.filter((z) => z.kind !== 'interior' && player.knownZones.includes(z.id));
  const W = 720, H = 440;
  const pos = (z: { mapPos: { x: number; y: number } }) => ({ x: 40 + z.mapPos.x * (W - 80), y: 30 + z.mapPos.y * (H - 60) });
  const leader = c.leaderEntity();
  const nearWaypoint = zone.features.some((f) => f.kind === 'waypoint' && leader && Math.hypot(f.x - leader.x, f.y - leader.y) < 3);
  const color = (k: string) => (k === 'town' ? '#ffd890' : k === 'dungeon' ? '#ff8a70' : '#9fd88a');
  return (
    <Window title="World map" onClose={onClose} style={{ left: '50%', top: 70, transform: 'translateX(-50%)', width: W + 34 }}>
      <div className="panel-body">
        <svg width={W} height={H} style={{ background: 'radial-gradient(ellipse at center, #2a2230, #0e0b12)', borderRadius: 10, border: '1px solid var(--line)' }}>
          <defs>
            <filter id="glow"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          {known.flatMap((z) =>
            z.links.filter((l) => known.some((k) => k.id === l) && z.id < l).map((l) => {
              const a = pos(z), b = pos(world.zones.find((x) => x.id === l)!);
              const visited = player.visitedZones.includes(z.id) && player.visitedZones.includes(l);
              return <line key={`${z.id}-${l}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={visited ? 'rgba(241,216,152,.55)' : 'rgba(241,216,152,.18)'} strokeWidth={2} strokeDasharray={visited ? undefined : '5 5'} />;
            }),
          )}
          {known.map((z) => {
            const p = pos(z);
            const visited = player.visitedZones.includes(z.id);
            const here = z.id === outer;
            const wp = z.kind === 'town' && player.waypoints.some((w) => w.zoneId === z.id);
            const canTravel = wp && nearWaypoint && !here;
            return (
              <g key={z.id} style={{ cursor: canTravel ? 'pointer' : 'default' }} onClick={() => canTravel && (c.send({ t: 'fast_travel', zoneId: z.id }), onClose())}>
                <circle cx={p.x} cy={p.y} r={here ? 11 : z.kind === 'town' ? 9 : 7} fill={visited ? color(z.kind) : 'rgba(255,255,255,.12)'} stroke={here ? '#fff' : 'rgba(0,0,0,.6)'} strokeWidth={here ? 2.5 : 1.5} filter={here ? 'url(#glow)' : undefined} opacity={visited ? 1 : 0.7} />
                {wp && <circle cx={p.x} cy={p.y} r={15} fill="none" stroke="#8fd8ff" strokeWidth={1.5} strokeDasharray="3 3" />}
                <text x={p.x} y={p.y + 24} textAnchor="middle" fill={visited ? '#f1e6cc' : '#9a9080'} fontSize={12} fontFamily="Cinzel, serif">{z.name}</text>
                <text x={p.x} y={p.y + 37} textAnchor="middle" fill="#7a7060" fontSize={10}>{world.terminology[z.kind === 'town' ? 'town' : z.kind === 'dungeon' ? 'dungeon' : 'wilderness']} · {world.terminology.level} {z.levelRange[0]}{z.levelRange[1] !== z.levelRange[0] ? `–${z.levelRange[1]}` : ''}</text>
              </g>
            );
          })}
        </svg>
        <div className="hint" style={{ marginTop: 8 }}>{nearWaypoint ? 'Click a waypoint (dashed ring) to travel there.' : 'Stand by a waypoint in a town to fast-travel between visited towns.'}</div>
      </div>
    </Window>
  );
}

// =================================================================================== crafting

export function CraftWindow({ onClose }: { onClose: () => void }) {
  const { player, world } = useGame((s) => ({ player: s.player, world: s.world }));
  const c = client();
  if (!player || !world) return null;
  const naming = c.naming()!;
  const have = (baseId: string) => player.inventory.filter((i) => i.baseId === baseId).reduce((s, i) => s + i.qty, 0);
  const lvl = Math.max(...player.party.map((p) => p.level));
  return (
    <Window title="Crafting" onClose={onClose} style={{ left: 260, top: 70, width: 520 }}>
      <div className="panel-body col">
        {RECIPES.map((r) => {
          const ok = r.inputs.every((i) => have(i.baseId) >= i.qty);
          const outName = 'baseId' in r.output ? naming.itemNames[r.output.baseId]?.names[0] ?? r.output.baseId : `${naming.terminology.rarities[r.output.rarity]} ${r.output.category}`;
          return (
            <div key={r.id} className="row" style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, opacity: ok ? 1 : 0.6 }}>
              <ItemIcon item={{ baseId: 'baseId' in r.output ? r.output.baseId : r.output.category === 'weapon' ? 'w_blade' : r.output.category === 'armor' ? 'a_chest_heavy' : 't_ring', rarity: 'baseId' in r.output ? 'common' : r.output.rarity }} />
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{world.recipeNames[r.id] ?? r.defaultName}</div>
                <div className="tiny muted">→ {outName}{'qty' in r.output && r.output.qty > 1 ? ` ×${r.output.qty}` : ''} (level {lvl})</div>
                <div className="tiny">
                  {r.inputs.map((i) => (
                    <span key={i.baseId} style={{ marginRight: 10, color: have(i.baseId) >= i.qty ? 'var(--good)' : 'var(--danger)' }}>
                      {naming.itemNames[i.baseId]?.names[0] ?? i.baseId} {have(i.baseId)}/{i.qty}
                    </span>
                  ))}
                </div>
              </div>
              <button className="btn sm primary" disabled={!ok} onClick={() => c.send({ t: 'craft', recipeId: r.id })}>Craft</button>
            </div>
          );
        })}
        <div className="hint">Materials drop from monsters and chests, and can be bought from merchants.</div>
      </div>
    </Window>
  );
}

// =================================================================================== menu

export function MenuWindow({ onClose, onHelp }: { onClose: () => void; onHelp: () => void }) {
  const { player, keepRunning, open, isOwner, instanceName, world } = useGame((s) => ({ player: s.player, keepRunning: s.keepRunning, open: s.open, isOwner: s.isOwner, instanceName: s.instanceName, world: s.world }));
  const c = client();
  const [name, setName] = useState('');
  const [saved, setSaved] = useState('');
  if (!player) return null;
  return (
    <Window title={instanceName ?? 'Menu'} onClose={onClose} style={{ left: '50%', top: '18%', transform: 'translateX(-50%)', width: 400 }}>
      <div className="panel-body col">
        <div className="label">Hard save</div>
        <div className="row">
          <input className="input grow" placeholder="Save name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn" onClick={() => { c.send({ t: 'hard_save', name }); setSaved('Saved as a separate copy you can return to.'); setName(''); }}>Save</button>
        </div>
        <div className="hint">{saved || 'Progress is saved continuously. A hard save is a snapshot you can load later from the world page.'}</div>
        <div className="ornament" />
        <label className="row small" style={{ cursor: isOwner ? 'pointer' : 'default', opacity: isOwner ? 1 : 0.5 }}>
          <input type="checkbox" disabled={!isOwner} checked={keepRunning} onChange={(e) => { c.send({ t: 'set_options', keepRunning: e.target.checked }); c.update({ keepRunning: e.target.checked }); }} />
          Keep the world running while I'm away (time and events continue)
        </label>
        <label className="row small" style={{ cursor: isOwner ? 'pointer' : 'default', opacity: isOwner ? 1 : 0.5 }}>
          <input type="checkbox" disabled={!isOwner} checked={open} onChange={(e) => { c.send({ t: 'set_options', open: e.target.checked }); c.update({ open: e.target.checked }); }} />
          Let other players join this world (experimental)
        </label>
        {world?.input.combatMode === 'party_npc' && (
          <label className="row small" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={player.commandCompanions} onChange={(e) => c.send({ t: 'set_options', commandCompanions: e.target.checked })} />
            I command my companions in combat (otherwise they act on their own)
          </label>
        )}
        {player.party.some((p) => p.npcId) && (
          <div className="row wrap">
            {player.party.filter((p) => p.npcId).map((p) => (
              <button key={p.id} className="btn sm ghost" onClick={() => c.send({ t: 'dismiss_companion', charId: p.id })}>Part ways with {p.name}</button>
            ))}
          </div>
        )}
        <div className="ornament" />
        <div className="row">
          <button className="btn" onClick={onHelp}>Controls</button>
          <div className="spacer" />
          <button className="btn danger" onClick={() => navigate(`#/world/${world?.id ?? ''}`)}>Leave world</button>
        </div>
      </div>
    </Window>
  );
}

export function HelpWindow({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Left click ground', 'Move (in combat: move the active character)'],
    ['Left click person', 'Talk'],
    ['Left click enemy', 'Attack (walks into range first)'],
    ['Left click object', 'Use: doors, chests, shrines, levers, signs, traps you have spotted'],
    ['1 – 0', 'Ready a skill, then click a target'],
    ['Right click / Esc', 'Cancel targeting · close windows'],
    ['Space / Enter', 'End turn'],
    ['I · C · K · J · M · B', 'Inventory · Character · Skills · Quests · Map · Crafting'],
    ['Mouse wheel', 'Zoom'],
    ['Tab', 'Cycle party member'],
  ];
  return (
    <Window title="Controls" onClose={onClose} style={{ left: '50%', top: '14%', transform: 'translateX(-50%)', width: 520 }}>
      <div className="panel-body">
        <table className="table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}><td style={{ width: 170 }}><code>{k}</code></td><td>{v}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 10 }}>
          Combat is turn-based. Each turn grants action points; moving and acting spend them. Physical armor must be broken before physical effects (like knockdown) can land, and magic armor before magical ones (like stun). Combine elements: rain makes enemies wet, and wet enemies hit by shock may be stunned.
        </p>
        <p className="hint">You can say anything to anyone. NPCs remember what you tell them, react to gifts and abilities, and may change your quests in response.</p>
      </div>
    </Window>
  );
}

export { getSkill };
export type { AttributeId };
