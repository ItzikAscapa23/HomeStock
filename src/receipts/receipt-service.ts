import type { CategoryId } from '../domain/categories.js';
import { isCategoryId } from '../domain/categories.js';
import type { Item, Purchase, ReceiptLine } from '../domain/item.js';
import type { Attachment, ReceiptMime } from '../domain/message.js';
import type { ReceiptFiles } from '../persistence/receipt-files.js';
import type { PurchaseStore, ReceiptStore } from '../persistence/stores.js';
import type { ItemRegistry } from '../registry/item-registry.js';
import type { ShoppingList } from '../shopping/shopping-list.js';
import type { FileSource } from '../telegram/client.js';
import type { ReceiptExtractor } from './extractor.js';
import type { ReceiptLineResolver } from './line-resolver.js';

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export interface Proposal {
  name: string;
  category: CategoryId;
}

export type IngestResult =
  | { status: 'duplicate' }
  /** Not a PDF or an image (by content) — or too big. */
  | { status: 'unsupported-file' }
  | { status: 'not-a-receipt' }
  | {
      status: 'ok';
      receiptId: string;
      store: string | null;
      purchasedOn: string;
      lineCount: number;
      /** Recorded as purchases already (code or confident match). */
      matched: { line: ReceiptLine; item: Item }[];
      /** Of the matched items, those that were on the open list and came off it. */
      clearedFromList: Item[];
      /** Not in the registry — confirmed in bulk. */
      newLines: { line: ReceiptLine; proposal: Proposal }[];
      /** Probably an existing item — asked one by one. */
      ambiguous: { line: ReceiptLine; candidate: Item; proposal: Proposal }[];
      llm: { extract: { provider: string; model: string }; match?: { provider: string; model: string } };
    };

export interface ReceiptServiceDeps {
  files: FileSource;
  storage: ReceiptFiles;
  receipts: ReceiptStore;
  extractor: ReceiptExtractor;
  lineResolver: ReceiptLineResolver;
  registry: ItemRegistry;
  purchases: PurchaseStore;
  shopping: ShoppingList;
}

/** Stock-in from a receipt (R1, R2): store, extract, resolve, record purchases, clear the list. */
export class ReceiptService {
  constructor(private readonly d: ReceiptServiceDeps) {}

  async ingest(input: { attachment: Attachment; chatId: number; userId?: number; receivedAt: Date }): Promise<IngestResult> {
    const { attachment, chatId, userId, receivedAt } = input;
    const receiptId = attachment.fileUniqueId;
    if ((attachment.sizeBytes ?? 0) > MAX_RECEIPT_BYTES) return { status: 'unsupported-file' };

    // Duplicate guard: the same file sent twice is recorded once.
    const fresh = await this.d.receipts.claim({ receiptId, chatId, receivedAt: receivedAt.toISOString(), status: 'processing' });
    if (!fresh) return { status: 'duplicate' };

    try {
      const bytes = await this.d.files.download(attachment.fileId, MAX_RECEIPT_BYTES);
      const mimeType = sniffMime(bytes); // the declared type and file name aren't trusted
      if (!mimeType) {
        await this.d.receipts.release(receiptId);
        return { status: 'unsupported-file' };
      }
      const fileKey = await this.d.storage.put({ receiptId, receivedAt, bytes, mimeType });
      const extracted = await this.d.extractor.extract({
        mediaType: mimeType,
        base64: Buffer.from(bytes).toString('base64'),
      });

      if (!extracted.isReceipt || extracted.lines.length === 0) {
        await this.d.receipts.release(receiptId); // not a receipt — let a corrected re-send through
        return { status: 'not-a-receipt' };
      }

      const purchasedOn = extracted.purchasedOn ?? receivedAt.toISOString().slice(0, 10);
      const { results, llm: matchLlm } = await this.d.lineResolver.resolve(extracted.lines);

      const matched: { line: ReceiptLine; item: Item }[] = [];
      const newLines: { line: ReceiptLine; proposal: Proposal }[] = [];
      const ambiguous: { line: ReceiptLine; candidate: Item; proposal: Proposal }[] = [];

      for (const r of results) {
        if (r.kind === 'matched') {
          const item = await this.d.registry.get(r.itemId);
          if (!item) continue;
          if (r.via === 'llm') await this.d.registry.learnCode(item.id, r.line.code); // next time: local (R22)
          matched.push({ line: r.line, item });
        } else if (r.kind === 'ambiguous') {
          const candidate = await this.d.registry.get(r.candidateItemId);
          if (candidate) ambiguous.push({ line: r.line, candidate, proposal: r.proposal });
          else newLines.push({ line: r.line, proposal: r.proposal });
        } else {
          newLines.push({ line: r.line, proposal: r.proposal });
        }
      }

      const cleared = await this.record(matched, { receiptId, purchasedOn, userId, at: receivedAt });

      await this.d.receipts.complete(receiptId, {
        fileKey,
        store: extracted.store,
        purchasedOn,
        lines: extracted.lines,
        summary: { matched: matched.length, new: newLines.length, ambiguous: ambiguous.length },
      });

      return {
        status: 'ok',
        receiptId,
        store: extracted.store,
        purchasedOn,
        lineCount: extracted.lines.length,
        matched,
        clearedFromList: cleared,
        newLines,
        ambiguous,
        llm: { extract: extracted.llm, ...(matchLlm && { match: matchLlm }) },
      };
    } catch (err) {
      await this.d.receipts.release(receiptId).catch(() => {}); // failed — allow a retry
      throw err;
    }
  }

