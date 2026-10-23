import { describe, expect, it } from 'vitest';
import { kinPresentation, type Presentation } from '@gd/shared';

const kins = (n: number, tag = 'k') => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}` }));
const tally = (ks: { id: string }[]) => {
  const out: Record<Presentation, number> = { feminine: 0, masculine: 0, androgynous: 0 };
  for (const k of ks) out[kinPresentation(ks, k.id)]++;
  return out;
};

describe('kin presentations', () => {
  it('gives every kin one presentation, the same every time', () => {
    const ks = kins(5);
    expect(ks.map((k) => kinPresentation(ks, k.id))).toEqual(ks.map((k) => kinPresentation(ks, k.id)));
  });

  it('balances them: about a quarter androgynous, the rest split between feminine and masculine', () => {
    for (const n of [3, 4, 5, 6, 8]) {
      const t = tally(kins(n, `w${n}_`));
      expect(t.androgynous).toBe(Math.max(1, Math.round(n / 4)));
      expect(Math.abs(t.feminine - t.masculine)).toBeLessThanOrEqual(1);
    }
    const two = tally(kins(2));
    expect(two.feminine).toBe(1);
    expect(two.masculine).toBe(1);
  });
});
