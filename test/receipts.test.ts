import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher/dispatcher.js';
import { ReceiptFlow } from '../src/dispatcher/receipt-flow.js';
import type { Attachment, InboundCallback, InboundMessage, Reply } from '../src/domain/message.js';
import { ReceiptExtractor } from '../src/receipts/extractor.js';
import { ReceiptLineResolver } from '../src/receipts/line-resolver.js';
import { ReceiptService } from '../src/receipts/receipt-service.js';
import { ItemRegistry } from '../src/registry/item-registry.js';
import { Resolver } from '../src/registry/resolver.js';
import { ShoppingList } from '../src/shopping/shopping-list.js';
import {
  exampleItems,
  FakeFiles,
  FakeLlm,
  MemItemStore,
  MemListStore,
  MemMessageLog,
  MemPendingStore,
  MemPurchaseStore,
  MemReceiptFiles,
  MemReceiptStore,
} from './fakes.js';

/**
 * Synthetic receipt modeled on a real Shufersal Online delivery note (structure only —
 * the real one carries personal data and never enters the repo). The extraction model
 * is faked; these tests cover everything after it.
 */
const EXTRACTION = {
  isReceipt: true,
  store: 'שופרסל ONLINE',
  purchasedOn: '2026-10-29',
  lines: [
    { code: '4131074', description: "חלב בקרטון 3% שומן 1 ל'", quantity: 2, unit: 'unit' },
    { code: '1201589', description: '12 ביצי משק טריות L', quantity: 2, unit: 'unit' },
    { code: '111186', description: 'מיונז אמיתי תלמה 500 גרם', quantity: 1, unit: 'unit' },
    { code: '43814', description: 'שמנת להקצפה 38% 250 מ"ל', quantity: 2, unit: 'unit' },
    { code: '4127329', description: "קוטג' 5% 250 גרם בעלז", quantity: 1, unit: 'unit' },
    { code: '9137576', description: 'מארז אשכולות שרי אורגני', quantity: 0.8, unit: 'kg' },
    // The model is told to drop these; validation drops them again if it doesn't.
    { code: null, description: 'מבצע: 2 ב-15', quantity: -1, unit: 'unit' },
    { code: '7296073006176', description: 'סוכר לבן 1 ק"ג', quantity: 0, unit: 'unit' },
  ],
};

const LINE_MATCHES = {
  matches: [
    { lineIndex: 0, itemId: 'milk', confidence: 'high', newItem: null },
    { lineIndex: 1, itemId: 'eggs', confidence: 'high', newItem: null },
    { lineIndex: 2, itemId: null, confidence: 'low', newItem: { name: 'מיונז', category: 'pantry' } },
    { lineIndex: 3, itemId: null, confidence: 'low', newItem: { name: 'שמנת להקצפה 38%', category: 'dairy' } },
    { lineIndex: 4, itemId: 'cottage', confidence: 'low', newItem: { name: "קוטג' 5%", category: 'dairy' } },
    { lineIndex: 5, itemId: null, confidence: 'low', newItem: { name: 'עגבניות שרי', category: 'produce' } },
  ],
};

const PRIVATE = 256;
const GROUP = -555;
const AT = new Date('2026-10-31T12:00:00Z');

function setup() {
  const items = new MemItemStore(exampleItems());
  const list = new MemListStore();
  const pending = new MemPendingStore();
  const purchases = new MemPurchaseStore();
  const receiptStore = new MemReceiptStore();
  const storage = new MemReceiptFiles();
  const files = new FakeFiles();
  const llm = new FakeLlm();
  const registry = new ItemRegistry(items);
  const shopping = new ShoppingList(items, list);
  let n = 0;
  const newId = () => `p${++n}`;
  const receipts = new ReceiptService({
    files,
    storage,
    receipts: receiptStore,
    extractor: new ReceiptExtractor(llm),
    lineResolver: new ReceiptLineResolver(registry, llm),
    registry,
    purchases,
    shopping,
  });
  const d = new Dispatcher({
    gate: { isAllowed: async (id) => id === PRIVATE || id === GROUP },
    registry,
    resolver: new Resolver(registry, llm),
    shopping,
    pending,
    log: new MemMessageLog(),
    receipts: new ReceiptFlow(receipts, pending, newId),
    newId,
    logError: () => {},
  });
  return { d, items, list, pending, purchases, receiptStore, storage, files, llm };
}

