import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher/dispatcher.js';
import type { ChatGate } from '../src/dispatcher/chat-gate.js';
import type { InboundCallback, InboundMessage, Reply } from '../src/domain/message.js';
import { ItemRegistry } from '../src/registry/item-registry.js';
import { Resolver } from '../src/registry/resolver.js';
import { ShoppingList } from '../src/shopping/shopping-list.js';
import { StockService } from '../src/inventory/stock.js';
import { exampleItems, FakeLlm, MemItemStore, MemListStore, MemMessageLog, MemPendingStore, MemPurchaseStore } from './fakes.js';

const GROUP = -100123;
const STRANGER = 999;
const AT = new Date('2026-11-01T10:00:00Z');

function setup(llmAnswers: unknown[] = []) {
  const items = new MemItemStore(exampleItems());
  const list = new MemListStore();
  const log = new MemMessageLog();
  const pending = new MemPendingStore();
  const purchases = new MemPurchaseStore();
  const llm = new FakeLlm(llmAnswers);
  // Each container gets a fresh registry; `freshRegistry` simulates a cold start.
  const makeDispatcher = () => {
    const registry = new ItemRegistry(items);
    const gate: ChatGate = { isAllowed: async (id) => id === GROUP };
    let n = 0;
    const shopping = new ShoppingList(items, list);
    return new Dispatcher({
      gate,
      registry,
      resolver: new Resolver(registry, llm),
      shopping,
      pending,
      log,
      stock: new StockService(shopping, list, purchases, registry),
      newId: () => `ask${++n}`,
      logError: () => {},
    });
  };
  return { items, list, log, pending, purchases, llm, d: makeDispatcher(), makeDispatcher };
}

let updateId = 1;
const msg = (text: string, chatId = GROUP, command?: string): InboundMessage => ({
  kind: 'message',
  updateId: updateId++,
  chatId,
  chatType: 'supergroup',
  messageId: 10,
  fromUserId: 42,
  fromName: 'Itzik',
  text,
  command,
  receivedAt: AT,
});
const tap = (data: string, messageId = 77): InboundCallback => ({
  kind: 'callback',
  updateId: updateId++,
  callbackId: `cb${updateId}`,
  chatId: GROUP,
  messageId,
  fromUserId: 43,
  fromName: 'Dana',
  data,
  receivedAt: AT,
});
const sends = (rs: Reply[]) => rs.filter((r) => r.type === 'send');

describe('depletion report (R4, R25)', () => {
  it('"נגמר חלב" adds milk to the list and replies in one line', async () => {
    const { d, list, items, llm } = setup();
    const replies = await d.handle(msg('נגמר חלב'), {});
    expect(replies).toEqual([{ type: 'send', text: '✓ חלב 3% — ברשימה' }]);
    expect(replies[0]!.type === 'send' && replies[0]!.text).not.toContain('\n');
    expect(list.entries.get('milk')).toMatchObject({ itemId: 'milk', reason: 'out', createdByUserId: 42 });
    expect(items.items.get('milk')!.lastOutAt).toBe(AT.toISOString()); // marked out, cycle reset (R4, R5)
    expect(llm.requests).toHaveLength(0);
  });

  it('"נגמר לנו החלב" resolves to the same item', async () => {
    const { d, list } = setup();
    await d.handle(msg('נגמר לנו החלב'), {});
    expect([...list.entries.keys()]).toEqual(['milk']);
  });

  it('re-reporting does not duplicate the list entry', async () => {
    const { d, list } = setup();
    await d.handle(msg('נגמר חלב'), {});
    const replies = await d.handle(msg('אין חלב'), {});
    expect(replies).toEqual([{ type: 'send', text: 'חלב 3% כבר ברשימה' }]);
    expect(list.entries.size).toBe(1);
  });

  it('several items in one message → one line', async () => {
    const { d, list } = setup();
    await d.handle(msg('נגמר חלב'), {});
    const replies = await d.handle(msg('נגמר חלב וביצים'), {});
    expect(replies).toEqual([{ type: 'send', text: '✓ ביצים — ברשימה (חלב 3% כבר שם)' }]);
    expect(list.entries.size).toBe(2);
  });

  it('chatter the LLM says is not a report gets no reply', async () => {
    const { d, list } = setup([{ isReport: false, items: [] }]);
    expect(await d.handle(msg('תודה רבה'), {})).toEqual([]);
    expect(list.entries.size).toBe(0);
  });

  it('a confident LLM match learns the alias, so next time it is local', async () => {
    const { d, llm, items, makeDispatcher } = setup([
      { isReport: true, items: [{ mention: 'חלב עמיד', itemId: 'milk', confidence: 'high', candidateItemIds: [], newItem: null }] },
    ]);
    await d.handle(msg('נגמר חלב עמיד'), {});
    expect(items.items.get('milk')!.aliases).toContain('חלב עמיד');
    await makeDispatcher().handle(msg('נגמר חלב עמיד'), {});
    expect(llm.requests).toHaveLength(1);
  });
});

