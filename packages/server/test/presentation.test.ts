import { describe, expect, it } from 'vitest';
import { kinPresentations, type Presentation } from '@gd/shared';

const tally = (ps: Presentation[]) => {
  const out: Record<Presentation, number> = { feminine: 0, masculine: 0, androgynous: 0 };
  for (const p of ps) out[p]++;
  return out;
};

describe('kin genders', () => {
  it('gives every kin one gender, the same for the same world', () => {
    expect(kinPresentations(4, 'w1')).toEqual(kinPresentations(4, 'w1'));
  });

  it('balances them: about a quarter androgynous, the rest split between feminine and masculine', () => {
    for (const n of [3, 4]) {
      const t = tally(kinPresentations(n, `w${n}`));
      expect(t.androgynous).toBe(Math.max(1, Math.round(n / 4)));
      expect(Math.abs(t.feminine - t.masculine)).toBeLessThanOrEqual(1);
    }
    const two = tally(kinPresentations(2, 'w2'));
    expect(two.feminine).toBe(1);
    expect(two.masculine).toBe(1);
  });
});