let updateId = 1000;
const attachment = (fileUniqueId = 'file-A'): Attachment => ({
  kind: 'pdf',
  fileId: `id-${fileUniqueId}`,
  fileUniqueId,
  mimeType: 'application/pdf',
  sizeBytes: 600_000,
});
const fileMsg = (chatId = PRIVATE, a = attachment()): InboundMessage => ({
  kind: 'message',
  updateId: updateId++,
  chatId,
  chatType: chatId === PRIVATE ? 'private' : 'group',
  messageId: 1,
  fromUserId: 42,
  fromName: 'Itzik',
  text: '',
  command: undefined,
  attachment: a,
  receivedAt: AT,
});
const textMsg = (text: string): InboundMessage => ({ ...fileMsg(GROUP), attachment: undefined, text } as InboundMessage);
const tap = (data: string, messageId = 9): InboundCallback => ({
  kind: 'callback',
  updateId: updateId++,
  callbackId: `cb${updateId}`,
  chatId: PRIVATE,
  messageId,
  fromUserId: 42,
  fromName: 'Itzik',
  data,
  receivedAt: AT,
});

async function sendReceipt(s: ReturnType<typeof setup>, msg = fileMsg()) {
  const emitted: Reply[] = [];
  const replies = await s.d.handle(msg, {}, async (r) => void emitted.push(r));
  return { emitted, replies };
}

