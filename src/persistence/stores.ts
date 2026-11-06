import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { Item, ListEntry, Purchase, ReceiptLine } from '../domain/item.js';
import { keys, stripKeys, TTL_ATTRIBUTE } from './keys.js';

// ---------- interfaces (services depend on these, tests fake them) ----------

export interface ItemStore {
  listAll(): Promise<Item[]>;
  put(item: Item): Promise<void>;
  /** Adds an alias if absent. No-op if the item already has it. */
  addAlias(itemId: string, alias: string): Promise<void>;
  /** Adds a receipt item code if absent. */
  addCode(itemId: string, code: string): Promise<void>;
  markOut(itemId: string, at: Date): Promise<void>;
  delete(itemId: string): Promise<void>;
}

export interface ListStore {
  /** Returns false if the item already has an open entry (nothing written). */
  addIfAbsent(entry: ListEntry): Promise<boolean>;
  listOpen(): Promise<ListEntry[]>;
  remove(itemId: string): Promise<void>;
}

/** R23 — raw inbound plus what we made of it. */
export interface MessageRecord {
  updateId: number;
  receivedAt: string;
  chatId: number;
  fromUserId?: number;
  fromName?: string;
  kind: 'message' | 'callback';
  text: string;
  raw: unknown;
  parsed?: unknown;
}

export interface MessageLog {
  recordRaw(rec: MessageRecord): Promise<void>;
  recordParsed(updateId: number, receivedAt: Date, parsed: unknown): Promise<void>;
}

/** A question waiting for a button tap (unknown or ambiguous item in a report). */
export interface PendingAsk {
  /** Absent on rows written before receipts existed. */
  kind?: 'item';
  /** What confirming does: mark out (default — rows written before stock-in existed) or record a purchase. */
  action?: 'out' | 'in';
  id: string;
  chatId: number;
  /** The words the user wrote, normalised — becomes the alias on confirm (R21). */
  mention: string;
  /** Existing items the LLM thought it might be. */
  candidateItemIds: string[];
  /** A new item to create if the user picks "add". */
  proposal?: { name: string; category: string };
  createdByUserId?: number;
  createdAt: string;
}

/** Receipt lines that would become new items — confirmed together with one tap. */
export interface PendingReceiptBatch {
  kind: 'receipt-batch';
  id: string;
  chatId: number;
  receiptId: string;
  purchasedOn: string;
  lines: { line: ReceiptLine; proposal: { name: string; category: string } }[];
  /** The summary message text, so the edit after the tap can keep it. */
  text?: string;
  createdByUserId?: number;
  createdAt: string;
}

/** One genuinely ambiguous receipt line: "is this X?" */
export interface PendingReceiptLine {
  kind: 'receipt-line';
  id: string;
  chatId: number;
  receiptId: string;
  purchasedOn: string;
  line: ReceiptLine;
  candidateItemId: string;
  proposal: { name: string; category: string };
  createdByUserId?: number;
  createdAt: string;
}

/** "/same A = B" waiting for a confirm tap: fold item A into item B. */
export interface PendingMerge {
  kind: 'merge';
  id: string;
  chatId: number;
  sourceId: string;
  targetId: string;
  createdByUserId?: number;
  createdAt: string;
}

export type Pending = PendingAsk | PendingReceiptBatch | PendingReceiptLine | PendingMerge;

export interface PendingStore {
  put(p: Pending): Promise<void>;
  get(id: string): Promise<Pending | undefined>;
  /** Deletes and returns the pending row; undefined if it was already taken (double tap, stale button). */
  take(id: string): Promise<Pending | undefined>;
}

export interface PurchaseStore {
  add(purchases: Purchase[]): Promise<void>;
  listForItem(itemId: string): Promise<Purchase[]>;
  /** Moves an item's whole purchase history to another item (merge). Returns how many rows moved. */
  reassign(fromItemId: string, toItemId: string): Promise<number>;
}

/** Receipt bookkeeping. `claim` is the duplicate guard: the same file twice is recorded once. */
export interface ReceiptRecord {
  receiptId: string;
  chatId: number;
  receivedAt: string;
  status: 'processing' | 'done';
  fileKey?: string;
  store?: string | null;
  purchasedOn?: string;
  lines?: ReceiptLine[];
  summary?: Record<string, unknown>;
}

export interface ReceiptStore {
  claim(rec: ReceiptRecord): Promise<boolean>;
  release(receiptId: string): Promise<void>;
  complete(receiptId: string, fields: Partial<ReceiptRecord>): Promise<void>;
}

// ---------- DynamoDB implementations ----------

