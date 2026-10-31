import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { Item, ListEntry } from '../domain/item.js';
import { keys, stripKeys, TTL_ATTRIBUTE } from './keys.js';

// ---------- interfaces (services depend on these, tests fake them) ----------

export interface ItemStore {
  listAll(): Promise<Item[]>;
  put(item: Item): Promise<void>;
  /** Adds an alias if absent. No-op if the item already has it. */
  addAlias(itemId: string, alias: string): Promise<void>;
  markOut(itemId: string, at: Date): Promise<void>;
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

/** A question waiting for a button tap (unknown or ambiguous item). */
export interface PendingAsk {
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

export interface PendingStore {
  put(p: PendingAsk): Promise<void>;
  get(id: string): Promise<PendingAsk | undefined>;
  /** Deletes and returns the ask; undefined if it was already taken (double tap, stale button). */
  take(id: string): Promise<PendingAsk | undefined>;
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

  async put(p: PendingAsk): Promise<void> {
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

  async get(id: string): Promise<PendingAsk | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: keys.pending(id) }));
    return res.Item ? stripKeys<PendingAsk>(res.Item) : undefined;
  }

  async take(id: string): Promise<PendingAsk | undefined> {
    const res = await this.db.send(
      new DeleteCommand({ TableName: this.table, Key: keys.pending(id), ReturnValues: 'ALL_OLD' }),
    );
    return res.Attributes ? stripKeys<PendingAsk>(res.Attributes) : undefined;
  }
}
