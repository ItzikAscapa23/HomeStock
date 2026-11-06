/**
 * Hebrew text normalisation for alias matching (R22).
 *
 * This is deliberately NOT a parser. It only produces candidate phrases; deciding what
 * a message means is the registry's job (exact alias match) and, failing that, the
 * LLM's. Anything this module can't handle falls through to the LLM — it never guesses.
 */

/** Words that carry no item identity in a depletion report. Compared after normalise(). */
const FILLER = new Set([
  // depletion / need markers
  'נגמר', 'נגמרה', 'נגמרו', 'נגמרנו', 'נגמרת', 'גמרנו', 'סיימנו', 'אין', 'אזל', 'אזלה', 'אזלו',
  'חסר', 'חסרה', 'חסרים', 'חסרות', 'צריך', 'צריכה', 'צריכים', 'לקנות', 'קנו', 'תקנו', 'תקנה',
  'תביא', 'תביאי', 'תביאו', 'להביא', 'להוסיף', 'תוסיפו', 'תוסיף',
  // pronouns, particles, politeness
  'לנו', 'לי', 'כבר', 'את', 'גם', 'עוד', 'שוב', 'בבית', 'בבקשה', 'פליז', 'ממש', 'כמעט', 'הכל', 'כל',
  'נשאר', 'נשארה', 'נשארו', 'מעט', 'קצת', 'וגם', 'ו', 'של',
  // units and packaging
  'קרטון', 'קרטונים', 'בקבוק', 'בקבוקים', 'חבילה', 'חבילות', 'שקית', 'שקיות', 'קופסה', 'קופסת',
  'קופסאות', 'פחית', 'פחיות', 'גליל', 'גלילים', 'חפיסה', 'חפיסות', 'מגש', 'מגשים', 'קילו', 'קג',
  'ליטר', 'גרם', 'יחידה', 'יחידות', 'זוג', 'תבנית', 'צנצנת',
  // small numbers
  'אחד', 'אחת', 'שני', 'שתי', 'שניים', 'שתיים', 'שלוש', 'שלושה', 'ארבע', 'ארבעה',
]);

/**
 * Stock-in markers: past-tense "bought / brought / arrived". Deliberately excludes "קנו" and
 * "קנה", which are also imperatives ("buy!") — those stay depletion fillers or go to the LLM.
 */
const IN_WORDS = new Set([
  'קניתי', 'קנינו', 'קנתה', 'הבאתי', 'הבאנו', 'הביא', 'הביאה', 'נכנס', 'נכנסה', 'נכנסו',
  'הגיע', 'הגיעה', 'הגיעו', 'חידשתי', 'חידשנו', 'מילאתי', 'מילאנו',
]);

/** Question openers. Never part of an item's name. */
const QUERY_OPENERS = new Set(['האם', 'יש']);

export type MessageIntent = 'out' | 'in' | 'query';

/**
 * What a message is about, from wording alone: a question (a "?" or opening with האם / יש),
 * a stock-in ("קניתי חלב"), otherwise a depletion report. `explicit` is false for the
 * default — the LLM may then decide differently when it is consulted anyway.
 */
export function detectIntent(text: string): { intent: MessageIntent; explicit: boolean } {
  const words = normalise(text).split(' ').filter(Boolean);
  const first = words[0];
  if (/[?？]/.test(text) || (first !== undefined && QUERY_OPENERS.has(first))) return { intent: 'query', explicit: true };
  if (words.some((w) => prefixVariants(w).some((v) => IN_WORDS.has(v)))) return { intent: 'in', explicit: true };
  return { intent: 'out', explicit: false };
}

/** Prefix letters that fuse onto the next word: ו ה ב ל מ ש כ (חלב / החלב / בחלב / והחלב). */
const PREFIX_LETTERS = new Set(['ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ']);
const MAX_PREFIX_STRIP = 3;
const MIN_STEM_LENGTH = 2;

/**
 * Lower-case, drop niqqud and cantillation, geresh/quotes, punctuation and bare numbers;
 * collapse whitespace. Percentages survive as tokens ("3%"), because items are
 * variant-level (Q3): "חלב 3%" and "חלב 1%" are different items, while "2 ליטר" is noise.
 */
export function normalise(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[֑-ׇ]/g, (c) => (c === '־' ? ' ' : '')) // niqqud; maqaf → space
    .replace(/[׳״'"`׳״]/g, '') // geresh, gershayim, quotes (ק"ג → קג)
    .replace(/[^\p{L}\p{N}%\s]/gu, ' ')
    .replace(/(\d+)\s*%/g, ' $1% ') // "3 %" / "3%שומן" → " 3% "
    .replace(/\d+(?![\d%])/g, ' ') // numbers that aren't percentages
    .replace(/(^|\s)%+(?=\s|$)/g, ' ') // a lone % left behind
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The word as written, then with fused prefixes peeled off one at a time
 * ("והחלב" → ["והחלב", "החלב", "חלב"]). The unstripped form always comes first so
 * a real word that starts with a prefix letter ("מלח", "ביצים") matches before any
 * stripped form is tried.
 */
export function prefixVariants(word: string): string[] {
  const out = [word];
  let w = word;
  for (let i = 0; i < MAX_PREFIX_STRIP; i++) {
    const first = w[0];
    if (!first || !PREFIX_LETTERS.has(first) || w.length - 1 < MIN_STEM_LENGTH) break;
    w = w.slice(1);
    out.push(w);
  }
  return out;
}

export function isFiller(word: string): boolean {
  return prefixVariants(word).some((v) => FILLER.has(v) || IN_WORDS.has(v) || QUERY_OPENERS.has(v));
}

/** Normalised words with fillers removed — what's left should name items. */
export function contentWords(text: string): string[] {
  return normalise(text)
    .split(' ')
    .filter((w) => w.length > 0 && !isFiller(w));
}

/** Normalise an alias for storage, so stored aliases and message phrases compare equal. */
export function normaliseAlias(alias: string): string {
  return normalise(alias);
}
