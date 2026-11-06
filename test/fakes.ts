import { readFileSync } from 'node:fs';
import type { Item, ListEntry } from '../src/domain/item.js';
import type { LlmClient, LlmRequest, LlmResult } from '../src/llm/types.js';
import type {
  ItemStore,
  ListStore,
  MessageLog,
  MessageRecord,
  Pending,
  PendingStore,
  PurchaseStore,
  ReceiptRecord,
  ReceiptStore,
} from '../src/persistence/stores.js';
import type { Purchase } from '../src/domain/item.js';
import type { ReceiptFiles } from '../src/persistence/receipt-files.js';
import type { FileSource } from '../src/telegram/client.js';
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
  async addCode(id: string, code: string) {
    const i = this.items.get(id);
    if (i && !(i.codes ?? []).includes(code)) i.codes = [...(i.codes ?? []), code];
  }
  async markOut(id: string, at: Date) {
    const i = this.items.get(id);
    if (!i) throw new Error('no such item');
    i.lastOutAt = at.toISOString();
  }
  async delete(id: string) {
    this.items.delete(id);
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
  readonly asks = new Map<string, Pending>();
  async put(p: Pending) {
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

export class MemPurchaseStore implements PurchaseStore {
  readonly rows: Purchase[] = [];
  async add(p: Purchase[]) {
    this.rows.push(...structuredClone(p));
  }
  async listForItem(itemId: string) {
    return this.rows.filter((r) => r.itemId === itemId);
  }
  async reassign(from: string, to: string) {
    const moving = this.rows.filter((r) => r.itemId === from);
    for (const r of moving) r.itemId = to;
    return moving.length;
  }
}

export class MemReceiptStore implements ReceiptStore {
  readonly records = new Map<string, ReceiptRecord>();
  async claim(rec: ReceiptRecord) {
    if (this.records.has(rec.receiptId)) return false;
    this.records.set(rec.receiptId, structuredClone(rec));
    return true;
  }
  async release(id: string) {
    this.records.delete(id);
  }
  async complete(id: string, fields: Partial<ReceiptRecord>) {
    const r = this.records.get(id);
    if (!r) throw new Error('complete before claim');
    Object.assign(r, structuredClone(fields), { status: 'done' });
  }
}

export class MemReceiptFiles implements ReceiptFiles {
  readonly files = new Map<string, Uint8Array>();
  async put(i: { receiptId: string; receivedAt: Date; bytes: Uint8Array; mimeType: string }) {
    const key = `receipts/${i.receiptId}`;
    this.files.set(key, i.bytes);
    return key;
  }
}

export class FakeFiles implements FileSource {
  readonly downloads: string[] = [];
  async download(fileId: string) {
    this.downloads.push(fileId);
    return new TextEncoder().encode(`%PDF-1.7 fake ${fileId}`);
  }
}
