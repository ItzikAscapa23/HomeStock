import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoDedupeStore } from '../src/persistence/dedupe-store.js';

/** In-memory stand-in for the conditional-put semantics we rely on. */
function fakeDb() {
  const items = new Map<string, unknown>();
  const client = {
    async send(cmd: { constructor: { name: string }; input: any }) {
      const key = `${(cmd.input.Item ?? cmd.input.Key).PK.S}|${(cmd.input.Item ?? cmd.input.Key).SK.S}`;
      if (cmd.constructor.name === 'PutItemCommand') {
        if (items.has(key)) {
          throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
        }
        items.set(key, cmd.input.Item);
      } else if (cmd.constructor.name === 'DeleteItemCommand') {
        items.delete(key);
      }
      return {};
    },
  };
  return { client: client as unknown as DynamoDBClient, items };
}

describe('DynamoDedupeStore', () => {
  it('claims once, then refuses; release allows a re-claim', async () => {
    const { client, items } = fakeDb();
    const store = new DynamoDedupeStore(client, 't', () => 1_000_000);
    expect(await store.claim(1)).toBe(true);
    expect(await store.claim(1)).toBe(false);
    await store.release(1);
    expect(await store.claim(1)).toBe(true);
    const item = [...items.values()][0] as { ttl: { N: string } };
    expect(Number(item.ttl.N)).toBe(1000 + 7 * 24 * 3600);
  });
});
