import { describe, expect, it } from 'vitest';
import { handleWebhook, SECRET_HEADER, type WebhookDeps } from '../src/ingress/webhook.js';
import type { DedupeStore } from '../src/persistence/dedupe-store.js';

const SECRET = 'correct-secret';

class FakeDedupe implements DedupeStore {
  readonly claimed = new Set<number>();
  async claim(id: number) {
    if (this.claimed.has(id)) return false;
    this.claimed.add(id);
    return true;
  }
  async release(id: number) {
    this.claimed.delete(id);
  }
}

function setup(dispatchImpl?: (u: unknown) => Promise<void>) {
  const dispatched: unknown[] = [];
  const dedupe = new FakeDedupe();
  const deps: WebhookDeps = {
    getSecret: async () => SECRET,
    dedupe,
    dispatch: dispatchImpl ?? (async (u) => void dispatched.push(u)),
  };
  return { deps, dedupe, dispatched };
}

const req = (body: unknown, secret: string | undefined = SECRET) => ({
  headers: { [SECRET_HEADER]: secret },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const update = (id: number) => ({ update_id: id, message: { chat: { id: 1 }, text: 'hi', date: 0 } });

describe('handleWebhook', () => {
  it('rejects a wrong or missing secret without dispatching', async () => {
    const { deps, dispatched } = setup();
    expect((await handleWebhook(req(update(1), 'wrong'), deps)).statusCode).toBe(401);
    const noHeader = { headers: {}, body: JSON.stringify(update(1)) };
    expect((await handleWebhook(noHeader, deps)).statusCode).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('dispatches a new update and acks 200', async () => {
    const { deps, dispatched } = setup();
    expect((await handleWebhook(req(update(7)), deps)).statusCode).toBe(200);
    expect(dispatched).toEqual([update(7)]);
  });

  it('delivers the same update_id twice → dispatched exactly once (R26)', async () => {
    const { deps, dispatched } = setup();
    await handleWebhook(req(update(42)), deps);
    const second = await handleWebhook(req(update(42)), deps);
    expect(second.statusCode).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  it('acks 200 and ignores bodies that are not updates', async () => {
    const { deps, dispatched } = setup();
    expect((await handleWebhook(req('not json'), deps)).statusCode).toBe(200);
    expect((await handleWebhook(req({ foo: 1 }), deps)).statusCode).toBe(200);
    expect(dispatched).toHaveLength(0);
  });

  it('decodes base64 bodies', async () => {
    const { deps, dispatched } = setup();
    const body = Buffer.from(JSON.stringify(update(9))).toString('base64');
    await handleWebhook({ headers: { [SECRET_HEADER]: SECRET }, body, isBase64Encoded: true }, deps);
    expect(dispatched).toHaveLength(1);
  });

  it('on dispatch failure returns 500 and releases the claim so a retry is processed', async () => {
    let fail = true;
    const dispatched: unknown[] = [];
    const { deps } = setup(async (u) => {
      if (fail) throw new Error('boom');
      dispatched.push(u);
    });
    expect((await handleWebhook(req(update(5)), deps)).statusCode).toBe(500);
    fail = false;
    expect((await handleWebhook(req(update(5)), deps)).statusCode).toBe(200);
    expect(dispatched).toHaveLength(1);
  });
});
