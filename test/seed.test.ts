import { describe, expect, it } from 'vitest';
import type { Item } from '../src/domain/item.js';
import { planSeed } from '../src/registry/seed.js';
import { exampleItems } from './fakes.js';

const AT = new Date('2026-11-01T00:00:00Z');

describe('planSeed', () => {
  it('the committed example registry is valid and collision-free', () => {
    const items = exampleItems();
    expect(items.length).toBeGreaterThanOrEqual(50);
    expect(items.every((i) => i.aliases.length > 0)).toBe(true); // the name itself is always an alias
  });

  it('re-seeding keeps aliases learned in use (R21)', () => {
    const existing: Item[] = [
      { id: 'milk', name: 'חלב', category: 'dairy', aliases: ['חלב', 'חלב עמיד'], flags: { staple: false, nonCyclic: false }, lastOutAt: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const plan = planSeed([{ id: 'milk', name: 'חלב', category: 'dairy', aliases: ['קרטון חלב'] }], existing, AT);
    expect(plan.items[0]).toMatchObject({
      aliases: ['חלב', 'קרטון חלב', 'חלב עמיד'],
      lastOutAt: 'x',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reports bad entries instead of writing them', () => {
    const plan = planSeed(
      [
        { id: 'Bad Id', name: 'x', category: 'dairy' },
        { id: 'ok', name: '', category: 'dairy' },
        { id: 'ok2', name: 'x', category: 'nope' },
        { id: 'dup', name: 'a', category: 'dairy' },
        { id: 'dup', name: 'b', category: 'dairy' },
      ],
      [],
      AT,
    );
    expect(plan.errors).toHaveLength(4);
    expect(plan.items.map((i) => i.id)).toEqual(['dup']);
  });

  it('detects an alias claimed by two items', () => {
    const plan = planSeed(
      [
        { id: 'a', name: 'סבון', category: 'cleaning' },
        { id: 'b', name: 'סבון ידיים', category: 'hygiene', aliases: ['סבון'] },
      ],
      [],
      AT,
    );
    expect(plan.collisions).toEqual([['סבון', ['a', 'b']]]);
  });
});
