import { CATEGORIES, CATEGORY_IDS, isCategoryId, type CategoryId } from '../domain/categories.js';
import type { Item, ReceiptLine } from '../domain/item.js';
import type { JsonSchema, LlmClient } from '../llm/types.js';
import { normaliseCode, type ItemRegistry } from '../registry/item-registry.js';

export type LineResolution =
  | { kind: 'matched'; line: ReceiptLine; itemId: string; via: 'code' | 'llm' }
  /** The model thinks it's probably this item but isn't sure — ask once. */
  | { kind: 'ambiguous'; line: ReceiptLine; candidateItemId: string; proposal: { name: string; category: CategoryId } }
  | { kind: 'new'; line: ReceiptLine; proposal: { name: string; category: CategoryId } };

/**
 * Receipt lines → registry items (R2). Item code first (exact, local, free — R22); every
 * line the codes don't cover goes to the model in ONE call with the full registry.
 */
export class ReceiptLineResolver {
  constructor(
    private readonly registry: ItemRegistry,
    private readonly llm: LlmClient,
  ) {}

  async resolve(lines: ReceiptLine[]): Promise<{ results: LineResolution[]; llm?: { provider: string; model: string } }> {
    const codes = await this.registry.codeIndex();
    const results: LineResolution[] = [];
    const rest: ReceiptLine[] = [];

    for (const line of lines) {
      const code = normaliseCode(line.code);
      const itemId = code ? codes.get(code) : undefined;
      if (itemId) results.push({ kind: 'matched', line, itemId, via: 'code' });
      else rest.push(line);
    }
    if (rest.length === 0) return { results: sortByLine(results) };

    const items = await this.registry.all();
    const known = new Set(items.map((i) => i.id));
    const { value, provider, model } = await this.llm.complete(
      {
        task: 'resolve-receipt-lines',
        system: systemPrompt(items),
        user: JSON.stringify(rest.map((l) => ({ i: l.index, code: l.code, description: l.description }))),
        schemaName: 'line_matches',
        schema: SCHEMA,
        maxTokens: 8000,
        timeoutMs: 60_000,
      },
      validate,
    );

    const byIndex = new Map(value.map((m) => [m.lineIndex, m]));
    for (const line of rest) {
      const m = byIndex.get(line.index);
      const itemId = m?.itemId && known.has(m.itemId) ? m.itemId : null;
      const proposal = m?.newItem && isCategoryId(m.newItem.category) && m.newItem.name.trim()
        ? { name: m.newItem.name.trim(), category: m.newItem.category }
        : { name: line.description, category: 'household' as const };

      if (itemId && m!.confidence === 'high') results.push({ kind: 'matched', line, itemId, via: 'llm' });
      else if (itemId) results.push({ kind: 'ambiguous', line, candidateItemId: itemId, proposal });
      else results.push({ kind: 'new', line, proposal });
    }
    return { results: sortByLine(results), llm: { provider, model } };
  }
}

function sortByLine(r: LineResolution[]): LineResolution[] {
  return r.sort((a, b) => a.line.index - b.line.index);
}

interface LineMatch {
  lineIndex: number;
  itemId: string | null;
  confidence: 'high' | 'low';
  newItem: { name: string; category: string } | null;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lineIndex', 'itemId', 'confidence', 'newItem'],
        properties: {
          lineIndex: { type: 'integer' },
          itemId: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: ['high', 'low'] },
          newItem: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'category'],
                properties: { name: { type: 'string' }, category: { type: 'string', enum: CATEGORY_IDS } },
              },
            ],
          },
        },
      },
    },
  },
};

function systemPrompt(items: Item[]): string {
  const registry = items.map((i) => `${i.id} | ${i.name} | ${i.category} | ${i.aliases.join(', ')}`).join('\n');
  const categories = Object.entries(CATEGORIES).map(([id, label]) => `${id} = ${label}`).join('\n');
  return `You match Israeli supermarket receipt lines to a household's item registry.

Receipt descriptions are abbreviated supermarket Hebrew with brands and sizes
("חלב בקרטון 3% שומן 1 ל'", "קוטג' 5% 250 גרם בעלז", "מיונז אמיתי תלמה 500 גרם").

This household tracks items at VARIANT level: a different fat percentage, a different type
(e.g. soy vs cow milk, whole-wheat vs white) or a meaningfully different product is a DIFFERENT
item. Package size and minor brand differences of the same product are the SAME item.
A registry item with a generic name (e.g. "חלב 3%" with alias "חלב") is the household's usual
variant — match lines of that variant to it.

The user message is a JSON array of lines {i, code, description}. Return one match per line:
- lineIndex: the line's i.
- itemId: the registry id this line is, or null if no registry item is this product.
- confidence: "high" only if you are sure. If it is probably that item but could be a different
  variant, use "low" with your best itemId.
- newItem: when itemId is null OR confidence is "low", propose the item to create: a short
  canonical Hebrew name that keeps the distinguishing variant (fat %, type, flavour) but drops
  package size and units (e.g. "שמנת להקצפה 38%", "קוטג' 5%", "מיונז"), and a category id.
  Otherwise null.
- Never invent registry ids.

Categories (id = label):
${categories}

Registry (id | name | category | aliases):
${registry}`;
}

function validate(json: unknown): LineMatch[] {
  const v = json as { matches?: unknown } | null;
  if (!v || !Array.isArray(v.matches)) throw new Error('Receipt line matching: malformed response');
  return (v.matches as Record<string, any>[])
    .filter((m) => m && Number.isInteger(m.lineIndex))
    .map((m) => ({
      lineIndex: m.lineIndex as number,
      itemId: typeof m.itemId === 'string' && m.itemId ? m.itemId : null,
      confidence: m.confidence === 'high' ? 'high' : 'low',
      newItem:
        m.newItem && typeof m.newItem.name === 'string' && typeof m.newItem.category === 'string'
          ? { name: m.newItem.name, category: m.newItem.category }
          : null,
    }));
}
