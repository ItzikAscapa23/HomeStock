import { contentWords, prefixVariants } from './normalise.js';

export interface LocalMatch {
  itemId: string;
  /** The phrase as it appeared (normalised), e.g. "והחלב". */
  mention: string;
}

export interface LocalMatchResult {
  matches: LocalMatch[];
  /** Content words not covered by any alias. Non-empty → the message isn't fully understood locally. */
  leftover: string[];
  /** Number of content words (after fillers). 0 → nothing item-like in the message. */
  contentWordCount: number;
}

const MAX_PHRASE_WORDS = 4;

/**
 * Exact alias matching (R22). Greedy, longest phrase first, non-overlapping.
 * Prefixes are stripped from the first word of a phrase only ("והשמן זית" → "שמן זית").
 */
export function matchLocally(text: string, aliasIndex: ReadonlyMap<string, string>): LocalMatchResult {
  const words = contentWords(text);
  const covered = new Array<boolean>(words.length).fill(false);
  const found: { at: number; match: LocalMatch }[] = [];

  for (let len = Math.min(MAX_PHRASE_WORDS, words.length); len >= 1; len--) {
    for (let start = 0; start + len <= words.length; start++) {
      if (covered.slice(start, start + len).some(Boolean)) continue;
      const [first = '', ...rest] = words.slice(start, start + len);
      for (const head of prefixVariants(first)) {
        const phrase = [head, ...rest].join(' ');
        const itemId = aliasIndex.get(phrase);
        if (itemId) {
          for (let i = start; i < start + len; i++) covered[i] = true;
          found.push({ at: start, match: { itemId, mention: [first, ...rest].join(' ') } });
          break;
        }
      }
    }
  }

  // Report order follows the message; the same item mentioned twice counts once.
  const seen = new Set<string>();
  const matches = found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.match)
    .filter((m) => !seen.has(m.itemId) && seen.add(m.itemId));

  return {
    matches,
    leftover: words.filter((_, i) => !covered[i]),
    contentWordCount: words.length,
  };
}