describe('unknown item flow (R21)', () => {
  const unknownQuinoa = {
    isReport: true,
    items: [{ mention: 'קינואה', itemId: null, confidence: 'low', candidateItemIds: [], newItem: { name: 'קינואה', category: 'pantry' } }],
  };

  it('asks with one-tap buttons; confirming creates the item, lists it, and next time it resolves locally', async () => {
    const { d, llm, list, pending, makeDispatcher } = setup([unknownQuinoa]);

    const ask = await d.handle(msg('נגמרה הקינואה'), {});
    expect(ask).toHaveLength(1);
    const q = ask[0]!;
    expect(q.type).toBe('send');
    if (q.type !== 'send') return;
    expect(q.text).toBe('לא בטוח מה זה "קינואה":');
    const flat = q.buttons!.flat();
    expect(flat.map((b) => b.data)).toEqual(['a:ask1:n', 'a:ask1:x']);
    expect(flat.every((b) => Buffer.byteLength(b.data) <= 64)).toBe(true);
    expect(pending.asks.has('ask1')).toBe(true);
    expect(list.entries.size).toBe(0);

    const done = await d.handle(tap('a:ask1:n'), {});
    expect(done[0]).toMatchObject({ type: 'ack' });
    expect(done[1]).toEqual({ type: 'edit', messageId: 77, text: '✓ נוסף פריט חדש: קינואה (מזווה) — ברשימה' });
    expect(list.entries.size).toBe(1);

    // Same phrasing, fresh container: resolves locally with no LLM call.
    const again = await makeDispatcher().handle(msg('נגמרה הקינואה'), {});
    expect(again).toEqual([{ type: 'send', text: 'קינואה כבר ברשימה' }]);
    expect(llm.requests).toHaveLength(1);
  });

  it('an ambiguous item offers candidates; picking one writes the alias back', async () => {
    const { d, items, list } = setup([
      {
        isReport: true,
        items: [{ mention: 'הסבון', itemId: null, confidence: 'low', candidateItemIds: ['dish-soap', 'hand-soap'], newItem: { name: 'סבון', category: 'cleaning' } }],
      },
    ]);
    const [q] = await d.handle(msg('נגמר הסבון'), {});
    expect(q!.type === 'send' && q!.buttons!.flat().map((b) => b.text)).toEqual([
      'סבון כלים',
      'סבון ידיים',
      '➕ חדש: סבון (ניקיון)',
      '✕ לא משנה',
    ]);

    const done = await d.handle(tap('a:ask1:1'), {});
    expect(done[1]).toEqual({ type: 'edit', messageId: 77, text: '✓ סבון ידיים — ברשימה' });
    expect(items.items.get('hand-soap')!.aliases).toContain('הסבון');
    expect([...list.entries.keys()]).toEqual(['hand-soap']);
  });

  it('a double tap or stale button does nothing the second time', async () => {
    const { d, list } = setup([unknownQuinoa]);
    await d.handle(msg('נגמרה הקינואה'), {});
    await d.handle(tap('a:ask1:n'), {});
    const second = await d.handle(tap('a:ask1:n'), {});
    expect(second).toEqual([{ type: 'ack', callbackId: expect.any(String), text: 'כבר טופל' }]);
    expect(list.entries.size).toBe(1);
  });

  it('cancel removes the question without adding anything', async () => {
    const { d, list, items } = setup([unknownQuinoa]);
    await d.handle(msg('נגמרה הקינואה'), {});
    const done = await d.handle(tap('a:ask1:x'), {});
    expect(done[1]).toEqual({ type: 'edit', messageId: 77, text: '"קינואה" — בוטל' });
    expect(list.entries.size).toBe(0);
    expect([...items.items.values()].some((i) => i.name === 'קינואה')).toBe(false);
  });
});

