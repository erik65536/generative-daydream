/**
 * The broad genre of a setting, guessed from the user's prompt (picks themed rule defaults).
 */

export type Genre = 'fantasy' | 'scifi' | 'cozy' | 'modern' | 'horror' | 'whimsy';

const KEYWORDS: Record<Genre, string[]> = {
  scifi: ['space', 'star', 'planet', 'galaxy', 'robot', 'cyber', 'android', 'alien', 'ship', 'laser', 'future', 'mech', 'colony', 'orbital', 'sci-fi', 'scifi'],
  cozy: ['cozy', 'animal', 'bunny', 'rabbit', 'fox', 'badger', 'mouse', 'children', 'kids', 'gentle', 'cute', 'meadow', 'tea', 'woodland'],
  modern: ['office', 'printer', 'city', 'corporate', 'cubicle', 'mall', 'suburb', 'modern', 'present day', 'real world', 'coffee', 'commute', 'comedy'],
  horror: ['horror', 'eldritch', 'cosmic', 'nightmare', 'haunted', 'zombie', 'undead', 'sanity', 'dread', 'cult', 'lovecraft', 'gothic'],
  whimsy: ['wonderland', 'insane', 'dream', 'absurd', 'puzzle', 'mad', 'surreal', 'candy', 'clockwork', 'topsy'],
  fantasy: ['dragon', 'magic', 'kingdom', 'sword', 'elf', 'dwarf', 'wizard', 'fantasy', 'd&d', 'dungeon', 'knight', 'orc'],
};

export function detectGenre(text: string): Genre {
  const t = text.toLowerCase();
  let best: Genre = 'fantasy';
  let bestScore = 0;
  for (const [g, words] of Object.entries(KEYWORDS) as [Genre, string[]][]) {
    const score = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = g;
      bestScore = score;
    }
  }
  return best;
}

