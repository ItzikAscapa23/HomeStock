import { readFileSync } from 'node:fs';
import type { Item, ListEntry } from '../src/domain/item.js';
import type { LlmClient, LlmRequest, LlmResult } from '../src/llm/types.js';
import type {
  ItemStore,
  ListStore,
  MessageLog,
  MessageRecord,
  PendingAsk,
  PendingStore,
} from '../src/persistence/stores.js';
import { planSeed, type SeedEntry } from '../src/registry/seed.js';

/** The committed example registry, as stored items. */
export function exampleItems(): Item[] {
  const file = new URL('../seed/registry.example.json', import.meta.url);
  const { items } = JSON.parse(readFileSync(file, 'utf8')) as { items: SeedEntry[] };
  const plan = planSeed(items, [], new Date('2026-01-01T00:00:00Z'));
  if (plan.errors.length || plan.collisions.length) throw new Error(JSON.stringify(plan));
  return plan.items;
}

export class MemItemStore implements ItemStore {
  readonly items = new Map<string, Item>();
  listAllCalls = 0;
  constructor(seed: Item[] = []) {
    for (const i of seed) this.items.set(i.id, structuredClone(i));
  }
  async listAll() {
    this.listAllCalls++;
    return [...this.items.values()].map((i) => structuredClone(i));
  }
  async put(item: Item) {
    this.items.set(item.id, structuredClone(item));
  }
  async addAlias(id: string, alias: string) {
    const i = this.items.get(id);
    if (i && !i.aliases.includes(alias)) i.aliases.push(alias);
  }
  async markOut(id: string, at: Date) {
    const i = this.items.get(id);
    if (!i) throw new Error('no such item');
    i.lastOutAt = at.toISOString();
  }
}

export class MemListStore implements ListStore {
  readonly entries = new Map<string, ListEntry>();
  async addIfAbsent(e: ListEntry) {
    if (this.entries.has(e.itemId)) return false;
    this.entries.set(e.itemId, e);
    return true;
  }
  async listOpen() {
    return [...this.entries.values()];
  }
  async remove(id: string) {
    this.entries.delete(id);
  }
}

export class MemMessageLog implements MessageLog {
  readonly records = new Map<number, MessageRecord>();
  async recordRaw(rec: MessageRecord) {
    this.records.set(rec.updateId, structuredClone(rec));
  }
  async recordParsed(updateId: number, _at: Date, parsed: unknown) {
    const r = this.records.get(updateId);
    if (!r) throw new Error('parsed before raw');
    r.parsed = structuredClone(parsed);
  }
}

export class MemPendingStore implements PendingStore {
  readonly asks = new Map<string, PendingAsk>();
  async put(p: PendingAsk) {
    this.asks.set(p.id, structuredClone(p));
  }
  async get(id: string) {
    return this.asks.get(id);
  }
  async take(id: string) {
    const a = this.asks.get(id);
    this.asks.delete(id);
    return a;
  }
}

/** Scripted LLM: returns the queued answers in order and records every request. */
export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly answers: unknown[] = []) {}
  queue(answer: unknown) {
    this.answers.push(answer);
  }
  async complete<T>(req: LlmRequest, validate: (json: unknown) => T): Promise<LlmResult<T>> {
    this.requests.push(req);
    if (this.answers.length === 0) throw new Error('FakeLlm: unexpected call');
    return { value: validate(this.answers.shift()), provider: 'anthropic', model: 'fake' };
  }
}
