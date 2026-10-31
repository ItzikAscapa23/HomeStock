import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { keys, TTL_ATTRIBUTE } from './keys.js';

/** Telegram retries for up to ~24h; keep dedupe markers a week, then let TTL clear them. */
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface DedupeStore {
  /** Returns true if this caller is the first to claim the update (R26). */
  claim(updateId: number): Promise<boolean>;
  /** Undo a claim so a Telegram retry can be processed. */
  release(updateId: number): Promise<void>;
}

export class DynamoDedupeStore implements DedupeStore {
  constructor(
    private readonly db: DynamoDBClient,
    private readonly tableName: string,
    private readonly now: () => number = Date.now,
  ) {}

  async claim(updateId: number): Promise<boolean> {
    const { PK, SK } = keys.updateDedupe(updateId);
    const expires = Math.floor(this.now() / 1000) + DEDUPE_TTL_SECONDS;
    try {
      await this.db.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: { PK: { S: PK }, SK: { S: SK }, [TTL_ATTRIBUTE]: { N: String(expires) } },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async release(updateId: number): Promise<void> {
    const { PK, SK } = keys.updateDedupe(updateId);
    await this.db.send(
      new DeleteItemCommand({ TableName: this.tableName, Key: { PK: { S: PK }, SK: { S: SK } } }),
    );
  }
}