describe('receipt ingestion (R1, R2) — private chat', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    await s.d.handle(textMsg('נגמר חלב וביצים'), {}); // milk and eggs are on the list before shopping
    s.llm.queue(EXTRACTION);
    s.llm.queue(LINE_MATCHES);
  });

  it('acknowledges immediately, stores the original, and sends the file to the model', async () => {
    const { emitted } = await sendReceipt(s);
    expect(emitted).toEqual([{ type: 'send', text: '⏳ קורא את הקבלה…' }]);
    expect(s.files.downloads).toEqual(['id-file-A']);
    expect(s.storage.files.size).toBe(1);
    const req = s.llm.requests[0]!;
    expect(req.task).toBe('extract-receipt');
    expect(req.attachments?.[0]?.mediaType).toBe('application/pdf');
    expect(Buffer.from(req.attachments![0]!.base64, 'base64').toString()).toBe('%PDF-1.7 fake id-file-A');
  });

  it('records known items as purchases (supplied qty, kg for weighed) and clears them from the list', async () => {
    await sendReceipt(s);
    expect(s.purchases.rows.map((p) => [p.itemId, p.quantity, p.unit, p.purchasedOn, p.source])).toEqual([
      ['milk', 2, 'unit', '2026-10-29', 'receipt'],
      ['eggs', 2, 'unit', '2026-10-29', 'receipt'],
    ]);
    expect(s.list.entries.size).toBe(0); // R3 via receipt: bought items leave the list
  });

  it('never records promo lines or out-of-stock (supplied 0) lines', async () => {
    await sendReceipt(s);
    const lines = s.receiptStore.records.get('file-A')!.lines!;
    expect(lines.map((l) => l.description)).not.toContain('מבצע: 2 ב-15');
    expect(lines.map((l) => l.description)).not.toContain('סוכר לבן 1 ק"ג');
    expect(lines).toHaveLength(6);
  });

  it('learns item codes from confident matches so the next receipt resolves locally (R22)', async () => {
    await sendReceipt(s);
    expect(s.items.items.get('milk')!.codes).toEqual(['4131074']);
    expect(s.items.items.get('eggs')!.codes).toEqual(['1201589']);
  });

  it('one summary for new items with "add all"; one question per ambiguous line', async () => {
    const { replies } = await sendReceipt(s);
    expect(replies).toHaveLength(2);
    const [summary, question] = replies;
    expect(summary).toMatchObject({ type: 'send' });
    if (summary?.type !== 'send' || question?.type !== 'send') return;
    expect(summary.text).toBe(
      [
        '🧾 שופרסל ONLINE · 29/10 — 6 מוצרים',
        '✓ נרשמו כנקנו (2): חלב 3% ×2, ביצים ×2',
        '🛒 ירדו מהרשימה: חלב 3%, ביצים',
        '➕ 3 מוצרים חדשים:',
        '• מיונז (מזווה)',
        '• שמנת להקצפה 38% ×2 (מוצרי חלב וביצים)',
        '• עגבניות שרי 0.8 ק"ג (פירות וירקות)',
        '❓ 1 לא בטוח — שאלה על כל אחד בהמשך',
      ].join('\n'),
    );
    expect(summary.buttons).toEqual([[{ text: '✓ הוסף את כל ה-3', data: 'r:p1:y' }, { text: '✕ דלג', data: 'r:p1:n' }]]);
    expect(question.text).toBe('❓ "קוטג\' 5% 250 גרם בעלז" — זה קוטג׳?');
    expect(question.buttons!.flat().map((b) => b.data)).toEqual(['l:p2:y', 'l:p2:n', 'l:p2:x']);
    expect(question.buttons!.flat().every((b) => Buffer.byteLength(b.data) <= 64)).toBe(true);
  });

  it('"add all" creates the items with their codes and records the purchases', async () => {
    await sendReceipt(s);
    const replies = await s.d.handle(tap('r:p1:y'), {});
    expect(replies[0]).toMatchObject({ type: 'ack' });
    expect(replies[1]).toMatchObject({ type: 'edit', messageId: 9 });
    expect(replies[1]!.type === 'edit' && replies[1]!.text.endsWith('✓ נוספו 3 מוצרים חדשים ונרשמו כנקנו')).toBe(true);

    const created = [...s.items.items.values()].filter((i) => i.id.startsWith('i-'));
    expect(created.map((i) => [i.name, i.category, i.codes])).toEqual([
      ['מיונז', 'pantry', ['111186']],
      ['שמנת להקצפה 38%', 'dairy', ['43814']],
      ['עגבניות שרי', 'produce', ['9137576']],
    ]);
    expect(s.purchases.rows).toHaveLength(5);
    expect(s.purchases.rows.at(-1)).toMatchObject({ quantity: 0.8, unit: 'kg' });
  });

  it('"skip" records nothing for the new lines', async () => {
    await sendReceipt(s);
    const replies = await s.d.handle(tap('r:p1:n'), {});
    expect(replies[1]!.type === 'edit' && replies[1]!.text.endsWith('✕ המוצרים החדשים לא נשמרו')).toBe(true);
    expect([...s.items.items.values()].some((i) => i.id.startsWith('i-'))).toBe(false);
    expect(s.purchases.rows).toHaveLength(2);
  });

  it('answering an ambiguous line: "yes" learns the code; "new" creates the variant', async () => {
    await sendReceipt(s);
    const yes = await s.d.handle(tap('l:p2:y'), {});
    expect(yes[1]).toEqual({ type: 'edit', messageId: 9, text: '✓ "קוטג\' 5% 250 גרם בעלז" → קוטג׳' });
    expect(s.items.items.get('cottage')!.codes).toEqual(['4127329']);
    expect(s.purchases.rows.at(-1)).toMatchObject({ itemId: 'cottage' });

    const s2 = setup();
    s2.llm.queue(EXTRACTION);
    s2.llm.queue(LINE_MATCHES);
    await sendReceipt(s2);
    await s2.d.handle(tap('l:p2:n'), {});
    const variant = [...s2.items.items.values()].find((i) => i.name === "קוטג' 5%");
    expect(variant?.codes).toEqual(['4127329']);
    expect(s2.items.items.get('cottage')!.codes).toBeUndefined();
  });

  it('a double tap does nothing the second time', async () => {
    await sendReceipt(s);
    await s.d.handle(tap('r:p1:y'), {});
    const again = await s.d.handle(tap('r:p1:y'), {});
    expect(again).toEqual([{ type: 'ack', callbackId: expect.any(String), text: 'כבר טופל' }]);
    expect(s.purchases.rows).toHaveLength(5);
  });

  it('the next receipt with the same products resolves by code — no matching call', async () => {
    await sendReceipt(s);
    await s.d.handle(tap('r:p1:y'), {});
    await s.d.handle(tap('l:p2:y'), {});
    expect(s.llm.requests).toHaveLength(2);

    s.llm.queue(EXTRACTION);
    const { replies } = await sendReceipt(s, fileMsg(PRIVATE, attachment('file-B')));
    expect(s.llm.requests).toHaveLength(3); // extraction only
    expect(s.llm.requests[2]!.task).toBe('extract-receipt');
    expect(replies).toEqual([
      {
        type: 'send',
        text: '🧾 שופרסל ONLINE · 29/10 — 6 מוצרים\n✓ נרשמו כנקנו (6): חלב 3% ×2, ביצים ×2, מיונז, שמנת להקצפה 38% ×2, קוטג׳, עגבניות שרי 0.8 ק"ג',
      },
    ]);
  });

  it('the same file sent twice is recorded once', async () => {
    await sendReceipt(s);
    const { replies } = await sendReceipt(s);
    expect(replies).toEqual([{ type: 'send', text: 'הקבלה הזו כבר נקלטה ✓' }]);
    expect(s.files.downloads).toHaveLength(1);
    expect(s.purchases.rows).toHaveLength(2);
  });
});

