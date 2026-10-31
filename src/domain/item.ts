import type { CategoryId } from './categories.js';

/** A canonical item in the registry (R21). Every message, receipt line and recipe ingredient resolves to one. */
export interface Item {
  id: string;
  /** Canonical display name, Hebrew. */
  name: string;
  category: CategoryId;
  /** Normalised alias strings. Always includes the normalised canonical name. */
  aliases: string[];
  /** Supermarket item codes / barcodes seen on receipts — exact, language-free matches (R22). */
  codes?: string[];
  /** R8 / R9 — stored now, used from phase 2. */
  flags: { staple: boolean; nonCyclic: boolean };
  /** Last ground-truth depletion report (R4, R5). Phase 2 uses it to reset the cycle. */
  lastOutAt?: string;
  createdAt: string;
}

export type ListReason = 'out';

/** An open line on the shopping list. One per item — re-reporting doesn't duplicate (R12). */
export interface ListEntry {
  itemId: string;
  reason: ListReason;
  createdAt: string;
  createdByUserId?: number;
  resolvedAt?: string;
}

/** A purchase — ground truth for interval learning (phase 2, R7). */
export interface Purchase {
  itemId: string;
  quantity: number;
  unit: 'unit' | 'kg';
  source: 'receipt' | 'list-confirm' | 'manual';
  /** Day of purchase, YYYY-MM-DD (from the receipt when known). */
  purchasedOn: string;
  receiptId?: string;
  lineIndex?: number;
  createdAt: string;
  createdByUserId?: number;
}

/** One product line as read from a receipt (promo/discount lines already dropped). */
export interface ReceiptLine {
  index: number;
  code: string | null;
  description: string;
  /** Supplied quantity, not ordered. */
  quantity: number;
  unit: 'unit' | 'kg';
}