describe('/list (R12)', () => {
  it('groups by category in shop order with a reason per line', async () => {
    const { d } = setup();
    await d.handle(msg('נגמר סבון כלים'), {});
    await d.handle(msg('נגמר חלב ועגבניות'), {});
    const [r] = await d.handle(msg('/list', GROUP, 'list'), {});
    expect(r).toEqual({
      type: 'send',
      text: '🛒 רשימת קניות\n\nפירות וירקות:\n• עגבניות — נגמר\n\nמוצרי חלב וביצים:\n• חלב 3% — נגמר\n\nניקיון:\n• סבון כלים — נגמר',
    });
  });

  it('says so when the list is empty', async () => {
    const { d } = setup();
    expect(await d.handle(msg('/list', GROUP, 'list'), {})).toEqual([{ type: 'send', text: 'הרשימה ריקה 🎉' }]);
  });
});

describe('raw message storage (R23)', () => {
  it('stores every inbound raw, with what we made of it', async () => {
    const { d, log } = setup();
    const m = msg('נגמר לנו החלב');
    const raw = { update_id: m.updateId, message: { text: 'נגמר לנו החלב' } };
    await d.handle(m, raw);
    expect(log.records.get(m.updateId)).toMatchObject({
      text: 'נגמר לנו החלב',
      raw,
      fromUserId: 42,
      parsed: { intent: 'out', resolution: { kind: 'items', intent: 'out', path: 'local', resolved: [{ itemId: 'milk', mention: 'החלב' }] } },
    });
  });

  it('keeps the raw text even when processing fails', async () => {
    const { d, log } = setup(); // FakeLlm has no answers → throws
    const m = msg('נגמרה הקינואה');
    const replies = await d.handle(m, { x: 1 });
    expect(replies).toEqual([{ type: 'send', text: 'לא הצלחתי לעבד את זה כרגע — נסו שוב בעוד רגע' }]);
    expect(log.records.get(m.updateId)).toMatchObject({ text: 'נגמרה הקינואה', parsed: { intent: 'error' } });
  });

  it('stores messages from chats that are not allowed, but does not answer them', async () => {
    const { d, log, llm } = setup();
    const m = msg('נגמר חלב', STRANGER);
    expect(await d.handle(m, {})).toEqual([]);
    expect(log.records.get(m.updateId)?.parsed).toEqual({ intent: 'chat-not-allowed' });
    expect(llm.requests).toHaveLength(0);
  });
});

describe('commands', () => {
  it('/chatid answers in any chat so the household can find its id', async () => {
    const { d } = setup();
    expect(await d.handle(msg('/chatid', STRANGER, 'chatid'), {})).toEqual([
      { type: 'send', text: 'chat id: 999 · user id: 42' },
    ]);
  });

  it('/start and /help explain usage in one line', async () => {
    const { d } = setup();
    const [r] = await d.handle(msg('/start', GROUP, 'start'), {});
    expect(r!.type === 'send' && r!.text.includes('\n')).toBe(false);
  });

  it('ignores unknown commands', async () => {
    const { d } = setup();
    expect(sends(await d.handle(msg('/foo', GROUP, 'foo'), {}))).toEqual([]);
  });
});