describe('receipt edge cases', () => {
  it('a file that is not a receipt says so and can be re-sent', async () => {
    const s = setup();
    s.llm.queue({ isReceipt: false, store: null, purchasedOn: null, lines: [] });
    const { replies } = await sendReceipt(s);
    expect(replies).toEqual([{ type: 'send', text: 'זה לא נראה כמו קבלה 🤔' }]);
    expect(s.receiptStore.records.size).toBe(0);
    expect(s.purchases.rows).toHaveLength(0);
  });

  it('a failure replies in one line and releases the claim so a retry works', async () => {
    const s = setup(); // no LLM answers queued → extraction throws
    const { replies } = await sendReceipt(s);
    expect(replies).toEqual([{ type: 'send', text: 'לא הצלחתי לעבד את זה כרגע — נסו שוב בעוד רגע' }]);
    expect(s.receiptStore.records.size).toBe(0);
  });

  it('files and photos in the group are ignored — no download, no model call', async () => {
    const s = setup();
    const { replies, emitted } = await sendReceipt(s, fileMsg(GROUP));
    expect(replies).toEqual([]);
    expect(emitted).toEqual([]);
    expect(s.files.downloads).toHaveLength(0);
    expect(s.llm.requests).toHaveLength(0);
  });

  it('extraction validation drops bad lines and bad dates', async () => {
    const llm = new FakeLlm([
      {
        isReceipt: true,
        store: '  ',
        purchasedOn: '29/10/26',
        lines: [
          { code: ' 123 ', description: ' לחם ', quantity: 1, unit: 'unit' },
          { code: null, description: '', quantity: 1, unit: 'unit' },
          { code: null, description: 'x', quantity: Number.NaN, unit: 'unit' },
          { code: null, description: 'עגבניות', quantity: 1.25, unit: 'kg' },
        ],
      },
    ]);
    const r = await new ReceiptExtractor(llm).extract({ mediaType: 'image/jpeg', base64: '' });
    expect(r).toMatchObject({
      store: null,
      purchasedOn: null,
      lines: [
        { index: 0, code: '123', description: 'לחם', quantity: 1, unit: 'unit' },
        { index: 1, code: null, description: 'עגבניות', quantity: 1.25, unit: 'kg' },
      ],
    });
  });
});

describe('receipt layouts seen in the wild (synthetic, structure only)', () => {
  it('drugstore receipt with one line per unit → one product, summed quantity, one new item', async () => {
    // Super-Pharm style: the same barcode printed once per unit bought.
    const s = setup();
    s.llm.queue({
      isReceipt: true,
      store: 'סופר-פארם',
      purchasedOn: '2026-10-23',
      lines: [
        { code: '7290000000011', description: 'קרם גוף מועשר', quantity: 1, unit: 'unit' },
        { code: '7290000000011', description: 'קרם גוף מועשר', quantity: 1, unit: 'unit' },
        { code: '7290000000011', description: 'קרם גוף מועשר', quantity: 1, unit: 'unit' },
        { code: '7290000000028', description: 'משחת שיניים מקס פרש', quantity: 1, unit: 'unit' },
      ],
    });
    s.llm.queue({
      matches: [
        { lineIndex: 0, itemId: null, confidence: 'low', newItem: { name: 'קרם גוף', category: 'hygiene' } },
        { lineIndex: 1, itemId: 'toothpaste', confidence: 'high', newItem: null },
      ],
    });
    const { replies } = await sendReceipt(s);
    expect(replies[0]!.type === 'send' && replies[0]!.text).toContain('— 2 מוצרים');
    expect(replies[0]!.type === 'send' && replies[0]!.text).toContain('✓ נרשמו כנקנו (1): משחת שיניים');
    expect(replies[0]!.type === 'send' && replies[0]!.text).toContain('• קרם גוף ×3 (היגיינה וטיפוח)');
    expect(JSON.parse(s.llm.requests[1]!.user)).toHaveLength(2); // the matcher sees each product once

    await s.d.handle(tap('r:p1:y'), {});
    const creams = [...s.items.items.values()].filter((i) => i.name === 'קרם גוף');
    expect(creams).toHaveLength(1);
    expect(s.purchases.rows.find((p) => p.itemId === creams[0]!.id)).toMatchObject({ quantity: 3 });
  });

  it('merging keys on code, falls back to description, and never mixes kg with units', async () => {
    const llm = new FakeLlm([
      {
        isReceipt: true,
        store: 'אושר עד',
        purchasedOn: '2026-04-09',
        lines: [
          { code: '8008343880138', description: 'פסטה לינגוויני ללא גלוטן', quantity: 2, unit: 'unit' },
          { code: '8008343880138', description: 'פסטה לינגוויני ללא גל', quantity: 2, unit: 'unit' },
          { code: null, description: 'עגבניות', quantity: 1.2, unit: 'kg' },
          { code: null, description: 'עגבניות', quantity: 0.35, unit: 'kg' },
          { code: null, description: 'עגבניות', quantity: 1, unit: 'unit' },
          { code: '9000313', description: 'גזר', quantity: 2, unit: 'kg' },
        ],
      },
    ]);
    const r = await new ReceiptExtractor(llm).extract({ mediaType: 'application/pdf', base64: '' });
    expect(r.lines.map((l) => [l.index, l.code, l.quantity, l.unit])).toEqual([
      [0, '8008343880138', 4, 'unit'],
      [1, null, 1.55, 'kg'],
      [2, null, 1, 'unit'],
      [3, '9000313', 2, 'kg'],
    ]);
  });

  it('the extraction prompt covers wrapped descriptions, price-less promo lines and card payments', () => {
    const llm = new FakeLlm([{ isReceipt: false, store: null, purchasedOn: null, lines: [] }]);
    return new ReceiptExtractor(llm).extract({ mediaType: 'application/pdf', base64: '' }).then(() => {
      const system = llm.requests[0]!.system;
      expect(system).toContain('continue at the top of the next page');
      expect(system).toContain('פסטה רומו 2 ב 20');
      expect(system).toContain('כאל');
      expect(system).toContain('Super-Pharm');
    });
  });
});

