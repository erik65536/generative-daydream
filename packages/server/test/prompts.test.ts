import { describe, expect, it } from 'vitest';
import type { WorldInput } from '@gd/shared';
import { brief } from '../src/worldgen/prompts';
import { PLAIN_TERMS, corePrompt } from '../src/rules/prompts';

const input: WorldInput = {
  theme: 'A cozy woodland of talking animals.',
  prompts: [
    { topic: 'monsters', text: 'No undead.' },
    { topic: 'art', text: 'Watercolour.' },
    { topic: 'rules', text: 'Call the money acorns.' },
  ],
  size: 'small', length: 'short', communication: 2, combatMode: 'party_npc',
};

describe('extra prompts', () => {
  it('reach only the steps they are aimed at', () => {
    const monsters = brief(input, ['monsters']);
    expect(monsters).toContain('A cozy woodland');
    expect(monsters).toContain('No undead.');
    expect(monsters).not.toContain('Watercolour.');
    expect(brief(input, ['story', 'places'])).not.toMatch(/No undead|Watercolour|acorns/);
    expect(corePrompt(`WORLD\n\n${brief(input, ['rules'])}`, input)).toContain('Call the money acorns.');
  });

  it('ask the rules designer for plain words', () => {
    expect(PLAIN_TERMS).toMatch(/Health/);
    expect(PLAIN_TERMS).toMatch(/Never invent/);
  });
});
