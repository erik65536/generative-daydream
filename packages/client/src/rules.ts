/** The current world's ruleset for drawing code (icons, fx, renderer) that runs outside React. */
import { rx, type Ruleset } from '@gd/shared';

let current: Ruleset | null = null;

export function setRules(r: Ruleset | null | undefined) {
  current = r ?? null;
}

export function rules(): Ruleset | null {
  return current;
}

/** Colour of a damage subtype/type, status, or the special 'heal' / 'barrier'. */
export function kindColor(id: string | undefined, fallback = '#ffffff'): string {
  if (!id) return fallback;
  if (id === 'heal') return '#7dff9a';
  if (id === 'barrier') return '#9fd8ff';
  const r = current;
  if (!r) return fallback;
  const ix = rx(r);
  return ix.subtype.get(id)?.color ?? ix.type.get(id)?.color ?? ix.status.get(id)?.color ?? ix.surface.get(id)?.color ?? fallback;
}

export function statusName(id: string): string {
  return (current && rx(current).status.get(id)?.name) ?? id;
}

/** Weapon shape for procedural figures, from the item in the weapon slot. */
export function weaponVisual(ch: { equipment: Record<string, { baseId: string } | undefined> }): string | undefined {
  const r = current;
  if (!r) return undefined;
  const ix = rx(r);
  const slot = r.slots.find((s) => s.kind === 'weapon');
  const it = slot ? ch.equipment[slot.id] : undefined;
  const icon = it ? ix.item.get(it.baseId)?.icon : undefined;
  return icon && ['sword', 'axe', 'dagger', 'bow', 'staff', 'wand'].includes(icon) ? icon : undefined;
}
