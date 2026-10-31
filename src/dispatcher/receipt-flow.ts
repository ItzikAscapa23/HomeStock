import { CATEGORIES, isCategoryId } from '../domain/categories.js';
import type { Button, InboundCallback, InboundMessage, Reply } from '../domain/message.js';
import type { PendingReceiptBatch, PendingReceiptLine, PendingStore } from '../persistence/stores.js';
import type { IngestResult, ReceiptService } from '../receipts/receipt-service.js';

/** User-facing copy for the receipt flow. The summary is multi-line: it answers an explicit action in a private chat. */
const COPY = {
  reading: '⏳ קורא את הקבלה…',
  duplicate: 'הקבלה הזו כבר נקלטה ✓',
  notReceipt: 'זה לא נראה כמו קבלה 🤔',
  header: (store: string | null, day: string, n: number) => `🧾 ${store ? `${store} · ` : ''}${day} — ${n} מוצרים`,
  matched: (n: number) => `✓ ${n} נרשמו כנקנו`,
  cleared: (names: string) => ` · ירדו מהרשימה: ${names}`,
  newHeader: (n: number) => `➕ ${n} מוצרים חדשים:`,
  newLine: (name: string, category: string) => `• ${name} (${isCategoryId(category) ? CATEGORIES[category] : category})`,
  ambiguous: (n: number) => `❓ ${n} לא בטוח — שאלה על כל אחד בהמשך`,
  addAll: (n: number) => `✓ הוסף את כל ה-${n}`,
  skipAll: '✕ דלג',
  addedAll: (n: number) => `✓ נוספו ${n} מוצרים חדשים ונרשמו כנקנו`,
  skippedAll: '✕ המוצרים החדשים לא נשמרו',
  askLine: (desc: string, candidate: string) => `❓ "${desc}" — זה ${candidate}?`,
  yes: '✓ כן',
  newItem: (name: string) => `➕ חדש: ${name}`,
  skip: '✕ דלג',
  lineMatched: (desc: string, name: string, cleared: boolean) => `✓ "${desc}" → ${name}${cleared ? ' · ירד מהרשימה' : ''}`,
  lineSkipped: (desc: string) => `✕ "${desc}" — דילגתי`,
  stale: 'כבר טופל',
} as const;

const MAX_MESSAGE = 4000; // Telegram's limit is 4096

export class ReceiptFlow {
  constructor(
    private readonly receipts: ReceiptService,
    private readonly pending: PendingStore,
    private readonly newId: () => string,
  ) {}

  async onReceipt(
    msg: InboundMessage,
    emit: (r: Reply) => Promise<void>,
  ): Promise<[Record<string, unknown>, Reply[]]> {
    await emit({ type: 'send', text: COPY.reading }); // extraction takes tens of seconds
    const result = await this.receipts.ingest({
      attachment: msg.attachment!,
      chatId: msg.chatId,
      ...(msg.fromUserId !== undefined && { userId: msg.fromUserId }),
      receivedAt: msg.receivedAt,
    });

    if (result.status === 'duplicate') return [{ intent: 'receipt', status: 'duplicate' }, [{ type: 'send', text: COPY.duplicate }]];
    if (result.status === 'not-a-receipt') return [{ intent: 'receipt', status: 'not-a-receipt' }, [{ type: 'send', text: COPY.notReceipt }]];

    const replies: Reply[] = [];
    const text = summaryText(result);

    if (result.newLines.length > 0) {
      const batch: PendingReceiptBatch = {
        kind: 'receipt-batch',
        id: this.newId(),
        chatId: msg.chatId,
        receiptId: result.receiptId,
        purchasedOn: result.purchasedOn,
        lines: result.newLines,
        text,
        ...(msg.fromUserId !== undefined && { createdByUserId: msg.fromUserId }),
        createdAt: msg.receivedAt.toISOString(),
      };
      await this.pending.put(batch);
      replies.push({
        type: 'send',
        text,
        buttons: [[
          { text: COPY.addAll(result.newLines.length), data: `r:${batch.id}:y` },
          { text: COPY.skipAll, data: `r:${batch.id}:n` },
        ]],
      });
    } else {
      replies.push({ type: 'send', text });
    }

    for (const a of result.ambiguous) {
      const ask: PendingReceiptLine = {
        kind: 'receipt-line',
        id: this.newId(),
        chatId: msg.chatId,
        receiptId: result.receiptId,
        purchasedOn: result.purchasedOn,
        line: a.line,
        candidateItemId: a.candidate.id,
        proposal: a.proposal,
        ...(msg.fromUserId !== undefined && { createdByUserId: msg.fromUserId }),
        createdAt: msg.receivedAt.toISOString(),
      };
      await this.pending.put(ask);
      const buttons: Button[][] = [
        [{ text: COPY.yes, data: `l:${ask.id}:y` }],
        [{ text: COPY.newItem(a.proposal.name), data: `l:${ask.id}:n` }],
        [{ text: COPY.skip, data: `l:${ask.id}:x` }],
      ];
      replies.push({ type: 'send', text: COPY.askLine(a.line.description, a.candidate.name), buttons });
    }

    const parsed = {
      intent: 'receipt',
      status: 'ok',
      receiptId: result.receiptId,
      lines: result.lineCount,
      matched: result.matched.map((m) => ({ line: m.line.index, itemId: m.item.id })),
      new: result.newLines.length,
      ambiguous: result.ambiguous.length,
      cleared: result.clearedFromList.map((i) => i.id),
      llm: result.llm,
    };
    return [parsed, replies];
  }

