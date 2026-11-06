import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher/dispatcher.js';
import type { InboundCallback, InboundMessage } from '../src/domain/message.js';
import { StockService } from '../src/inventory/stock.js';
import { detectIntent } from '../src/registry/normalise.js';
import { ItemRegistry } from '../src/registry/item-registry.js';
import { Resolver } from '../src/registry/resolver.js';
import { ShoppingList } from '../src/shopping/shopping-list.js';
import {
  exampleItems,
  FakeLlm,
  MemItemStore,
  MemListStore,
  MemMessageLog,
  MemPendingStore,
  MemPurchaseStore,
} from './fakes.js';

const GROUP = -555;
const AT = new Date('2026-11-06T08:00:00Z'); // 10:00 in Israel

function setup(answers: unknown[] = []) {
  const items = new MemItemStore(exampleItems());
  const list = new MemListStore();
  const pending = new MemPendingStore();
  const purchases = new MemPurchaseStore();
  const llm = new FakeLlm(answers);
  const make = () => {
    const registry = new ItemRegistry(items);
    const shopping = new ShoppingList(items, list);
    let n = 0;
    return new Dispatcher({
      gate: { isAllowed: async () => true },
      registry,
      resolver: new Resolver(registry, llm),
      shopping,
      pending,
      log: new MemMessageLog(),
      stock: new StockService(shopping, list, purchases, registry),
      newId: () => `x${++n}`,
      logError: () => {},
    });
  };
  return { d: make(), make, items, list, pending, purchases, llm };
}

let uid = 5000;
const msg = (text: string, at = AT, command?: string): InboundMessage => ({
  kind: 'message',
  updateId: uid++,
  chatId: GROUP,
  chatType: 'group',
  messageId: 1,
  fromUserId: 42,
  fromName: 'Itzik',
  text,
  command,
  receivedAt: at,
});
const cmd = (text: string) => msg(text, AT, text.slice(1).split(/\s/)[0]);
const tap = (data: string): InboundCallback => ({
  kind: 'callback',
  updateId: uid++,
  callbackId: `cb${uid}`,
  chatId: GROUP,
  messageId: 7,
  fromUserId: 42,
  fromName: 'Itzik',
  data,
  receivedAt: AT,
});
const text = (r: { type: string; text?: string } | undefined) => (r && 'text' in r ? r.text : undefined);

describe('intent from wording', () => {
  it.each([
    ['נגמר חלב', 'out', false],
    ['תקנו לחם', 'out', false],
    ['קניתי חלב וביצים', 'in', true],
    ['נכנס קוטג׳', 'in', true],
    ['הבאנו לחם', 'in', true],
    ['יש לנו ביצים?', 'query', true],
    ['יש לנו ביצים', 'query', true],
    ['האם נשאר חלב', 'query', true],
    ['נגמר החלב?', 'query', true],
  ])('"%s" → %s', (t, intent, explicit) => {
    expect(detectIntent(t)).toEqual({ intent, explicit });
  });
});

describe('stock-in by text (R3, manual)', () => {
  it('"קניתי חלב" records a purchase, takes it off the list, no LLM call', async () => {
    const s = setup();
    await s.d.handle(msg('נגמר חלב', new Date('2026-11-05T08:00:00Z')), {});
    const [r] = await s.d.handle(msg('קניתי חלב וביצים'), {});
    expect(text(r)).toBe('✓ נרשם שנקנה: חלב 3%, ביצים · ירד מהרשימה: חלב 3%');
    expect(s.list.entries.size).toBe(0);
    expect(s.purchases.rows.map((p) => [p.itemId, p.source, p.purchasedOn])).toEqual([
      ['milk', 'manual', '2026-11-06'],
      ['eggs', 'manual', '2026-11-06'],
    ]);
    expect(s.llm.requests).toHaveLength(0);
  });

  it('never puts a bought item ON the list (the bug this fixes)', async () => {
    const s = setup();
    await s.d.handle(msg('נכנס קוטג׳'), {});
    expect(s.list.entries.size).toBe(0);
  });

  it('an unknown bought item asks once; "new" creates it and records the purchase, not a depletion', async () => {
    const s = setup([
      { intent: 'in', items: [{ mention: 'קינואה', itemId: null, confidence: 'low', candidateItemIds: [], newItem: { name: 'קינואה', category: 'pantry' } }] },
    ]);
    await s.d.handle(msg('קניתי קינואה'), {});
    const done = await s.d.handle(tap('a:x1:n'), {});
    expect(text(done[1])).toBe('✓ נוסף פריט חדש: קינואה (מזווה) — נרשם שנקנה');
    expect(s.list.entries.size).toBe(0);
    expect(s.purchases.rows).toHaveLength(1);
  });

  it('when wording is unclear the LLM decides it was a purchase', async () => {
    const s = setup([
      { intent: 'in', items: [{ mention: 'חלב', itemId: 'milk', confidence: 'high', candidateItemIds: [], newItem: null }] },
    ]);
    const [r] = await s.d.handle(msg('יאללה סידרתי חלב'), {});
    expect(text(r)).toBe('✓ נרשם שנקנה: חלב 3%');
    expect(s.list.entries.size).toBe(0);
  });
});

