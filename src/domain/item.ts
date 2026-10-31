import type { CategoryId } from './categories.js';

/** A canonical item in the registry (R21). Every message, receipt line and recipe ingredient resolves to one. */
export interface Item {
  id: string;
  /** Canonical display name, Hebrew. */
  name: string;
  category: CategoryId;
  /** Normalised alias strings. Always includes the normalised canonical name. */
  aliases: string[];
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