describe('file type is decided by content, not by name or label', () => {
  it('sniffs PDF, JPEG, PNG and WebP; rejects anything else', async () => {
    const { sniffMime } = await import('../src/receipts/receipt-service.js');
    const b = (...xs: number[]) => new Uint8Array(xs);
    const s = (t: string) => new TextEncoder().encode(t);
    expect(sniffMime(s('%PDF-1.7\n…'))).toBe('application/pdf');
    expect(sniffMime(s('\n\n  %PDF-1.4'))).toBe('application/pdf');
    expect(sniffMime(b(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMime(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffMime(s('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(s('PK\u0003\u0004zip'))).toBeUndefined();
    expect(sniffMime(s('<html>'))).toBeUndefined();
  });

  it('a PDF sent without its .pdf extension is read as a PDF', async () => {
    const s = setup();
    s.llm.queue(EXTRACTION);
    s.llm.queue(LINE_MATCHES);
    const a: Attachment = { kind: 'file', fileId: 'id-x', fileUniqueId: 'x', mimeType: 'application/octet-stream', fileName: 'SuperPharm1', sizeBytes: 172_000 };
    const { replies } = await sendReceipt(s, fileMsg(PRIVATE, a));
    expect(s.llm.requests[0]!.attachments?.[0]?.mediaType).toBe('application/pdf');
    expect(replies[0]!.type === 'send' && replies[0]!.text.startsWith('🧾')).toBe(true);
  });

  it('an unreadable file gets a one-line explanation, not silence — and can be re-sent', async () => {
    const s = setup();
    s.files.download = async () => new TextEncoder().encode('PK\u0003\u0004 a zip');
    const a: Attachment = { kind: 'file', fileId: 'id-z', fileUniqueId: 'z', mimeType: 'application/zip', sizeBytes: 1000 };
    const { replies } = await sendReceipt(s, fileMsg(PRIVATE, a));
    expect(replies).toEqual([{ type: 'send', text: 'אפשר לשלוח קבלה כקובץ PDF או כתמונה (עד 10MB)' }]);
    expect(s.llm.requests).toHaveLength(0);
    expect(s.receiptStore.records.size).toBe(0);
  });

  it('a file declared over 10 MB is refused before downloading', async () => {
    const s = setup();
    const a: Attachment = { ...attachment('big'), sizeBytes: 11 * 1024 * 1024 };
    const { replies } = await sendReceipt(s, fileMsg(PRIVATE, a));
    expect(replies).toEqual([{ type: 'send', text: 'אפשר לשלוח קבלה כקובץ PDF או כתמונה (עד 10MB)' }]);
    expect(s.files.downloads).toHaveLength(0);
  });
});
