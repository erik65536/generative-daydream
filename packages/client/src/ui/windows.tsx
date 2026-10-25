import { readable } from './theme';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DIFFICULTIES, fieldRecipe, nearStation, branchSpent, canAllocate, codexSections, enchantCost, inventoryCapacity, inventoryUsed, itemPrice, knownSkills, modifierLabel, nodeLines, perPointLabel,
  rx, skillRank, upgradeCost, xpForLevel,
  type CharacterState, type ItemInstance, type QuestDef, type QuestObjective, type Ruleset, type TreeNode,
} from '@gd/shared';
import { client, useGame } from '../net/game';
import { ItemIcon, ItemTooltip, Portrait, SkillIcon, SkillTooltip, Window, hideTip, tip } from './common';
import { navigate } from '../App';
import { MAP_W, WorldMapView } from './worldmap';
import { trackedQuest } from './tracker';
import { readAloud, setReadAloud, voiceIn, voiceOut } from '../voice';

const iconUrl = (baseId: string) => client().assetUrl(`icon_${baseId}`);

function rarityClass(r: Ruleset, item: ItemInstance): string {
  if (item.uniqueId) return 'r-unique';
  return `r-${Math.min(4, rx(r).rarityOrder.get(item.rarityId) ?? 0)}`;
}

function ItemCell({ item, onClick, onContext, selected, price, compare }: { item: ItemInstance; onClick?: (e: React.MouseEvent) => void; onContext?: (e: React.MouseEvent) => void; selected?: boolean; price?: number; compare?: ItemInstance }) {
  const c = client();
  const r = c.r;
  const base = rx(r).item.get(item.baseId);
  const rarity = rx(r).rarity.get(item.rarityId);
  return (
    <div
      className={`item ${rarityClass(r, item)} ${base?.category === 'quest' || item.bound ? 'quest' : ''} ${selected ? 'sel' : ''}`}
      style={!item.uniqueId && rarity ? ({ '--rc': rarity.color } as React.CSSProperties) : undefined}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext?.(e);
      }}
      {...tip(<ItemTooltip item={item} r={r} uniques={{ uniqueItems: c.uniqueItems() }} price={price} compare={compare} />)}
    >
      <ItemIcon item={item} url={iconUrl(item.baseId)} />
      {item.qty > 1 && <span className="qty">{item.qty}</span>}
      {item.upgrade ? <span className="upg">+{item.upgrade}</span> : null}
      {price !== undefined && <span className="qty" style={{ color: '#ffe08a', left: 3, right: 'auto', fontSize: 10 }}>{price}</span>}
    </div>
  );
}

function PartyTabs({ ch, mark }: { ch: CharacterState; mark?: (p: CharacterState) => boolean }) {
  const player = useGame((s) => s.player);
  const c = client();
  if (!player) return null;
  return (
    <>
      {player.party.map((p) => (
        <div key={p.id} className={`tab ${p.id === ch.id ? 'on' : ''}`} onClick={() => c.update({ selectedCharId: p.id })}>
          {p.name}
          {mark?.(p) ? <span className="dot" /> : null}
        </div>
      ))}
    </>
  );
}

// =================================================================================== dialog

const EMOTION_TINT: Record<string, string> = {
  happy: '#9fe07a', amused: '#e8d27a', grateful: '#9fe07a', angry: '#ff7a5a', afraid: '#c9a0ff', sad: '#8ab4ff',
  suspicious: '#e0a85a', surprised: '#ffd27a', neutral: '#a69c8c',
};

/**
 * Reveals the newest NPC line progressively, like a spoken reply (click to show it all). When lines are read
 * aloud, it keeps pace with the voice, as subtitles do.
 */
function Typed({ text, animate, cps }: { text: string; animate: boolean; cps?: number }) {
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) return setN(text.length);
    setN(0);
    const step = cps ? Math.max(1, cps / 60) : Math.max(1, Math.round(text.length / 90));
    let acc = 0;
    const id = setInterval(() => {
      acc += step;
      setN((v) => (v >= text.length ? (clearInterval(id), v) : Math.min(text.length, Math.floor(acc))));
    }, 16);
    return () => clearInterval(id);
  }, [text, animate, cps]);
  return <span onClick={() => setN(text.length)}>{text.slice(0, n)}{n < text.length && <span className="caret" />}</span>;
}