  /** "✓ add all new" — creates the items (with their codes) and records the purchases. */
  async confirmNew(input: {
    receiptId: string;
    purchasedOn: string;
    lines: { line: ReceiptLine; proposal: { name: string; category: string } }[];
    userId?: number;
    at: Date;
  }): Promise<Item[]> {
    const created: { line: ReceiptLine; item: Item }[] = [];
    for (const { line, proposal } of input.lines) {
      const category = isCategoryId(proposal.category) ? proposal.category : 'household';
      const item = await this.d.registry.create({ name: proposal.name, category, code: line.code, at: input.at });
      created.push({ line, item });
    }
    await this.record(created, input);
    return created.map((c) => c.item);
  }

  /** An ambiguous line answered: it IS the candidate (learn the code), or it's a new item. */
  async confirmLine(input: {
    receiptId: string;
    purchasedOn: string;
    line: ReceiptLine;
    answer: { kind: 'existing'; itemId: string } | { kind: 'new'; proposal: { name: string; category: string } };
    userId?: number;
    at: Date;
  }): Promise<{ item: Item; cleared: boolean }> {
    let item: Item | undefined;
    if (input.answer.kind === 'existing') {
      item = await this.d.registry.get(input.answer.itemId);
      if (!item) throw new Error(`Item ${input.answer.itemId} no longer exists`);
      await this.d.registry.learnCode(item.id, input.line.code);
    } else {
      const { name, category } = input.answer.proposal;
      item = await this.d.registry.create({
        name,
        category: isCategoryId(category) ? category : 'household',
        code: input.line.code,
        at: input.at,
      });
    }
    const cleared = await this.record([{ line: input.line, item }], input);
    return { item, cleared: cleared.length > 0 };
  }

  private async record(
    rows: { line: ReceiptLine; item: Item }[],
    ctx: { receiptId: string; purchasedOn: string; userId?: number; at: Date },
  ): Promise<Item[]> {
    if (rows.length === 0) return [];
    const purchases: Purchase[] = rows.map(({ line, item }) => ({
      itemId: item.id,
      quantity: line.quantity,
      unit: line.unit,
      source: 'receipt',
      purchasedOn: ctx.purchasedOn,
      receiptId: ctx.receiptId,
      lineIndex: line.index,
      createdAt: ctx.at.toISOString(),
      ...(ctx.userId !== undefined && { createdByUserId: ctx.userId }),
    }));
    await this.d.purchases.add(purchases);
    const clearedIds = new Set(await this.d.shopping.clearBought(rows.map((r) => r.item.id)));
    return rows.map((r) => r.item).filter((i, n, all) => clearedIds.has(i.id) && all.indexOf(i) === n);
  }
}

/** Identifies a receipt file by its first bytes. undefined = not something the model can read. */
export function sniffMime(bytes: Uint8Array): ReceiptMime | undefined {
  const head = (n: number) => [...bytes.subarray(0, n)];
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  // PDFs may have a little junk before the header; the spec allows it within the first 1024 bytes.
  if (ascii(0, Math.min(bytes.length, 1024)).includes('%PDF-')) return 'application/pdf';
  if (head(3).join() === '255,216,255') return 'image/jpeg';
  if (head(8).join() === '137,80,78,71,13,10,26,10') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}
