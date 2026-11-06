import type { Item, Purchase } from '../domain/item.js';
import type { ListStore, PurchaseStore } from '../persistence/stores.js';
import type { ItemRegistry } from '../registry/item-registry.js';
import type { ShoppingList } from '../shopping/shopping-list.js';

/** User-facing copy (R25: one line). */
const COPY = {
  onList: (name: string, day: string) => `${name}: נגמר (${day}) — ברשימה`,
  boughtNotOut: (name: string, day: string) => `${name}: נקנה ב-${day}, לא דווח שנגמר`,
  reportedOut: (name: string, day: string) => `${name}: דווח שנגמר ב-${day}`,
  unknown: (name: string) => `${name}: אין לי מידע עדיין`,
} as const;

const TZ = 'Asia/Jerusalem';

/**
 * Stock state from ground truth only — depletion reports, purchases and the open list.
 * No prediction yet (phase 2): answers state what is known and when, never "we have it".
 */
export class StockService {
  constructor(
    private readonly shopping: ShoppingList,
    private readonly list: ListStore,
    private readonly purchases: PurchaseStore,
    private readonly registry: ItemRegistry,
  ) {}

  /** "קניתי חלב" (R3, source manual): records a purchase today and takes the item off the list. */
  async recordBought(items: Item[], userId: number | undefined, at: Date): Promise<{ cleared: Item[] }> {
    const day = localDay(at);
    const purchases: Purchase[] = items.map((item, n) => ({
      itemId: item.id,
      quantity: 1,
      unit: 'unit',
      source: 'manual',
      purchasedOn: day,
      // Several manual purchases of one item on one day must not overwrite each other.
      lineIndex: at.getTime() % 1_000_000_000 + n,
      createdAt: at.toISOString(),
      ...(userId !== undefined && { createdByUserId: userId }),
    }));
    await this.purchases.add(purchases);
    const cleared = new Set(await this.shopping.clearBought(items.map((i) => i.id), day));
    return { cleared: items.filter((i) => cleared.has(i.id)) };
  }

  /** One line per item for "יש לנו X?" (R27, without prediction). */
  async describe(items: Item[]): Promise<string> {
    const open = new Map((await this.list.listOpen()).map((e) => [e.itemId, e]));
    const lines: string[] = [];
    for (const item of items) {
      const entry = open.get(item.id);
      if (entry) {
        lines.push(COPY.onList(item.name, shortDay(localDay(new Date(entry.createdAt)))));
        continue;
      }
      const lastBought = (await this.purchases.listForItem(item.id))
        .map((p) => p.purchasedOn)
        .sort()
        .at(-1);
      const lastOut = item.lastOutAt ? localDay(new Date(item.lastOutAt)) : undefined;
      if (lastBought && (!lastOut || lastBought >= lastOut)) lines.push(COPY.boughtNotOut(item.name, shortDay(lastBought)));
      else if (lastOut) lines.push(COPY.reportedOut(item.name, shortDay(lastOut)));
      else lines.push(COPY.unknown(item.name));
    }
    return lines.join(' · ');
  }

  /** Moves purchase history and the open list row when two items are merged. */
  async mergeInto(sourceId: string, targetId: string): Promise<number> {
    if (sourceId === targetId) return 0;
    const moved = await this.purchases.reassign(sourceId, targetId);
    const entry = (await this.list.listOpen()).find((e) => e.itemId === sourceId);
    if (entry) {
      await this.list.addIfAbsent({ ...entry, itemId: targetId });
      await this.list.remove(sourceId);
    }
    return moved;
  }
}

export function localDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(at);
}

function shortDay(isoDay: string): string {
  const [, m, d] = isoDay.split('-');
  return `${Number(d)}/${Number(m)}`;
}
