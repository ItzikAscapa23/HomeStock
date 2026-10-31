import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ItemRegistry } from '../src/registry/item-registry.js';
import { matchLocally } from '../src/registry/local-match.js';
import { contentWords, normalise, prefixVariants } from '../src/registry/normalise.js';
import { Resolver } from '../src/registry/resolver.js';
import { exampleItems, FakeLlm, MemItemStore } from './fakes.js';

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/hebrew-reports.json', import.meta.url), 'utf8'),
) as {
  local: { text: string; items: string[] }[];
  needsLlm: { text: string; why: string }[];
  notAReport: { text: string }[];
};

function setup(answers: unknown[] = []) {
  const store = new MemItemStore(exampleItems());
  const registry = new ItemRegistry(store);
  const llm = new FakeLlm(answers);
  return { store, registry, llm, resolver: new Resolver(registry, llm) };
}

describe('normalise', () => {
  it('strips niqqud, geresh, punctuation, digits and extra whitespace', () => {
    expect(normalise('  חָלָב!!  ')).toBe('חלב');
    expect(normalise('קוטג׳')).toBe('קוטג');
    expect(normalise("קוטג'")).toBe('קוטג');
    expect(normalise('2 ליטר, חלב.')).toBe('ליטר חלב');
  });

  it('peels fused prefixes one letter at a time, unstripped form first', () => {
    expect(prefixVariants('והחלב')).toEqual(['והחלב', 'החלב', 'חלב']);
    expect(prefixVariants('מלח')).toEqual(['מלח', 'לח']);
    expect(prefixVariants('חלב')).toEqual(['חלב']);
  });

  it('drops fillers, including prefixed ones', () => {
    expect(contentWords('נגמר לנו החלב')).toEqual(['החלב']);
    expect(contentWords('ונגמרו כבר הביצים')).toEqual(['הביצים']);
  });
});

describe('local resolution — Hebrew fixtures (no LLM call allowed)', () => {
  for (const c of fixtures.local) {
    it(`"${c.text}" → ${c.items.join(', ')}`, async () => {
      const { resolver, llm } = setup();
      const r = await resolver.resolve(c.text);
      expect(llm.requests).toHaveLength(0);
      expect(r.kind).toBe('items');
      if (r.kind !== 'items') return;
      expect(r.path).toBe('local');
      expect(r.resolved.map((x) => x.itemId)).toEqual(c.items);
      expect(r.resolved.every((x) => x.via === 'local')).toBe(true);
    });
  }

  for (const c of fixtures.notAReport) {
    it(`"${c.text}" is not a report and stays quiet without an LLM call`, async () => {
      const { resolver, llm } = setup();
      expect((await resolver.resolve(c.text)).kind).toBe('not-a-report');
      expect(llm.requests).toHaveLength(0);
    });
  }

  it('prefers the longest alias (שמן זית over שמן)', async () => {
    const { registry } = setup();
    const r = matchLocally('נגמר שמן זית', await registry.aliasIndex());
    expect(r.matches.map((m) => m.itemId)).toEqual(['olive-oil']);
    expect(r.leftover).toEqual([]);
  });

  it('counts a repeated item once', async () => {
    const { resolver } = setup();
    const r = await resolver.resolve('חלב חלב');
    expect(r.kind === 'items' && r.resolved.map((x) => x.itemId)).toEqual(['milk']);
  });
});

describe('LLM fallback', () => {
  for (const c of fixtures.needsLlm) {
    it(`"${c.text}" goes to the LLM (${c.why})`, async () => {
      const { resolver, llm } = setup([{ isReport: false, items: [] }]);
      await resolver.resolve(c.text);
      expect(llm.requests).toHaveLength(1);
    });
  }

  it('sends the full registry and the raw message', async () => {
    const { resolver, llm } = setup([{ isReport: false, items: [] }]);
    await resolver.resolve('נגמרה הקינואה');
    const req = llm.requests[0]!;
    expect(req.task).toBe('resolve-item');
    expect(req.user).toBe('נגמרה הקינואה');
    for (const item of exampleItems()) expect(req.system).toContain(`${item.id} | ${item.name}`);
  });

  it('a confident match resolves the item', async () => {
    const { resolver } = setup([
      { isReport: true, items: [{ mention: 'חלב סויה', itemId: 'milk', confidence: 'high', candidateItemIds: [], newItem: null }] },
    ]);
    const r = await resolver.resolve('נגמר חלב סויה');
    expect(r).toMatchObject({ kind: 'items', path: 'llm', resolved: [{ itemId: 'milk', mention: 'חלב סויה', via: 'llm' }] });
  });

  it('an ambiguous match becomes a question with candidates', async () => {
    const { resolver } = setup([
      {
        isReport: true,
        items: [{ mention: 'הסבון', itemId: null, confidence: 'low', candidateItemIds: ['dish-soap', 'hand-soap', 'nope'], newItem: null }],
      },
    ]);
    const r = await resolver.resolve('נגמר הסבון');
    expect(r).toMatchObject({
      kind: 'items',
      resolved: [],
      unresolved: [{ mention: 'הסבון', candidateItemIds: ['dish-soap', 'hand-soap'] }],
    });
  });

  it('an unknown item comes back with a proposal', async () => {
    const { resolver } = setup([
      { isReport: true, items: [{ mention: 'קינואה', itemId: null, confidence: 'low', candidateItemIds: [], newItem: { name: 'קינואה', category: 'pantry' } }] },
    ]);
    const r = await resolver.resolve('נגמרה הקינואה');
    expect(r).toMatchObject({ unresolved: [{ mention: 'קינואה', proposal: { name: 'קינואה', category: 'pantry' } }] });
  });

  it('never trusts an invented item id', async () => {
    const { resolver } = setup([
      { isReport: true, items: [{ mention: 'משהו', itemId: 'made-up', confidence: 'high', candidateItemIds: [], newItem: null }] },
    ]);
    const r = await resolver.resolve('נגמר משהו');
    expect(r).toMatchObject({ resolved: [], unresolved: [{ candidateItemIds: [] }] });
  });

  it('rejects a malformed LLM response', async () => {
    const { resolver } = setup([{ nope: true }]);
    await expect(resolver.resolve('נגמרה הקינואה')).rejects.toThrow(/malformed/);
  });
});
