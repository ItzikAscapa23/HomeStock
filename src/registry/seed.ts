import { isCategoryId } from '../domain/categories.js';
import type { Item } from '../domain/item.js';
import { normaliseAlias } from './normalise.js';

export interface SeedEntry {
  id: string;
  name: string;
  category: string;
  aliases?: string[];
  staple?: boolean;
  nonCyclic?: boolean;
}

export interface SeedPlan {
  items: Item[];
  errors: string[];
  /** alias → item ids that claim it. More than one id is a collision. */
  collisions: [string, string[]][];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Turns a seed file into registry items, merging onto what's already stored so aliases
 * learned in use (R21) are never lost by re-seeding.
 */
export function planSeed(entries: SeedEntry[], existing: Item[], at: Date): SeedPlan {
  const errors: string[] = [];
  const byId = new Map(existing.map((i) => [i.id, i]));
  const seenIds = new Set<string>();
  const items: Item[] = [];

  for (const [n, e] of entries.entries()) {
    const where = `item #${n + 1} (${e?.id ?? '?'})`;
    if (!e || typeof e.id !== 'string' || !ID_PATTERN.test(e.id)) { errors.push(`${where}: bad id`); continue; }
    if (seenIds.has(e.id)) { errors.push(`${where}: duplicate id`); continue; }
    if (typeof e.name !== 'string' || !normaliseAlias(e.name)) { errors.push(`${where}: missing name`); continue; }
    if (!isCategoryId(e.category)) { errors.push(`${where}: unknown category "${e.category}"`); continue; }
    seenIds.add(e.id);

    const prev = byId.get(e.id);
    const aliases = [
      ...new Set([e.name, ...(e.aliases ?? []), ...(prev?.aliases ?? [])].map(normaliseAlias).filter(Boolean)),
    ];
    items.push({
      ...prev,
      id: e.id,
      name: e.name.trim(),
      category: e.category,
      aliases,
      flags: { staple: e.staple === true, nonCyclic: e.nonCyclic === true },
      createdAt: prev?.createdAt ?? at.toISOString(),
    });
  }

  // Items created through the bot (not in the seed file) also claim aliases.
  const all = [...items, ...existing.filter((i) => !seenIds.has(i.id))];
  const claims = new Map<string, Set<string>>();
  for (const item of all) {
    for (const a of item.aliases) claims.set(a, (claims.get(a) ?? new Set()).add(item.id));
  }
  const collisions = [...claims].filter(([, ids]) => ids.size > 1).map(([a, ids]) => [a, [...ids]] as [string, string[]]);

  return { items, errors, collisions };
}