describe('stock questions (R27, ground truth only)', () => {
  it('on the list → says so, without changing anything', async () => {
    const s = setup();
    await s.d.handle(msg('נגמרו הביצים', new Date('2026-11-04T08:00:00Z')), {});
    const [r] = await s.d.handle(msg('יש לנו ביצים?'), {});
    expect(text(r)).toBe('ביצים: נגמר (4/11) — ברשימה');
    expect(s.list.entries.size).toBe(1);
    expect(s.purchases.rows).toHaveLength(0);
  });

  it('bought after the last "out" → last bought date, not "we have it"', async () => {
    const s = setup();
    await s.d.handle(msg('נגמר חלב', new Date('2026-11-01T08:00:00Z')), {});
    await s.d.handle(msg('קניתי חלב', new Date('2026-11-03T08:00:00Z')), {});
    const [r] = await s.d.handle(msg('יש חלב?'), {});
    expect(text(r)).toBe('חלב 3%: נקנה ב-3/11, לא דווח שנגמר');
  });

  it('reported out with no purchase since, but off the list → reported date', async () => {
    const s = setup();
    await s.d.handle(msg('נגמר חלב', new Date('2026-11-01T08:00:00Z')), {});
    s.list.entries.clear();
    const [r] = await s.d.handle(msg('יש חלב?'), {});
    expect(text(r)).toBe('חלב 3%: דווח שנגמר ב-1/11');
  });

  it('no data → says it honestly; several items → one line', async () => {
    const s = setup();
    const [r] = await s.d.handle(msg('יש לנו קפה ותה?'), {});
    expect(text(r)).toBe('קפה: אין לי מידע עדיין · תה: אין לי מידע עדיין');
  });

  it('an unknown product in a question gets "don\'t know" — no buttons, nothing created', async () => {
    const s = setup([
      { intent: 'query', items: [{ mention: 'קינואה', itemId: null, confidence: 'low', candidateItemIds: [], newItem: { name: 'קינואה', category: 'pantry' } }] },
    ]);
    const replies = await s.d.handle(msg('יש לנו קינואה?'), {});
    expect(replies).toEqual([{ type: 'send', text: 'לא מכיר: קינואה' }]);
    expect(s.pending.asks.size).toBe(0);
  });
});

describe('/same — "these are the same product for us" (R21)', () => {
  it('a name that is not an item becomes an alias of the target, no confirm needed', async () => {
    const s = setup();
    const [r] = await s.d.handle(cmd('/same קוטג׳ 9% = קוטג׳'), {});
    expect(text(r)).toBe('✓ מעכשיו "קוטג׳ 9%" = קוטג׳');
    // …and from now on it resolves locally, no LLM:
    await s.make().handle(msg('נגמר קוטג׳ 9%'), {});
    expect([...s.list.entries.keys()]).toEqual(['cottage']);
    expect(s.llm.requests).toHaveLength(0);
  });

  it('two existing items: asks to confirm, then merges aliases, codes, purchases and the list row', async () => {
    const s = setup();
    s.items.items.set('i-cot9', {
      id: 'i-cot9', name: "קוטג' 9%", category: 'dairy', aliases: ['קוטג 9%'], codes: ['4127329'],
      flags: { staple: false, nonCyclic: false }, createdAt: '2026-10-31T00:00:00Z',
    });
    s.purchases.rows.push({ itemId: 'i-cot9', quantity: 1, unit: 'unit', source: 'receipt', purchasedOn: '2026-10-29', createdAt: 'x' });
    await s.d.handle(msg("נגמר קוטג' 9%", new Date('2026-11-05T08:00:00Z')), {});
    expect([...s.list.entries.keys()]).toEqual(['i-cot9']);

    const [ask] = await s.d.handle(cmd("/same קוטג' 9% = קוטג׳"), {});
    expect(text(ask)).toBe('🔀 לאחד את "קוטג\' 9%" לתוך "קוטג׳"? היסטוריית הקניות עוברת, "קוטג\' 9%" יימחק');
    expect(s.items.items.has('i-cot9')).toBe(true); // nothing happens before the tap

    const done = await s.d.handle(tap('m:x1:y'), {});
    expect(text(done[1])).toBe('✓ "קוטג\' 9%" אוחד לתוך "קוטג׳" (1 קניות עברו)');
    expect(s.items.items.has('i-cot9')).toBe(false);
    const cottage = s.items.items.get('cottage')!;
    expect(cottage.aliases).toContain('קוטג 9%');
    expect(cottage.codes).toEqual(['4127329']);
    expect(cottage.lastOutAt).toBe('2026-11-05T08:00:00.000Z');
    expect(s.purchases.rows.map((p) => p.itemId)).toEqual(['cottage']);
    expect([...s.list.entries.keys()]).toEqual(['cottage']);

    // Same words now land on the kept item, locally.
    await s.make().handle(msg("קניתי קוטג' 9%"), {});
    expect(s.list.entries.size).toBe(0);
    expect(s.llm.requests).toHaveLength(0);
  });

  it('cancel, double tap, usage and unknown target', async () => {
    const s = setup();
    s.items.items.set('i-cot9', {
      id: 'i-cot9', name: "קוטג' 9%", category: 'dairy', aliases: ['קוטג 9%'],
      flags: { staple: false, nonCyclic: false }, createdAt: 'x',
    });
    await s.d.handle(cmd("/same קוטג' 9% = קוטג׳"), {});
    expect(text((await s.d.handle(tap('m:x1:n'), {}))[1])).toBe('האיחוד בוטל');
    expect(s.items.items.has('i-cot9')).toBe(true);
    expect((await s.d.handle(tap('m:x1:y'), {}))[0]).toMatchObject({ type: 'ack', text: 'כבר טופל' });

    expect(text((await s.d.handle(cmd('/same'), {}))[0])).toBe('כתבו כך: /same קוטג׳ 9% = קוטג׳ (השם אחרי ה-= נשאר)');
    expect(text((await s.d.handle(cmd('/same קוטג׳ = גבינת שמנת'), {}))[0])).toBe('לא מכיר את "גבינת שמנת". השמות המדויקים: /list');
    expect(text((await s.d.handle(cmd('/same חלב = חלב 3%'), {}))[0])).toBe('"חלב" כבר = חלב 3%');
  });
});

