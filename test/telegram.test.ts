import { describe, expect, it } from 'vitest';
import { TelegramClient } from '../src/telegram/client.js';
import { extractUpdateId, toInbound } from '../src/telegram/parse.js';

describe('telegram parse', () => {
  it('extracts integer update_id only', () => {
    expect(extractUpdateId({ update_id: 10 })).toBe(10);
    expect(extractUpdateId({ update_id: '10' })).toBeUndefined();
    expect(extractUpdateId(null)).toBeUndefined();
  });

  it('maps a Hebrew group message to the domain type', () => {
    expect(
      toInbound({
        update_id: 1,
        message: { message_id: 5, date: 1_700_000_000, text: 'נגמר חלב', chat: { id: -100, type: 'supergroup' }, from: { id: 55, first_name: 'Dana' } },
      }),
    ).toEqual({
      kind: 'message',
      updateId: 1,
      chatId: -100,
      chatType: 'supergroup',
      messageId: 5,
      fromUserId: 55,
      fromName: 'Dana',
      text: 'נגמר חלב',
      command: undefined,
      receivedAt: new Date(1_700_000_000_000),
    });
  });

  it('parses commands, including the @botname suffix used in groups', () => {
    const cmd = (text: string, length: number) =>
      toInbound({
        update_id: 2,
        message: { message_id: 1, text, chat: { id: 1 }, entities: [{ type: 'bot_command', offset: 0, length }] },
      });
    expect(cmd('/list', 5)).toMatchObject({ command: 'list' });
    expect(cmd('/List@homestock_bot', 19)).toMatchObject({ command: 'list' });
    expect(cmd('/chatid extra words', 7)).toMatchObject({ command: 'chatid' });
  });

  it('maps a button tap', () => {
    const now = new Date('2026-11-01T00:00:00Z');
    expect(
      toInbound(
        { update_id: 3, callback_query: { id: 'cb1', data: 'a:x:n', from: { id: 7 }, message: { message_id: 9, chat: { id: -100 } } } },
        now,
      ),
    ).toMatchObject({ kind: 'callback', callbackId: 'cb1', chatId: -100, messageId: 9, data: 'a:x:n', fromUserId: 7, receivedAt: now });
  });

  it('ignores bots, unsupported updates and malformed input', () => {
    expect(toInbound({ update_id: 1, message: { message_id: 1, chat: { id: 1 }, from: { id: 9, is_bot: true }, text: 'x' } })).toBeUndefined();
    expect(toInbound({ update_id: 1, edited_message: {} })).toBeUndefined();
    expect(toInbound({ update_id: 1, callback_query: { id: 'x' } })).toBeUndefined();
  });
});

describe('telegram client', () => {
  function client() {
    const calls: { url: string; body: any }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, tg: new TelegramClient(async () => 'TOKEN', fetchFn) };
  }

  it('renders send, edit and ack', async () => {
    const { tg, calls } = client();
    await tg.deliver(1, { type: 'send', text: 'hi', buttons: [[{ text: 'A', data: 'a:1:0' }]] });
    await tg.deliver(1, { type: 'edit', messageId: 5, text: 'done' });
    await tg.deliver(1, { type: 'ack', callbackId: 'cb', text: 'ok' });
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['sendMessage', 'editMessageText', 'answerCallbackQuery']);
    expect(calls[0]!.body).toEqual({ chat_id: 1, text: 'hi', reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'a:1:0' }]] } });
    expect(calls[1]!.body).toEqual({ chat_id: 1, message_id: 5, text: 'done', reply_markup: { inline_keyboard: [] } });
    expect(calls[2]!.body).toEqual({ callback_query_id: 'cb', text: 'ok' });
  });

  it('never puts the token in an error message', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status: 400 })) as unknown as typeof fetch;
    const tg = new TelegramClient(async () => 'SECRET-TOKEN', fetchFn);
    await expect(tg.deliver(1, { type: 'send', text: 'x' })).rejects.toThrow(/sendMessage failed: 400 Bad Request/);
    await expect(tg.deliver(1, { type: 'send', text: 'x' })).rejects.not.toThrow(/SECRET-TOKEN/);
  });
});