export function DialogWindow() {
  const { dialog, player, world } = useGame((s) => ({ dialog: s.dialog, player: s.player, world: s.world }));
  const c = client();
  const [text, setText] = useState('');
  const [give, setGive] = useState('');
  const [gold, setGold] = useState(0);
  const [skill, setSkill] = useState('');
  const [offer, setOffer] = useState(false);
  const msgsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seen = useRef(0);
  const spoken = useRef(-1);
  const [aloud, setAloud] = useState(readAloud());
  const [listening, setListening] = useState(false);
  // Read each new line aloud (when wanted) in this person's own voice; stop when the conversation closes.
  const lastIdx = dialog ? dialog.messages.map((m) => m.speaker).lastIndexOf('npc') : -1;
  useEffect(() => {
    if (!dialog || !aloud || lastIdx < 0 || lastIdx <= spoken.current || lastIdx < seen.current - 1) return;
    spoken.current = lastIdx;
    const who = c.state.world?.npcs.find((n) => n.id === dialog.npcId);
    void voiceOut.speak(dialog.messages[lastIdx]!.text, { id: dialog.npcId, pronouns: who?.pronouns });
  }, [lastIdx, aloud, dialog?.npcId]);
  useEffect(() => () => {
    voiceOut.stop();
    voiceIn.stop();
  }, []);
  useEffect(() => {
    spoken.current = dialog ? dialog.messages.map((m) => m.speaker).lastIndexOf('npc') : -1;
  }, [dialog?.npcId]);
  // The newest line stays in view while it types itself out and the replies appear under it, unless the player has
  // scrolled up to read; a new line brings the view back down. A line taller than the view is shown from its start.
  const stick = useRef(true);
  const hasDialog = !!dialog;
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    const toEnd = () => {
      if (!stick.current) return;
      const last = [...el.querySelectorAll<HTMLElement>('.msg')].pop();
      if (last && last.offsetHeight > el.clientHeight - 32) el.scrollTop = last.offsetTop - 12;
      else el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48);
    el.addEventListener('scroll', onScroll);
    el.addEventListener('settle', toEnd);
    const mo = new MutationObserver(toEnd);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(toEnd);
    ro.observe(el);
    toEnd();
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('settle', toEnd);
      mo.disconnect();
      ro.disconnect();
    };
  }, [hasDialog, dialog?.npcId]);
  useEffect(() => {
    stick.current = true;
    msgsRef.current?.dispatchEvent(new Event('settle'));
  }, [dialog?.messages.length, dialog?.thinking]);
  useEffect(() => {
    inputRef.current?.focus();
  }, [dialog?.npcId, dialog?.thinking]);
  useEffect(() => {
    seen.current = 0;
  }, [dialog?.npcId]);
  if (!dialog || !player || !world) return null;
  const r = world.ruleset;
  const leader = player.party.find((x) => x.id === player.leaderId) ?? player.party[0]!;
  const send = (t?: string) => {
    const msg = (t ?? text).trim();
    if (!msg && !give && !gold && !skill) return;
    c.send({ t: 'talk', npcId: dialog.npcId, text: msg, giveItemId: give || undefined, giveGold: gold || undefined, useSkillId: skill || undefined });
    setText('');
    setGive('');
    setGold(0);
    setSkill('');
    setOffer(false);
  };
  const close = () => c.send({ t: 'end_dialog' });
  const actives = knownSkills(r, leader).filter((id) => id !== r.basicAttackId);
  const lastNpc = dialog.messages.map((m) => m.speaker).lastIndexOf('npc');
  const animateFrom = seen.current;
  seen.current = dialog.messages.length;
  const giveItem = give ? player.inventory.find((i) => i.id === give) : undefined;
  const offering = [giveItem && c.itemName(giveItem), gold ? `${gold} ${r.terminology.currency}` : '', skill && c.skillName(skill)].filter(Boolean).join(' · ');
  return (
    <div className="window panel ornate dialog" onMouseDown={(e) => e.stopPropagation()}>
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />
      <div className="dlg-side">
        <div className="dlg-portrait">
          <Portrait size={150} full sprite={c.assetUrl(dialog.sprite)} />
        </div>
        <div className="display gold dlg-name">{dialog.npcName}</div>
        <div className="serif muted dlg-title">{dialog.npcTitle}</div>
        <div className="spacer" />
        {voiceOut.available() && (
          <button className={`btn sm ghost voice-toggle ${aloud ? 'on' : ''}`} title={aloud ? 'Stop reading lines aloud' : 'Read lines aloud'} onClick={() => { setReadAloud(!aloud); setAloud(!aloud); }}>
            {aloud ? '🔊 Voices on' : '🔈 Voices off'}
          </button>
        )}
        {dialog.canTrade && <button className="btn sm" disabled={dialog.thinking} onClick={() => c.send({ t: 'request_trade' })}>Trade</button>}
        <button className="btn sm ghost" onClick={close} title="Leave (Esc) — or just walk away">Leave</button>
      </div>
      <div className="dlg-main">
        <div className="msgs" ref={msgsRef}>
          {dialog.messages.map((m, i) => (
            <div key={i} className={`msg ${m.speaker}`}>
              {m.speaker === 'npc' && (
                <span className="who">
                  {dialog.npcName.split(' ')[0]}
                  {m.emotion && m.emotion !== 'neutral' && <span className="emo" style={{ color: EMOTION_TINT[m.emotion] ?? 'var(--muted)' }}>{m.emotion}</span>}
                </span>
              )}
              {m.speaker === 'npc' ? <Typed text={m.text} animate={i === lastNpc && i >= animateFrom} cps={aloud && voiceOut.available() ? voiceOut.pace : undefined} /> : m.text}
            </div>
          ))}
          {dialog.thinking && (
            <div className="thinking">
              <span /><span /><span />
            </div>
          )}
        </div>
        <div className="compose">
          {!dialog.thinking && !dialog.ended && dialog.suggestions.length > 0 && (
            <ol className="replies">
              {dialog.suggestions.map((s) => (
                <li key={s} onClick={() => (s === 'Farewell.' ? close() : send(s))}>{s}</li>
              ))}
            </ol>
          )}
          {offer && (
            <div className="attach">
              <select className="input" value={give} onChange={(e) => setGive(e.target.value)}>
                <option value="">Give an item…</option>
                {player.inventory.map((i) => (
                  <option key={i.id} value={i.id}>{c.itemName(i)}{i.qty > 1 ? ` ×${i.qty}` : ''}</option>
                ))}
              </select>
              <input className="input" type="number" min={0} max={player.gold} style={{ width: 90 }} value={gold || ''} placeholder={r.terminology.currency} onChange={(e) => setGold(Math.max(0, Math.min(player.gold, Number(e.target.value))))} />
              <select className="input" value={skill} onChange={(e) => setSkill(e.target.value)}>
                <option value="">Use a skill…</option>
                {actives.map((s) => (
                  <option key={s} value={s}>{c.skillName(s)}</option>
                ))}
              </select>
            </div>
          )}
          <div className="say">
            <button className={`btn ghost sm offer ${offer || offering ? 'on' : ''}`} title="Offer an item, money or a skill along with your words" onClick={() => setOffer((v) => !v)}>
              {offering || 'Offer…'}
            </button>
            <textarea
              ref={inputRef}
              className="input"
              rows={1}
              placeholder={dialog.ended ? 'The conversation is over.' : `Say or do anything… (${leader.name})`}
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
            {voiceIn.available() && (
              <button
                className={`btn sm ghost mic ${listening ? 'on' : ''}`}
                title={listening ? 'Listening… (click to stop)' : 'Speak instead of typing'}
                disabled={dialog.thinking || dialog.ended}
                onClick={async () => {
                  if (listening) return voiceIn.stop();
                  voiceOut.stop();
                  setListening(true);
                  try {
                    const said = await voiceIn.listen((t) => setText(t));
                    if (said) send(said);
                    else c.toast("Didn't catch that — try again.", 'info');
                  } catch (e) {
                    c.toast((e as Error).message, 'bad');
                  } finally {
                    setListening(false);
                  }
                }}
              >
                {listening ? '● Listening' : '🎙'}
              </button>
            )}
            <button className="btn primary sm" disabled={dialog.thinking || dialog.ended} onClick={() => send()}>Say</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =================================================================================== inventory

type Filter = 'all' | 'gear' | 'use' | 'mat' | 'quest';

function useItem(charId: string, item: ItemInstance) {
  const c = client();
  const use = rx(c.r).item.get(item.baseId)?.use;
  if (!use) return;
  if (use.targeting === 'self' || use.tool === 'recall') c.send({ t: 'use_item', charId, itemId: item.id, targetId: charId });
  else if (use.tool === 'disarm' || use.tool === 'unlock') c.toast(use.tool === 'disarm' ? 'Click a spotted trap to disarm it.' : 'Click a locked chest to open it.', 'info');
  else if (use.targeting === 'ally') c.send({ t: 'use_item', charId, itemId: item.id, targetId: charId });
  else c.update({ targeting: { charId, itemId: item.id }, panel: null });
}

export function InventoryWindow({ onClose }: { onClose: () => void }) {
  const { player, selected, trade, world, combat } = useGame((s) => ({ player: s.player, selected: s.selectedCharId, trade: s.trade, world: s.world, combat: s.combat }));
  const c = client();
  const [filter, setFilter] = useState<Filter>('all');
  const [menu, setMenu] = useState<{ x: number; y: number; item: ItemInstance } | null>(null);
  if (!player || !world) return null;
  const r = world.ruleset;
  const ix = rx(r);
  const ch = player.party.find((x) => x.id === selected) ?? player.party[0]!;
  const cat = (i: ItemInstance) => ix.item.get(i.baseId)?.category;
  const items = player.inventory.filter((i) => {
    const k = cat(i);
    if (!k) return false;
    if (filter === 'gear') return k === 'equipment';
    if (filter === 'use') return k === 'potion' || k === 'tool';
    if (filter === 'mat') return k === 'material' || k === 'valuable';
    if (filter === 'quest') return k === 'quest' || k === 'key' || !!i.bound;
    return true;
  });
  const equippedFor = (item: ItemInstance) => {
    const slot = ix.item.get(item.baseId)?.slotId;
    return slot ? ch.equipment[slot] : undefined;
  };
  const primary = (item: ItemInstance) => {
    const k = cat(item);
    if (trade) return c.send({ t: 'sell', npcId: trade.npcId, itemId: item.id, qty: 1 });
    if (k === 'equipment') return c.send({ t: 'equip', charId: ch.id, itemId: item.id });
    useItem(ch.id, item);
  };
  const stats = c.charStats(ch);
  const cap = inventoryCapacity(r, player);
  const used = inventoryUsed(player);
  const w = stats.weapon;
  const kindName = (typeId: string, subtypeId?: string) => (subtypeId ? ix.subtype.get(subtypeId)?.name : undefined) ?? ix.type.get(typeId)?.name ?? '';
  return (
    <Window title={trade ? 'Your pack — click to sell' : 'Inventory'} onClose={onClose} style={{ left: trade ? 700 : 260, top: 70, width: 660 }}>
      <div className="tabs">
        <PartyTabs ch={ch} />
        <div className="spacer" />
        <div className="tab gold" style={{ cursor: 'default' }}>{player.gold} {r.terminology.currency}</div>
      </div>
      <div className="panel-body row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <div className="col" style={{ width: 280, flex: 'none' }}>
          <div className="equip">
            {r.slots.map((slot) => {
              const it = ch.equipment[slot.id];
              return (
                <div className="slotbox" key={slot.id}>
                  {it ? (
                    <ItemCell item={it} onClick={() => !combat && c.send({ t: 'unequip', charId: ch.id, slot: slot.id })} />
                  ) : (
                    <div className="item empty" />
                  )}
                  <span>{slot.name}</span>
                </div>
              );
            })}
          </div>
          <div className="kv" style={{ marginTop: 8 }}>
            <span>Weapon</span><span className="v">{Math.round(w.min)}–{Math.round(w.max)} {kindName(w.typeId, w.subtypeId)}</span>
            {r.damageTypes.map((d) => (
              <span key={d.id} style={{ display: 'contents' }}><span>{d.mitigationName}</span><span className="v">{Math.round((stats.mitigation[d.id] ?? 0) * 100)}%</span></span>
            ))}
            <span>{r.health.name}</span><span className="v">{stats.maxHp}</span>
            {r.resolution.crit && <><span>Critical</span><span className="v">{Math.round(stats.crit * 100)}%</span></>}
          </div>
          <div className="hint">Click equipped items to remove them. Right-click pack items for options.</div>
        </div>
        <div className="grow col">
          <div className="row" style={{ gap: 4 }}>
            {(['all', 'gear', 'use', 'mat', 'quest'] as const).map((f) => (
              <span key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                {{ all: 'All', gear: 'Gear', use: 'Usable', mat: 'Materials', quest: 'Story' }[f]}
              </span>
            ))}
            <div className="spacer" />
            <span className={`tiny ${used >= cap ? 'bad' : 'muted'}`} {...tip(<div>Pack space: {used} of {cap} stacks used.<div className="tsub">Story items take no space.{player.inventoryUpgrades < r.inventory.upgrades ? ' Merchants can enlarge your pack.' : ''}</div></div>)}>{used}/{cap}</span>
          </div>
          <div className="capbar"><div style={{ width: `${Math.min(100, (used / Math.max(1, cap)) * 100)}%` }} className={used >= cap ? 'full' : ''} /></div>
          <div className="items" style={{ maxHeight: 420, overflow: 'auto' }}>
            {items.map((it) => (
              <ItemCell key={it.id} item={it} compare={equippedFor(it)} price={trade ? Math.max(1, Math.round(itemPrice(r, { ...it, qty: 1 }) * trade.sellMult)) : undefined} onClick={() => primary(it)} onContext={(e) => setMenu({ x: e.clientX, y: e.clientY, item: it })} />
            ))}
            {!items.length && <div className="muted small">Nothing here.</div>}
          </div>
        </div>
      </div>
      {menu && (
        <div className="ctx panel" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          <div className="menu-list">
            <div className="tiny muted" style={{ padding: '2px 8px' }}>{c.itemName(menu.item)}</div>
            {cat(menu.item) === 'equipment' && player.party.map((p) => (
              <button key={p.id} className="btn sm ghost" onClick={() => { c.send({ t: 'equip', charId: p.id, itemId: menu.item.id }); setMenu(null); hideTip(); }}>Equip on {p.name}</button>
            ))}
            {ix.item.get(menu.item.baseId)?.use && player.party.map((p) => (
              <button key={p.id} className="btn sm ghost" onClick={() => { useItem(p.id, menu.item); setMenu(null); }}>Use on {p.name}</button>
            ))}
            {trade && <button className="btn sm ghost" onClick={() => { c.send({ t: 'sell', npcId: trade.npcId, itemId: menu.item.id, qty: menu.item.qty }); setMenu(null); }}>Sell all</button>}
            {!menu.item.bound && <button className="btn sm ghost" onClick={() => { c.send({ t: 'drop_item', itemId: menu.item.id }); setMenu(null); hideTip(); }}>Drop</button>}
          </div>
        </div>
      )}
    </Window>
  );
}

// =================================================================================== trade

export function TradeWindow() {
  const { trade, player, world } = useGame((s) => ({ trade: s.trade, player: s.player, world: s.world }));
  const c = client();
  if (!trade || !player || !world) return null;
  const r = world.ruleset;
  const cur = r.terminology.currency;
  return (
    <Window title={`${trade.npcName}’s wares`} onClose={() => c.send({ t: 'end_trade' })} style={{ left: 260, top: 70, width: 430 }}>
      <div className="panel-body col">
        <div className="row small">
          <span className="muted">They have {trade.npcGold} {cur}</span>
          <div className="spacer" />
          <span className="gold">You have {player.gold} {cur}</span>
        </div>
        <div className="items" style={{ maxHeight: 400, overflow: 'auto' }}>
          {trade.stock.map((it) => (
            <ItemCell key={it.id} item={it} price={it.price} onClick={(e) => c.send({ t: 'buy', npcId: trade.npcId, itemId: it.id, qty: e.shiftKey ? it.qty : 1 })} />
          ))}
        </div>
        {trade.bagUpgrade && (
          <div className="offer-row">
            <div className="grow">
              <div style={{ fontWeight: 600 }}>Larger pack</div>
              <div className="tiny muted">+{trade.bagUpgrade.slots} slots (now {inventoryCapacity(r, player)})</div>
            </div>
            <button className="btn sm primary" disabled={player.gold < trade.bagUpgrade.cost} onClick={() => c.send({ t: 'buy_inventory_upgrade', npcId: trade.npcId })}>{trade.bagUpgrade.cost} {cur}</button>
          </div>
        )}
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
  const close = () => c.send({ t: 'close_loot' });
  return (
    <Window title={loot.label} onClose={close} style={{ left: '50%', top: '30%', width: 330, transform: 'translateX(-50%)' }}>
      <div className="panel-body col">
        {loot.gold > 0 && (
          <div className="row loot-row" onClick={() => c.send({ t: 'take_loot', sourceId: loot.id, itemId: 'gold' })}>
            <span className="gold" style={{ fontSize: 16 }}>◉</span> {loot.gold} {world.ruleset.terminology.currency}
          </div>
        )}
        {loot.items.map((it) => (
          <div key={it.id} className="row loot-row" onClick={() => c.send({ t: 'take_loot', sourceId: loot.id, itemId: it.id })}>
            <ItemCell item={it} />
            <div className="grow small" style={{ color: it.uniqueId ? '#ffd24a' : rx(world.ruleset).rarity.get(it.rarityId)?.color }}>{c.itemName(it)}{it.qty > 1 ? ` ×${it.qty}` : ''}</div>
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
  const r = world.ruleset;
  const ix = rx(r);
  const t = r.terminology;
  const ch = player.party.find((x) => x.id === selected) ?? player.party[0]!;
  const s = c.charStats(ch);
  const cls = ix.cls.get(ch.classId);
  const kin = ix.kin.get(ch.kinId);
  const pctOf = (x: number) => `${Math.round(x * 100)}%`;
  const kindName = (typeId: string, subtypeId?: string) => (subtypeId ? ix.subtype.get(subtypeId)?.name : undefined) ?? ix.type.get(typeId)?.name ?? '';
  const bonuses = Object.entries(s.pct).filter(([, v]) => Math.abs(v) >= 0.5);
  return (
    <Window title="Character" onClose={onClose} style={{ left: 260, top: 70, width: 600 }}>
      <div className="tabs">
        <PartyTabs ch={ch} />
      </div>
      <div className="panel-body row" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div className="col" style={{ width: 230 }}>
          <div className="row" style={{ gap: 10 }}>
            <div className="portrait-lg"><Portrait size={64} sprite={c.assetUrl(ch.sprite)} /></div>
            <div>
              <div className="display gold" style={{ fontSize: 20 }}>{ch.name}</div>
              <div className="muted small">{t.level} {ch.level} {kin?.name} {cls?.name}{ch.npcId ? ' (companion)' : ''}</div>
              <div className="tiny dim">{ch.level >= r.progression.maxLevel ? `Maximum ${t.level.toLowerCase()}` : `${t.xp} ${ch.xp} / ${xpForLevel(r, ch.level + 1)}`}</div>
            </div>
          </div>
          <div className="ornament" />
          <div className="label">Attributes</div>
          {r.attributes.map((a) => (
            <div key={a.id} className="attr" {...tip(<div><div className="tname gold">{a.name}</div><div className="tdesc" style={{ marginTop: 0 }}>{a.description}</div><div className="tsub">Each point above {r.attributeBase}:</div>{a.perPoint.map((m, i) => <div key={i} className="tline">{perPointLabel(r, m, ch.level)}</div>)}</div>)}>
              <span className="n">{a.name}</span>
              <span className="val">{s.attributes[a.id]}</span>
            </div>
          ))}
          <div className="hint">Raise attributes in the shared branch of your talent tree (K).</div>
        </div>
        <div className="grow">
          <div className="kv">
            <span>{r.health.name}</span><span className="v">{Math.round(ch.hp)} / {s.maxHp}</span>
            {r.pools.map((p) => (
              <span key={p.id} style={{ display: 'contents' }}><span>{p.name}</span><span className="v">{Math.round(ch.pools[p.id] ?? 0)} / {s.pools[p.id]?.max ?? 0}</span></span>
            ))}
            <span>Weapon damage</span><span className="v">{Math.round(s.weapon.min)}–{Math.round(s.weapon.max)} {kindName(s.weapon.typeId, s.weapon.subtypeId)}</span>
            <span>Attack cost</span><span className="v">{s.weapon.apCost} {t.actionPoints}</span>
            <span>Range</span><span className="v">{s.weapon.melee ? 'Melee' : Math.round(s.weapon.range)}</span>
            <span>Skill power</span><span className="v">{Math.round(s.dpa)} per {t.actionPoints}</span>
            {r.resolution.crit && <><span>Critical chance</span><span className="v">{pctOf(s.crit)}</span><span>Critical damage</span><span className="v">{pctOf(s.critMult)}</span></>}
            {r.resolution.dodge && <><span>Dodge</span><span className="v">{pctOf(s.dodge)}</span></>}
            <span>Initiative</span><span className="v">{Math.round(s.initiative)}</span>
            <span>{t.actionPoints} per turn</span><span className="v">{s.apPerTurn} (max {s.apMax})</span>
            <span>Movement</span><span className="v">{s.move.toFixed(1)} tiles per {t.actionPoints}</span>
            {s.lifesteal ? <><span>Life steal</span><span className="v">{pctOf(s.lifesteal)}</span></> : null}
          </div>
          <div className="label" style={{ marginTop: 12 }}>Defences</div>
          <div className="kv">
            {r.damageTypes.map((d) => (
              <span key={d.id} style={{ display: 'contents' }}><span style={{ color: readable(d.color) }}>{d.mitigationName}</span><span className="v">{pctOf(s.mitigation[d.id] ?? 0)} less {d.name.toLowerCase()}</span></span>
            ))}
            {r.systems.subtypes && r.subtypes.filter((x) => Math.abs(s.resist[x.id] ?? 0) >= 0.005).map((x) => (
              <span key={x.id} style={{ display: 'contents' }}><span style={{ color: readable(x.color) }}>{x.name}</span><span className="v">{(s.resist[x.id] ?? 0) > 0 ? '' : '+'}{pctOf(-(s.resist[x.id] ?? 0)).replace('-', '−')} damage</span></span>
            ))}
          </div>
          {bonuses.length > 0 && (
            <>
              <div className="label" style={{ marginTop: 12 }}>Bonuses</div>
              <div className="kv">
                {bonuses.map(([k, v]) => (
                  <span key={k} style={{ display: 'contents' }}><span>{k === 'power' ? 'All damage' : k === 'healing' ? 'Healing' : modifierLabel(r, { stat: k, value: 0 }, 1).replace(/^\+0(\.0)?%? /, '')}</span><span className="v">{v > 0 ? '+' : ''}{Math.round(v)}%</span></span>
                ))}
              </div>
            </>
          )}
          {player.loneWolf && <div className="hint" style={{ marginTop: 10 }}>Travelling alone: you are a little tougher and hit a little harder.</div>}
        </div>
      </div>
    </Window>
  );
}

// =================================================================================== talents

function nodeGlyph(n: TreeNode): string {
  return n.kind === 'capstone' ? '✦' : n.kind === 'passive' ? '◆' : n.kind === 'attribute' ? '▲' : '●';
}

function NodeCard({ ch, node }: { ch: CharacterState; node: TreeNode }) {
  const c = client();
  const r = c.r;
  const rank = ch.tree[node.id] ?? 0;
  const err = canAllocate(r, ch, node.id);
  const tierReq = r.progression.tierRequirements[node.tier] ?? 0;
  const locked = node.kind !== 'attribute' && branchSpent(r, ch, node.branch) < tierReq;
  const needsSkill = node.kind === 'rank' && node.skillId && skillRank(r, ch, node.skillId) < 1;
  const maxed = rank >= node.maxRank;
  const state = maxed ? 'maxed' : rank > 0 ? 'some' : locked || needsSkill ? 'locked' : err ? 'avail-no' : 'avail';
  const skill = node.skillId ? rx(r).skill.get(node.skillId) : undefined;
  const stats = c.charStats(ch);
  const body = (
    <div>
      <div className="tname gold">{node.name}</div>
      <div className="tsub">
        {{ skill: 'New skill', rank: 'Skill upgrade', passive: 'Passive', capstone: 'Capstone', attribute: 'Attribute' }[node.kind]}
        {node.kind !== 'attribute' ? ` · tier ${node.tier + 1}` : ''} · rank {rank}/{node.maxRank >= 99 ? '∞' : node.maxRank}
      </div>
      <div style={{ marginTop: 6 }}>
        {nodeLines(r, node, ch.level).map((l, i) => <div key={i} className="tline">{l}</div>)}
      </div>
      {node.description && <div className="tdesc">{node.description}</div>}
      {skill && node.kind === 'skill' && <div style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 6 }}><SkillTooltip id={skill.id} r={r} stats={stats} /></div>}
      {!maxed && err && <div className="tsub" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
      {!maxed && !err && <div className="tsub" style={{ color: 'var(--good)', marginTop: 6 }}>Click to spend a point</div>}
    </div>
  );
  return (
    <div className={`tnode ${node.kind} ${state}`} onClick={() => !err && c.send({ t: 'allocate', charId: ch.id, nodeId: node.id })} {...tip(body)}>
      <div className="tn-icon">{skill ? <SkillIcon id={skill.id} size={34} /> : <span className="glyph">{nodeGlyph(node)}</span>}</div>
      <div className="tn-text">
        <div className="tn-name">{node.name}</div>
        <div className="tn-rank">
          {node.maxRank <= 5 ? Array.from({ length: node.maxRank }, (_, i) => <span key={i} className={`pip ${i < rank ? 'on' : ''}`} />) : <span className="tiny">{rank}</span>}
        </div>
      </div>
    </div>
  );
}

export function SkillsWindow({ onClose }: { onClose: () => void }) {
  const { player, selected, world, version } = useGame((s) => ({ player: s.player, selected: s.selectedCharId, world: s.world, version: s.version }));
  const c = client();
  const [pick, setPick] = useState<string | null>(null);
  void version;
  if (!player || !world) return null;
  const r = world.ruleset;
  const ix = rx(r);
  const ch = player.party.find((x) => x.id === selected) ?? player.party[0]!;
  const cls = ix.cls.get(ch.classId);
  const stats = c.charStats(ch);
  const known = knownSkills(r, ch);
  const assign = (slot: number) => {
    if (!pick) return;
    const hb = Array.from({ length: 10 }, (_, i) => ch.hotbar[i] ?? null);
    const existing = hb.indexOf(pick);
    if (existing >= 0) hb[existing] = null;
    hb[slot] = pick;
    c.send({ t: 'set_hotbar', charId: ch.id, hotbar: hb });
    setPick(null);
  };
  const tiers = r.progression.tierRequirements.length;
  return (
    <Window title="Talents" onClose={onClose} className="talents" style={{ left: '50%', transform: 'translateX(-50%)', top: 60, width: 'min(1040px, calc(100% - 40px))' }}>
      <div className="tabs">
        <PartyTabs ch={ch} mark={(p) => p.treePoints > 0} />
        <div className="spacer" />
        <div className={`tab ${ch.treePoints ? 'gold glow' : 'muted'}`} style={{ cursor: 'default' }}>{ch.treePoints} point{ch.treePoints === 1 ? '' : 's'} to spend</div>
      </div>
      <div className="panel-body col" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <div className="col" style={{ gap: 4, flex: 'none' }}>
            <div className="label">Hotbar {pick ? '— click a slot' : ''}</div>
            <div className="row" style={{ gap: 4 }}>
              {Array.from({ length: 10 }, (_, i) => {
                const id = ch.hotbar[i];
                return (
                  <div key={i} className={`slot sm ${pick ? 'on' : ''}`} onClick={() => (pick ? assign(i) : id && c.send({ t: 'set_hotbar', charId: ch.id, hotbar: ch.hotbar.map((x, j) => (j === i ? null : x)) }))} {...tip(id ? <SkillTooltip id={id} r={r} stats={stats} rank={skillRank(r, ch, id)} /> : 'Empty')}>
                    <span className="key">{(i + 1) % 10}</span>
                    {id && <SkillIcon id={id} size={34} />}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
            <div className="label">Known skills — click one, then a hotbar slot</div>
            <div className="row wrap" style={{ gap: 4 }}>
              {known.map((id) => (
                <div key={id} className={`slot sm ${pick === id ? 'on' : ''} ${ch.hotbar.includes(id) ? '' : 'unslotted'}`} onClick={() => setPick(pick === id ? null : id)} {...tip(<SkillTooltip id={id} r={r} stats={stats} rank={skillRank(r, ch, id)} />)}>
                  <SkillIcon id={id} size={34} />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="ornament" />
        <div className="tree">
          {cls?.branches.map((b) => {
            const spent = branchSpent(r, ch, b.id);
            return (
              <div key={b.id} className="branch">
                <div className="branch-head" {...tip(<div><div className="tname gold">{b.name}</div><div className="tdesc" style={{ marginTop: 0 }}>{b.description}</div></div>)}>
                  <div className="display">{b.name}</div>
                  <div className="tiny muted">{spent} spent</div>
                </div>
                {Array.from({ length: tiers }, (_, tier) => {
                  const nodes = cls.nodes.filter((n) => n.branch === b.id && n.tier === tier);
                  if (!nodes.length) return null;
                  const req = r.progression.tierRequirements[tier] ?? 0;
                  const open = spent >= req;
                  return (
                    <div key={tier} className={`tier ${open ? 'open' : 'closed'}`}>
                      {tier > 0 && <div className="tier-req">{open ? `Tier ${tier + 1}` : `Tier ${tier + 1} — ${req - spent} more`}</div>}
                      {nodes.map((n) => <NodeCard key={n.id} ch={ch} node={n} />)}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div className="branch attrs">
            <div className="branch-head">
              <div className="display">Attributes</div>
              <div className="tiny muted">+{r.progression.attributePerRank} per point</div>
            </div>
            <div className="tier open">
              {r.attributeNodes.map((n) => <NodeCard key={n.id} ch={ch} node={n} />)}
            </div>
          </div>
        </div>
        <div className="hint">You gain {r.progression.treePointsPerLevel} point{r.progression.treePointsPerLevel === 1 ? '' : 's'} each {r.terminology.level.toLowerCase()}. Deeper tiers open as you invest in a branch. Choices are permanent. Trainers can also teach skills from your tree.</div>
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
  const t = world.ruleset.terminology;
  const active = quests.filter((q) => q.p.status === 'active');
  const main = active.filter((q) => q.d.main);
  const side = active.filter((q) => !q.d.main);
  const done = quests.filter((q) => q.p.status !== 'active');
  const cur = quests.find((q) => q.d.id === sel) ?? main[0] ?? side[0] ?? done[0];
  const objs = (q: { d: QuestDef; p: (typeof quests)[number]['p'] }): QuestObjective[] => q.p.overrides ?? q.d.objectives;
  const row = (q: (typeof quests)[number]) => (
    <div key={q.d.id} className={`quest ${cur?.d.id === q.d.id ? 'on' : ''}`} onClick={() => setSel(q.d.id)}>
      <div className="qt">{trackedQuest(player)?.id === q.d.id && <span className="pin-dot" title="Shown on the HUD" />}{q.d.title}</div>
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
                <div className="small muted" style={{ marginTop: 6 }}>Reward: {cur.d.rewards.xp} {t.xp}, {cur.d.rewards.gold} {t.currency}{cur.d.rewards.items.length ? ', and an item' : ''}</div>
                <div className="ornament" />
                {cur.p.log.slice(-8).map((l, i) => (
                  <div key={i} className="tiny dim">Day {l.day}: {l.text}</div>
                ))}
                {cur.p.status === 'active' && (
                  <div className="row" style={{ gap: 6 }}>
                    {trackedQuest(player)?.id === cur.d.id
                      ? <button className="btn sm" onClick={() => c.send({ t: 'pin_quest', questId: '' })}>Unpin from HUD</button>
                      : <button className="btn sm primary" onClick={() => c.send({ t: 'pin_quest', questId: cur.d.id })}>Pin to HUD</button>}
                    {!cur.d.main && <button className="btn sm ghost" onClick={() => confirm(`Abandon this ${t.quest.toLowerCase()}?`) && c.send({ t: 'abandon_quest', questId: cur.d.id })}>Abandon</button>}
                  </div>
                )}
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
  const t = world.ruleset.terminology;
  const outer = zone.id;
  const leader = c.leaderEntity();
  const nearWaypoint = zone.features.some((f) => f.kind === 'waypoint' && leader && Math.hypot(f.x - leader.x, f.y - leader.y) < 3);
  const canTravelTo = (id: string) => nearWaypoint && id !== outer && world.zones.find((z) => z.id === id)?.kind === 'town' && player.waypoints.some((w) => w.zoneId === id);
  return (
    <Window title={world.concept.title} onClose={onClose} className="map-window" style={{ left: '50%', top: 60, transform: 'translateX(-50%)', width: MAP_W + 26 }}>
      <div className="panel-body" style={{ padding: 12 }}>
        <WorldMapView world={world} player={player} here={outer} canTravelTo={canTravelTo} onTravel={(id) => (c.send({ t: 'fast_travel', zoneId: id }), onClose())}
          terms={{ town: t.town, dungeon: t.dungeon, wilderness: t.wilderness, level: t.level }} />
        {world.ruleset.systems.fastTravel && <div className="hint" style={{ marginTop: 8 }}>{nearWaypoint ? 'Click a place with a waypoint ring to travel there.' : `Stand by a waypoint in a ${t.town.toLowerCase()} to travel between visited ${t.town.toLowerCase()}s.`}</div>}
      </div>
    </Window>
  );
}

// =================================================================================== crafting

export function CraftWindow({ onClose }: { onClose: () => void }) {
  const { player, world, selected, zone, entities } = useGame((s) => ({ player: s.player, world: s.world, selected: s.selectedCharId, zone: s.zone, entities: s.entities }));
  const c = client();
  const r = world?.ruleset;
  void entities;
  const leader = c.leaderEntity();
  const atBench = !!zone && nearStation(zone.features, leader);
  const benchName = zone?.features.find((f) => f.kind === 'craft_station')?.name ?? 'workbench';
  const tabs = r ? ([r.crafting.enabled && r.recipes.length ? 'recipes' : null, r.crafting.upgrades.enabled ? 'upgrade' : null, r.crafting.enchanting.enabled ? 'enchant' : null].filter(Boolean) as ('recipes' | 'upgrade' | 'enchant')[]) : [];
  const [tab, setTab] = useState<'recipes' | 'upgrade' | 'enchant'>(tabs[0] ?? 'recipes');
  const [itemId, setItemId] = useState<string | null>(null);
  if (!player || !world || !r) return null;
  const ix = rx(r);
  const cur = r.terminology.currency;
  const have = (baseId: string) => player.inventory.filter((i) => i.baseId === baseId).reduce((s, i) => s + i.qty, 0);
  const lvl = Math.max(...player.party.map((p) => p.level));
  const ch = player.party.find((x) => x.id === selected) ?? player.party[0]!;
  // Equipment you can work on: what the party wears, then the pack.
  const gear: { item: ItemInstance; owner?: CharacterState }[] = [
    ...player.party.flatMap((p) => Object.values(p.equipment).filter((x): x is ItemInstance => !!x).map((item) => ({ item, owner: p }))),
    ...player.inventory.filter((i) => ix.item.get(i.baseId)?.category === 'equipment').map((item) => ({ item })),
  ];
  const chosen = gear.find((g) => g.item.id === itemId) ?? gear[0];
  const costRow = (cost: { gold: number; material?: { id: string; name: string }; qty: number }) => (
    <div className="tiny">
      <span style={{ marginRight: 10, color: player.gold >= cost.gold ? 'var(--good)' : 'var(--danger)' }}>{cost.gold} {cur}</span>
      {cost.material && <span style={{ color: have(cost.material.id) >= cost.qty ? 'var(--good)' : 'var(--danger)' }}>{cost.material.name} {have(cost.material.id)}/{cost.qty}</span>}
    </div>
  );
  const affordable = (cost: { gold: number; material?: { id: string }; qty: number }) => player.gold >= cost.gold && (!cost.material || have(cost.material.id) >= cost.qty);
  return (
    <Window title="Crafting" onClose={onClose} style={{ left: 260, top: 70, width: 600 }}>
      {tabs.length > 1 && (
        <div className="tabs">
          {tabs.map((tb) => (
            <div key={tb} className={`tab ${tab === tb ? 'on' : ''}`} onClick={() => setTab(tb)}>{{ recipes: 'Recipes', upgrade: 'Improve', enchant: 'Enchant' }[tb]}</div>
          ))}
          <div className="spacer" />
          <div className="tab gold" style={{ cursor: 'default' }}>{player.gold} {cur}</div>
        </div>
      )}
      <div className={`bench-note ${atBench ? 'at' : ''}`}>
        {atBench ? `At the ${benchName.toLowerCase()}: everything can be made here.` : `Away from a workbench, only remedies and tools can be made. Gear, improving and enchanting need a workbench; every ${r.terminology.town.toLowerCase()} has one.`}
      </div>
      {tab === 'recipes' && (
        <div className="panel-body col" style={{ maxHeight: 520, overflow: 'auto' }}>
          {r.recipes.map((rc) => {
            const field = fieldRecipe(r, rc);
            const ok = rc.inputs.every((i) => have(i.itemId) >= i.qty) && player.gold >= rc.gold && (field || atBench);
            const out = rc.output;
            const outBase = 'itemId' in out ? ix.item.get(out.itemId) : undefined;
            const rar = 'rarityId' in out ? ix.rarity.get(out.rarityId) : undefined;
            const outName = outBase ? outBase.name : `${rar?.name ?? ''} ${r.slots.find((s) => s.kind === ('slotKind' in out ? out.slotKind : ''))?.name.toLowerCase() ?? 'item'}`;
            const iconBase = outBase?.id ?? r.items.find((i) => i.slotId && ix.slot.get(i.slotId)?.kind === ('slotKind' in out ? out.slotKind : ''))?.id ?? 'quest_item';
            return (
              <div key={rc.id} className={`recipe ${ok ? '' : 'na'}`}>
                <ItemIcon item={{ baseId: iconBase, rarityId: rar?.id ?? r.rarities[0]?.id }} url={outBase ? iconUrl(outBase.id) : undefined} />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{rc.name}{!field && <span className={`badge ${atBench ? 'gray' : 'red'}`} style={{ marginLeft: 6 }}>Workbench</span>}</div>
                  <div className="tiny muted">→ {outName}{'qty' in out && out.qty > 1 ? ` ×${out.qty}` : ''}{!outBase ? ` (${r.terminology.level.toLowerCase()} ${lvl})` : ''}</div>
                  <div className="tiny">
                    {rc.inputs.map((i) => (
                      <span key={i.itemId} style={{ marginRight: 10, color: have(i.itemId) >= i.qty ? 'var(--good)' : 'var(--danger)' }}>
                        {ix.item.get(i.itemId)?.name ?? i.itemId} {have(i.itemId)}/{i.qty}
                      </span>
                    ))}
                    {rc.gold > 0 && <span style={{ color: player.gold >= rc.gold ? 'var(--good)' : 'var(--danger)' }}>{rc.gold} {cur}</span>}
                  </div>
                </div>
                <button className="btn sm primary" disabled={!ok} onClick={() => c.send({ t: 'craft', recipeId: rc.id, charId: ch.id })}>Craft</button>
              </div>
            );
          })}
          <div className="hint">Materials drop from foes and chests, and can be bought from merchants.</div>
        </div>
      )}
      {(tab === 'upgrade' || tab === 'enchant') && (
        <div className="panel-body row" style={{ alignItems: 'flex-start', gap: 14 }}>
          <div className="items" style={{ width: 250, maxHeight: 440, overflow: 'auto', flex: 'none' }}>
            {gear.map((g) => (
              <ItemCell key={g.item.id} item={g.item} selected={chosen?.item.id === g.item.id} onClick={() => setItemId(g.item.id)} />
            ))}
            {!gear.length && <div className="muted small">No equipment.</div>}
          </div>
          {chosen && (
            <div className="grow col">
              <div className="row" style={{ gap: 10 }}>
                <ItemIcon item={chosen.item} size={48} url={iconUrl(chosen.item.baseId)} />
                <div>
                  <div style={{ fontWeight: 600, color: chosen.item.uniqueId ? '#ffd24a' : ix.rarity.get(chosen.item.rarityId)?.color }}>{c.itemName(chosen.item)}</div>
                  <div className="tiny muted">{chosen.owner ? `Worn by ${chosen.owner.name}` : 'In your pack'}</div>
                </div>
              </div>
              {tab === 'upgrade' && (() => {
                const cost = upgradeCost(r, chosen.item);
                const lv = chosen.item.upgrade ?? 0;
                return (
                  <div className="col" style={{ gap: 6 }}>
                    <div className="small">Improvement +{lv} of {r.crafting.upgrades.maxLevel}: each level adds {Math.round(r.crafting.upgrades.perLevel * 100)}% base damage or defence.</div>
                    {cost ? (
                      <div className="offer-row">
                        <div className="grow">
                          <div>Improve to +{lv + 1}</div>
                          {costRow(cost)}
                        </div>
                        <button className="btn sm primary" disabled={!affordable(cost) || !atBench} onClick={() => c.send({ t: 'upgrade_item', itemId: chosen.item.id, charId: chosen.owner?.id })}>Improve</button>
                      </div>
                    ) : (
                      <div className="muted small">Fully improved.</div>
                    )}
                  </div>
                );
              })()}
              {tab === 'enchant' && (() => {
                const cost = enchantCost(r, chosen.item);
                if (!cost) return <div className="muted small">{chosen.item.uniqueId ? 'Unique items cannot be enchanted.' : 'This cannot be enchanted.'}</div>;
                const maxAff = (ix.rarity.get(chosen.item.rarityId)?.affixes[1] ?? 0) + 1;
                return (
                  <div className="col" style={{ gap: 6 }}>
                    <div className="small">Replace one bonus with a new random one{chosen.item.affixes.length < maxAff ? ', or add a new bonus' : ''}.</div>
                    {costRow(cost)}
                    {chosen.item.affixes.map((a, i) => {
                      const def = ix.affix.get(a.affixId);
                      return (
                        <div key={i} className="offer-row">
                          <div className="grow small">{def ? modifierLabel(r, { stat: def.stat, value: a.value }, chosen.item.level) : a.affixId}</div>
                          <button className="btn sm" disabled={!affordable(cost) || !atBench} onClick={() => c.send({ t: 'enchant_item', itemId: chosen.item.id, affixIndex: i, charId: chosen.owner?.id })}>Reroll</button>
                        </div>
                      );
                    })}
                    {chosen.item.affixes.length < maxAff && (
                      <div className="offer-row">
                        <div className="grow small muted">Empty bonus</div>
                        <button className="btn sm primary" disabled={!affordable(cost) || !atBench} onClick={() => c.send({ t: 'enchant_item', itemId: chosen.item.id, affixIndex: -1, charId: chosen.owner?.id })}>Add</button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}
      {!tabs.length && <div className="panel-body muted">There is no crafting in this daydream.</div>}
    </Window>
  );
}

// =================================================================================== menu

export function MenuWindow({ onClose, onHelp, onCodex }: { onClose: () => void; onHelp: () => void; onCodex: () => void }) {
  const { player, open, isOwner, instanceName, world } = useGame((s) => ({ player: s.player, open: s.open, isOwner: s.isOwner, instanceName: s.instanceName, world: s.world }));
  const c = client();
  const [name, setName] = useState('');
  const [saved, setSaved] = useState('');
  if (!player || !world) return null;
  const r = world.ruleset;
  return (
    <Window title={instanceName ?? 'Menu'} onClose={onClose} style={{ left: '50%', top: '14%', transform: 'translateX(-50%)', width: 430 }}>
      <div className="panel-body col">
        <div className="label">Keep a memory</div>
        <div className="row">
          <input className="input grow" placeholder="Name this memory" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn" onClick={() => { c.send({ t: 'hard_save', name }); setSaved('Kept. You can return to this moment from the daydream page.'); setName(''); }}>Keep</button>
        </div>
        <div className="hint">{saved || 'Progress is kept as you play. A memory is a moment you can return to later from the daydream page.'}</div>
        <div className="ornament" />
        <div className="label">Difficulty</div>
        <div className="seg">
          {DIFFICULTIES.map((d) => (
            <button key={d} className={`btn sm ${player.difficulty === d ? 'primary' : 'ghost'}`} disabled={!isOwner} onClick={() => c.send({ t: 'set_difficulty', difficulty: d })}>{r.difficulty[d].name}</button>
          ))}
        </div>
        <div className="hint">{isOwner ? 'Changes your foes from the next fight on. See the codex for details.' : 'Only the owner of this reverie can change it.'}</div>
        <div className="ornament" />
        <label className="row small" style={{ cursor: isOwner ? 'pointer' : 'default', opacity: isOwner ? 1 : 0.5 }}>
          <input type="checkbox" disabled={!isOwner} checked={open} onChange={(e) => { c.send({ t: 'set_options', open: e.target.checked }); c.update({ open: e.target.checked }); }} />
          Let other dreamers join this reverie (experimental)
        </label>
        {world.input.combatMode === 'party_npc' && (
          <label className="row small" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={player.commandCompanions} onChange={(e) => c.send({ t: 'set_options', commandCompanions: e.target.checked })} />
            I command my companions in combat (otherwise they act on their own)
          </label>
        )}
        <div className="ornament" />
        <div className="row">
          <button className="btn" onClick={onHelp}>Controls</button>
          <button className="btn" onClick={onCodex}>Codex</button>
          <div className="spacer" />
          <button className="btn danger" onClick={() => navigate(`#/world/${world.id}`)}>Leave world</button>
        </div>
      </div>
    </Window>
  );
}

export function HelpWindow({ onClose }: { onClose: () => void }) {
  const world = useGame((s) => s.world);
  const r = world?.ruleset;
  const t = r?.terminology;
  const rows: [string, string][] = [
    ['Left click ground', 'Move (in combat: move the active character)'],
    ['Left click person', 'Talk'],
    ['Left click enemy', 'Attack (walks into range first)'],
    ['Left click object', `Use: ways out, chests, signs and notes${r?.systems.traps ? '; disarm traps you have spotted' : ''}`],
    ['Left click loot / chest', 'Take everything (and nearby drops)'],
    ['Shift + click loot / chest', 'Open it and choose items'],
    ['1 – 0', 'Ready a skill, then click a target'],
    ['Right click / Esc', 'Cancel targeting · close windows'],
    ['Space / Enter', 'End turn'],
    ['I · C · K · J · M', 'Inventory · Character · Talents · Quests · Map'],
    ['B · X', 'Crafting · Codex'],
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
          Combat is turn-based: each turn grants {t?.actionPoints ?? 'action points'}, and moving and acting spend them. The codex (X) explains the rules of this daydream.
        </p>
        <p className="hint">You can say anything to anyone. People remember what you tell them, react to gifts and abilities, and may change your {t?.quest.toLowerCase() ?? 'quest'}s in response.</p>
      </div>
    </Window>
  );
}

// =================================================================================== codex

export function CodexWindow({ onClose }: { onClose: () => void }) {
  const world = useGame((s) => s.world);
  if (!world) return null;
  return (
    <Window title={`Codex — ${world.ruleset.name}`} onClose={onClose} className="codex" style={{ left: '50%', top: 60, transform: 'translateX(-50%)', width: 'min(900px, calc(100% - 40px))', height: 'min(680px, calc(100% - 140px))' }}>
      <CodexView ruleset={world.ruleset} />
    </Window>
  );
}

/** The rules of a world, generated from its ruleset (game window and world page). */
export function CodexView({ ruleset }: { ruleset: Ruleset }) {
  const sections = useMemo(() => codexSections(ruleset), [ruleset]);
  const [sel, setSel] = useState('basics');
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const match = (e: { title: string; text?: string; lines: string[] }) => !query || [e.title, e.text ?? '', ...e.lines].some((s) => s.toLowerCase().includes(query));
  const shown = query ? sections.map((s) => ({ ...s, entries: s.entries.filter(match) })).filter((s) => s.entries.length) : sections.filter((s) => s.id === sel);
  return (
    <div className="row" style={{ alignItems: 'stretch', flex: 1, minHeight: 0, gap: 0 }}>
      <div className="scroll codex-nav">
        <input className="input" placeholder="Search the rules…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {sections.map((s) => (
          <div key={s.id} className={`quest ${!query && sel === s.id ? 'on' : ''}`} onClick={() => { setSel(s.id); setQ(''); }}>
            <div className="qt">{s.title}</div>
          </div>
        ))}
      </div>
      <div className="grow scroll panel-body">
        {shown.map((s) => (
          <div key={s.id} className="col" style={{ gap: 10, marginBottom: 16 }}>
            <div className="display gold" style={{ fontSize: 22 }}>{s.title}</div>
            {s.intro && <div className="serif" style={{ fontSize: 16, lineHeight: 1.5 }}>{s.intro}</div>}
            <div className="codex-grid">
              {s.entries.map((e, i) => (
                <div key={i} className="codex-entry" style={e.color ? ({ '--ec': e.color } as React.CSSProperties) : undefined}>
                  <div className="ce-title">{e.color && <span className="swatch" />}{e.title}</div>
                  {e.text && <div className="ce-text">{e.text}</div>}
                  {e.lines.map((l, j) => <div key={j} className="ce-line">{l}</div>)}
                </div>
              ))}
            </div>
          </div>
        ))}
        {!shown.length && <div className="muted">Nothing matches “{q}”.</div>}
      </div>
    </div>
  );
}
