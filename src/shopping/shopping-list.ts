import { CATEGORIES, CATEGORY_IDS } from '../domain/categories.js';
import type { Item, ListEntry, ListReason } from '../domain/item.js';
import type { ItemStore, ListStore } from '../persistence/stores.js';

/** User-facing copy for list reasons (R12). */
const REASON_LABEL: Record<ListReason, string> = {
  out: 'נגמר',
};

const COPY = {
  emptyList: 'הרשימה ריקה 🎉',
  title: '🛒 רשימת קניות',
  uncategorised: 'אחר',
} as const;

export interface ReportOutcome {
  added: Item[];
  alreadyListed: Item[];
}

export class ShoppingList {
  constructor(
    private readonly items: ItemStore,
    private readonly list: ListStore,
  ) {}

  /**
   * A depletion report is ground truth (R4, R5): mark the item out (its cycle resets from
   * this timestamp in phase 2) and put it on the list. Re-reporting doesn't duplicate.
   */
  async reportOut(reported: Item[], by: number | undefined, at: Date): Promise<ReportOutcome> {
    const outcome: ReportOutcome = { added: [], alreadyListed: [] };
    for (const item of reported) {
      await this.items.markOut(item.id, at);
      const added = await this.list.addIfAbsent({
        itemId: item.id,
        reason: 'out',
        createdAt: at.toISOString(),
        ...(by !== undefined && { createdByUserId: by }),
      });
      (added ? outcome.added : outcome.alreadyListed).push(item);
    }
    return outcome;
  }

  async openEntries(): Promise<ListEntry[]> {
    return this.list.listOpen();
  }

  /** Bought items leave the list (R3 via receipt). Returns the ids that were on it. */
  async clearBought(itemIds: string[]): Promise<string[]> {
    const open = new Set((await this.list.listOpen()).map((e) => e.itemId));
    const cleared = [...new Set(itemIds)].filter((id) => open.has(id));
    for (const id of cleared) await this.list.remove(id);
    return cleared;
  }
}

/** /list output: grouped by category in shop-walk order, one line per item with its reason (R12). */
export function formatList(entries: ListEntry[], itemsById: ReadonlyMap<string, Item>): string {
  if (entries.length === 0) return COPY.emptyList;

  const groups = new Map<string, string[]>();
  for (const e of [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const item = itemsById.get(e.itemId);
    const category = item?.category ?? 'household';
    const line = `• ${item?.name ?? e.itemId} — ${REASON_LABEL[e.reason] ?? e.reason}`;
    groups.set(category, [...(groups.get(category) ?? []), line]);
  }

  const sections = CATEGORY_IDS.filter((c) => groups.has(c)).map(
    (c) => `${CATEGORIES[c]}:\n${groups.get(c)!.join('\n')}`, // plain text: no parse_mode, nothing to escape
  );
  return `${COPY.title}\n\n${sections.join('\n\n')}`;
}
