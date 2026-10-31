import { randomUUID } from 'node:crypto';
import type { CategoryId } from '../domain/categories.js';
import type { Item } from '../domain/item.js';
import type { ItemStore } from '../persistence/stores.js';
import { normaliseAlias } from './normalise.js';

const CACHE_TTL_MS = 60_000;

/**
 * The item registry (R21): canonical items and their aliases. Loaded whole and cached per
 * Lambda container for a minute — 200–400 items fit in memory and in a prompt (N6).
 */
export class ItemRegistry {
  private cache: { items: Map<string, Item>; aliases: Map<string, string>; at: number } | undefined;

  constructor(
    private readonly store: ItemStore,
    private readonly now: () => number = Date.now,
  ) {}

  async all(): Promise<Item[]> {
    return [...(await this.load()).items.values()];
  }

  async get(itemId: string): Promise<Item | undefined> {
    return (await this.load()).items.get(itemId);
  }

  /** normalised alias → item id */
  async aliasIndex(): Promise<ReadonlyMap<string, string>> {
    return (await this.load()).aliases;
  }

  /** Writes a learned alias back (R21) so the same phrasing resolves locally next time (R22). */
  async learnAlias(itemId: string, mention: string): Promise<void> {
    const alias = normaliseAlias(mention);
    if (!alias) return;
    const cache = await this.load();
    const item = cache.items.get(itemId);
    if (!item || item.aliases.includes(alias)) return;
    await this.store.addAlias(itemId, alias);
    item.aliases.push(alias);
    if (!cache.aliases.has(alias)) cache.aliases.set(alias, itemId);
  }

  async create(input: { name: string; category: CategoryId; mention?: string; at: Date }): Promise<Item> {
    const aliases = [...new Set([input.name, input.mention ?? ''].map(normaliseAlias).filter(Boolean))];
    const item: Item = {
      id: `i-${randomUUID().slice(0, 8)}`,
      name: input.name.trim(),
      category: input.category,
      aliases,
      flags: { staple: false, nonCyclic: false },
      createdAt: input.at.toISOString(),
    };
    await this.store.put(item);
    const cache = await this.load();
    cache.items.set(item.id, item);
    for (const a of aliases) if (!cache.aliases.has(a)) cache.aliases.set(a, item.id);
    return item;
  }

  private async load() {
    if (this.cache && this.now() - this.cache.at < CACHE_TTL_MS) return this.cache;
    const list = await this.store.listAll();
    const items = new Map(list.map((i) => [i.id, i]));
    const aliases = new Map<string, string>();
    for (const item of list) {
      for (const a of [item.name, ...item.aliases].map(normaliseAlias)) {
        // First writer wins on collisions; collisions are a registry bug the seed script reports.
        if (a && !aliases.has(a)) aliases.set(a, item.id);
      }
    }
    this.cache = { items, aliases, at: this.now() };
    return this.cache;
  }
}