  async onCallback(cb: InboundCallback, prefix: 'r' | 'l', id: string, choice: string): Promise<[Record<string, unknown>, Reply[]]> {
    const p = await this.pending.take(id); // atomic: double taps and stale buttons find nothing
    const ack: Reply = { type: 'ack', callbackId: cb.callbackId };
    if (!p || (prefix === 'r' && p.kind !== 'receipt-batch') || (prefix === 'l' && p.kind !== 'receipt-line')) {
      return [{ intent: 'callback-stale' }, [{ ...ack, text: COPY.stale }]];
    }
    const edit = (text: string): Reply => ({ type: 'edit', messageId: cb.messageId, text: clip(text) });
    const ctx = { ...(cb.fromUserId !== undefined && { userId: cb.fromUserId }), at: cb.receivedAt };

    if (p.kind === 'receipt-batch') {
      if (choice !== 'y') return [{ intent: 'receipt-new-skipped', receiptId: p.receiptId }, [ack, edit(`${p.text ?? ''}\n\n${COPY.skippedAll}`)]];
      const created = await this.receipts.confirmNew({ receiptId: p.receiptId, purchasedOn: p.purchasedOn, lines: p.lines, ...ctx });
      return [
        { intent: 'receipt-new-added', receiptId: p.receiptId, itemIds: created.map((i) => i.id) },
        [ack, edit(`${p.text ?? ''}\n\n${COPY.addedAll(created.length)}`)],
      ];
    }

    // p.kind === 'receipt-line' (narrowed by the guard above)
    const line = p as PendingReceiptLine;
    if (choice === 'x') return [{ intent: 'receipt-line-skipped', receiptId: line.receiptId }, [ack, edit(COPY.lineSkipped(line.line.description))]];
    const { item, cleared } = await this.receipts.confirmLine({
      receiptId: line.receiptId,
      purchasedOn: line.purchasedOn,
      line: line.line,
      answer: choice === 'y' ? { kind: 'existing', itemId: line.candidateItemId } : { kind: 'new', proposal: line.proposal },
      ...ctx,
    });
    return [
      { intent: 'receipt-line-answered', receiptId: line.receiptId, itemId: item.id },
      [ack, edit(COPY.lineMatched(line.line.description, item.name, cleared))],
    ];
  }
}

function summaryText(r: Extract<IngestResult, { status: 'ok' }>): string {
  const [y, m, d] = r.purchasedOn.split('-');
  const parts = [COPY.header(r.store, y ? `${d}/${m}` : r.purchasedOn, r.lineCount)];
  if (r.matched.length > 0) {
    const cleared = r.clearedFromList.map((i) => i.name).join(', ');
    parts.push(COPY.matched(r.matched.length) + (cleared ? COPY.cleared(cleared) : ''));
  }
  if (r.newLines.length > 0) {
    parts.push(COPY.newHeader(r.newLines.length));
    for (const n of r.newLines) parts.push(COPY.newLine(n.proposal.name, n.proposal.category));
  }
  if (r.ambiguous.length > 0) parts.push(COPY.ambiguous(r.ambiguous.length));
  return clip(parts.join('\n'));
}

function clip(text: string): string {
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE - 1)}…`;
}