const PENDING_TTL_SECONDS = 3 * 24 * 60 * 60;

export class DynamoItemStore implements ItemStore {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

  async listAll(): Promise<Item[]> {
    const items: Item[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': keys.registryPartition },
          ExclusiveStartKey,
        }),
      );
      for (const r of res.Items ?? []) items.push(stripKeys<Item>(r));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async put(item: Item): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { ...keys.item(item.id), ...item } }));
  }

  async addAlias(itemId: string, alias: string): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.item(itemId),
          UpdateExpression: 'SET aliases = list_append(aliases, :a)',
          ConditionExpression: 'attribute_exists(PK) AND NOT contains(aliases, :alias)',
          ExpressionAttributeValues: { ':a': [alias], ':alias': alias },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }

  async addCode(itemId: string, code: string): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.item(itemId),
          UpdateExpression: 'SET codes = list_append(if_not_exists(codes, :empty), :c)',
          ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(codes) OR NOT contains(codes, :code))',
          ExpressionAttributeValues: { ':c': [code], ':code': code, ':empty': [] },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }

  async markOut(itemId: string, at: Date): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.item(itemId),
        UpdateExpression: 'SET lastOutAt = :at',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':at': at.toISOString() },
      }),
    );
  }

  async delete(itemId: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: keys.item(itemId) }));
  }
}

export class DynamoListStore implements ListStore {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

  async addIfAbsent(entry: ListEntry): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...keys.listEntry(entry.itemId), ...entry },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async listOpen(): Promise<ListEntry[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.openListPartition },
      }),
    );
    return (res.Items ?? []).map((r) => stripKeys<ListEntry>(r));
  }

  async remove(itemId: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: keys.listEntry(itemId) }));
  }
}

export class DynamoMessageLog implements MessageLog {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

  async recordRaw(rec: MessageRecord): Promise<void> {
    const at = new Date(rec.receivedAt);
    await this.db.send(
      new PutCommand({ TableName: this.table, Item: { ...keys.message(at, rec.updateId), ...rec } }),
    );
  }

  async recordParsed(updateId: number, receivedAt: Date, parsed: unknown): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.message(receivedAt, updateId),
        UpdateExpression: 'SET parsed = :p',
        ExpressionAttributeValues: { ':p': parsed },
      }),
    );
  }
}

export class DynamoPendingStore implements PendingStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly now: () => number = Date.now,
  ) {}

  async put(p: Pending): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...keys.pending(p.id),
          ...p,
          [TTL_ATTRIBUTE]: Math.floor(this.now() / 1000) + PENDING_TTL_SECONDS,
        },
      }),
    );
  }

  async get(id: string): Promise<Pending | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.pending(id) }));
    return res.Item ? stripKeys<Pending>(res.Item) : undefined;
  }

  async take(id: string): Promise<Pending | undefined> {
    const res = await this.db.send(
      new DeleteCommand({ TableName: this.table, Key: keys.pending(id), ReturnValues: 'ALL_OLD' }),
    );
    return res.Attributes ? stripKeys<Pending>(res.Attributes) : undefined;
  }
}

export class DynamoPurchaseStore implements PurchaseStore {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

  async reassign(fromItemId: string, toItemId: string): Promise<number> {
    const rows = await this.listForItem(fromItemId);
    await this.add(rows.map((p) => ({ ...p, itemId: toItemId })));
    for (const p of rows) {
      await this.db.send(
        new DeleteCommand({
          TableName: this.table,
          Key: keys.purchase(fromItemId, p.purchasedOn, p.receiptId ?? p.source, p.lineIndex ?? 0),
        }),
      );
    }
    return rows.length;
  }

  async add(purchases: Purchase[]): Promise<void> {
    for (const p of purchases) {
      const source = p.receiptId ?? p.source;
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...keys.purchase(p.itemId, p.purchasedOn, source, p.lineIndex ?? 0), ...p },
        }),
      );
    }
  }

  async listForItem(itemId: string): Promise<Purchase[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.purchasePartition(itemId) },
      }),
    );
    return (res.Items ?? []).map((r) => stripKeys<Purchase>(r));
  }
}

export class DynamoReceiptStore implements ReceiptStore {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

  async claim(rec: ReceiptRecord): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...keys.receipt(rec.receiptId), ...rec },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async release(receiptId: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: keys.receipt(receiptId) }));
  }

  async complete(receiptId: string, fields: Partial<ReceiptRecord>): Promise<void> {
    const entries = Object.entries({ ...fields, status: 'done' }).filter(([, v]) => v !== undefined);
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.receipt(receiptId),
        UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
        ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
        ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
      }),
    );
  }
}
