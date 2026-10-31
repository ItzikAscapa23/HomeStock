import { describe, expect, it } from 'vitest';
import { extractUpdateId, toInboundMessage } from '../src/telegram/parse.js';

describe('telegram parse', () => {
  it('extracts integer update_id only', () => {
    expect(extractUpdateId({ update_id: 10 })).toBe(10);
    expect(extractUpdateId({ update_id: '10' })).toBeUndefined();
    expect(extractUpdateId(null)).toBeUndefined();
  });

  it('maps a Hebrew text message to the domain type', () => {
    const msg = toInboundMessage({
      update_id: 1,
      message: { date: 1_700_000_000, text: 'נגמר חלב', chat: { id: -100 }, from: { id: 55 } },
    });
    expect(msg).toEqual({
      updateId: 1,
      chatId: -100,
      fromUserId: 55,
      text: 'נגמר חלב',
      receivedAt: new Date(1_700_000_000_000),
    });
  });

  it('ignores non-message updates and bot senders', () => {
    expect(toInboundMessage({ update_id: 1, callback_query: {} })).toBeUndefined();
    expect(
      toInboundMessage({ update_id: 2, message: { chat: { id: 1 }, from: { id: 9, is_bot: true }, text: 'x' } }),
    ).toBeUndefined();
  });
});
