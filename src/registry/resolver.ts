import { CATEGORIES, CATEGORY_IDS, isCategoryId, type CategoryId } from '../domain/categories.js';
import type { Item } from '../domain/item.js';
import type { LlmClient, JsonSchema } from '../llm/types.js';
import { matchLocally } from './local-match.js';
import { normaliseAlias } from './normalise.js';
import type { ItemRegistry } from './item-registry.js';

export interface ResolvedItem {
  itemId: string;
  mention: string;
  via: 'local' | 'llm';
}

/** Something we couldn't pin down — the user is asked with buttons. */
export interface UnresolvedMention {
  mention: string;
  candidateItemIds: string[];
  proposal: { name: string; category: CategoryId } | undefined;
}

export type Resolution =
  | { kind: 'items'; path: 'local' | 'llm'; resolved: ResolvedItem[]; unresolved: UnresolvedMention[]; llm?: { provider: string; model: string } }
  /** Nothing item-like in the message (e.g. "תודה", or just "נגמר"). The bot stays quiet. */
  | { kind: 'not-a-report'; path: 'local' | 'llm'; llm?: { provider: string; model: string } };

/**
 * Resolution order (CLAUDE.md, R22): normalise → exact alias match locally → LLM with the
 * full registry → ask the user. The LLM is called only when the local pass leaves
 * content words unexplained.
 */
export class Resolver {
  constructor(
    private readonly registry: ItemRegistry,
    private readonly llm: LlmClient,
  ) {}

  async resolve(text: string): Promise<Resolution> {
    const local = matchLocally(text, await this.registry.aliasIndex());

    if (local.contentWordCount === 0) return { kind: 'not-a-report', path: 'local' };
    if (local.leftover.length === 0) {
      return {
        kind: 'items',
        path: 'local',
        resolved: local.matches.map((m) => ({ ...m, via: 'local' as const })),
        unresolved: [],
      };
    }
    return this.resolveWithLlm(text);
  }

  private async resolveWithLlm(text: string): Promise<Resolution> {
    const items = await this.registry.all();
    const known = new Set(items.map((i) => i.id));

    const { value, provider, model } = await this.llm.complete(
      {
        task: 'resolve-item',
        system: buildSystemPrompt(items),
        user: text,
        schemaName: 'resolution',
        schema: RESOLUTION_SCHEMA,
        maxTokens: 800,
      },
      validateLlmResolution,
    );
    const llm = { provider, model };

    if (!value.isReport || value.items.length === 0) return { kind: 'not-a-report', path: 'llm', llm };

    const resolved: ResolvedItem[] = [];
    const unresolved: UnresolvedMention[] = [];
    const seen = new Set<string>();

    for (const it of value.items) {
      const mention = normaliseAlias(it.mention) || normaliseAlias(text);
      const candidates = it.candidateItemIds.filter((id) => known.has(id));
      if (it.itemId && known.has(it.itemId) && it.confidence === 'high') {
        if (!seen.has(it.itemId)) resolved.push({ itemId: it.itemId, mention, via: 'llm' });
        seen.add(it.itemId);
        continue;
      }
      const fallbackCandidates = it.itemId && known.has(it.itemId) ? [it.itemId, ...candidates] : candidates;
      unresolved.push({
        mention,
        candidateItemIds: [...new Set(fallbackCandidates)].slice(0, 3),
        proposal: it.newItem && isCategoryId(it.newItem.category) && it.newItem.name.trim()
          ? { name: it.newItem.name.trim(), category: it.newItem.category }
          : undefined,
      });
    }
    return { kind: 'items', path: 'llm', resolved, unresolved, llm };
  }
}

// ---------- prompt + schema ----------

interface LlmResolution {
  isReport: boolean;
  items: {
    mention: string;
    itemId: string | null;
    confidence: 'high' | 'low';
    candidateItemIds: string[];
    newItem: { name: string; category: string } | null;
  }[];
}

const RESOLUTION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['isReport', 'items'],
  properties: {
    isReport: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['mention', 'itemId', 'confidence', 'candidateItemIds', 'newItem'],
        properties: {
          mention: { type: 'string' },
          itemId: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: ['high', 'low'] },
          candidateItemIds: { type: 'array', items: { type: 'string' } },
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

function buildSystemPrompt(items: Item[]): string {
  const registry = items
    .map((i) => `${i.id} | ${i.name} | ${i.category} | ${i.aliases.join(', ')}`)
    .join('\n');
  const categories = Object.entries(CATEGORIES)
    .map(([id, label]) => `${id} = ${label}`)
    .join('\n');

  return `You resolve household shopping messages written in Hebrew to items in a household's item registry.

Messages come from a family Telegram group used only for shopping. A typical message reports
that something ran out ("נגמר חלב", "אין לנו ביצים", "חסר נייר טואלט"). Hebrew is unvocalised,
prefixes fuse onto words (חלב / החלב / בחלב / והחלב), spelling varies, and shorthand is
ambiguous (סבון could be dish soap, hand soap or laundry detergent).

Rules:
- isReport = false if the message names no product at all (thanks, chatter, a question). Then items = [].
- One entry per distinct product mentioned, in message order.
- mention: the words naming the product as the user wrote them, without words like נגמר/אין/חסר/לנו or quantities.
- itemId: the registry id it refers to, or null if it is not in the registry.
- confidence "high" only if you are sure which registry item is meant. If several items fit
  (e.g. a generic "סבון" with several soaps), use "low", put your best guess in itemId (or null)
  and list the plausible ids in candidateItemIds (max 3).
- newItem: when itemId is null, propose a canonical Hebrew name (short, generic, no brand unless
  the user named one) and a category id. Otherwise null.
- Never invent registry ids. Use only ids from the list below.

Categories (id = label):
${categories}

Registry (id | name | category | aliases):
${registry}`;
}

function validateLlmResolution(json: unknown): LlmResolution {
  const v = json as Partial<LlmResolution> | null;
  if (!v || typeof v.isReport !== 'boolean' || !Array.isArray(v.items)) {
    throw new Error('LLM resolution: malformed response');
  }
  return {
    isReport: v.isReport,
    items: v.items
      .filter((i) => i && typeof i.mention === 'string')
      .map((i) => ({
        mention: i.mention,
        itemId: typeof i.itemId === 'string' && i.itemId ? i.itemId : null,
        confidence: i.confidence === 'high' ? 'high' : 'low',
        candidateItemIds: Array.isArray(i.candidateItemIds) ? i.candidateItemIds.filter((c) => typeof c === 'string') : [],
        newItem:
          i.newItem && typeof i.newItem.name === 'string' && typeof i.newItem.category === 'string'
            ? { name: i.newItem.name, category: i.newItem.category }
            : null,
      })),
  };
}