describe('/same — "did you mean" when the target is not exact', () => {
  const waffles = {
    id: 'i-waf', name: 'וופלים ללא גלוטן', category: 'snacks' as const, aliases: ['וופלים ללא גלוטן'],
    flags: { staple: false, nonCyclic: false }, createdAt: 'x',
  };
  const wafer = {
    id: 'i-wfr', name: 'אפיפית שוקולד', category: 'snacks' as const, aliases: ['אפיפית שוקולד'],
    flags: { staple: false, nonCyclic: false }, createdAt: 'x',
  };

  it('"וופל" offers "וופלים ללא גלוטן"; one tap merges (the button says 🔀)', async () => {
    const s = setup();
    s.items.items.set(waffles.id, structuredClone(waffles));
    s.items.items.set(wafer.id, structuredClone(wafer));
    const [r] = await s.d.handle(cmd('/same אפיפית שוקולד = וופל'), {});
    expect(r).toMatchObject({
      type: 'send',
      text: 'לא מכיר בדיוק את "וופל" — התכוונתם ל:',
      buttons: [[{ text: '🔀 וופלים ללא גלוטן', data: 's:x1:0' }], [{ text: '✕ ביטול', data: 's:x1:x' }]],
    });
    const done = await s.d.handle(tap('s:x1:0'), {});
    expect(text(done[1])).toBe('✓ "אפיפית שוקולד" אוחד לתוך "וופלים ללא גלוטן"');
    expect(s.items.items.has('i-wfr')).toBe(false);
  });

  it('when the first name is not an item, the button only adds a name (=)', async () => {
    const s = setup();
    s.items.items.set(waffles.id, structuredClone(waffles));
    const [r] = await s.d.handle(cmd('/same אפיפית = וופלים'), {});
    expect(r).toMatchObject({ buttons: [[{ text: '= וופלים ללא גלוטן' }], [{ text: '✕ ביטול' }]] });
    const done = await s.d.handle(tap('s:x1:0'), {});
    expect(text(done[1])).toBe('✓ מעכשיו "אפיפית" = וופלים ללא גלוטן');
    expect(s.items.items.get('i-waf')!.aliases).toContain('אפיפית');
  });

  it('fused prefixes are ignored; cancel and double tap do nothing', async () => {
    const s = setup();
    s.items.items.set(waffles.id, structuredClone(waffles));
    const [r] = await s.d.handle(cmd('/same אפיפית = הוופל'), {});
    expect(r).toMatchObject({ buttons: [[{ text: '= וופלים ללא גלוטן' }], [{ text: '✕ ביטול' }]] });
    expect(text((await s.d.handle(tap('s:x1:x'), {}))[1])).toBe('האיחוד בוטל');
    expect((await s.d.handle(tap('s:x1:0'), {}))[0]).toMatchObject({ text: 'כבר טופל' });
    expect(s.items.items.get('i-waf')!.aliases).not.toContain('אפיפית');
  });
});
