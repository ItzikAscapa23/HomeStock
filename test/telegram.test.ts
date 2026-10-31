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

describe('telegram files (receipts)', () => {
  const base = { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, from: { id: 7 } };

  it('a PDF document becomes a pdf attachment', () => {
    const m = toInbound({
      update_id: 1,
      message: { ...base, document: { file_id: 'F', file_unique_id: 'U', mime_type: 'application/pdf', file_size: 10 } },
    });
    expect(m).toMatchObject({ attachment: { kind: 'pdf', fileId: 'F', fileUniqueId: 'U', mimeType: 'application/pdf', sizeBytes: 10 } });
  });

  it('a photo uses its largest size', () => {
    const m = toInbound({
      update_id: 1,
      message: {
        ...base,
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 90, height: 160 },
          { file_id: 'big', file_unique_id: 'b', width: 1280, height: 2276 },
          { file_id: 'mid', file_unique_id: 'm', width: 320, height: 569 },
        ],
      },
    });
    expect(m).toMatchObject({ attachment: { kind: 'image', fileId: 'big', fileUniqueId: 'b', mimeType: 'image/jpeg' } });
  });

  it('other documents are not attachments', () => {
    const m = toInbound({
      update_id: 1,
      message: { ...base, text: undefined, document: { file_id: 'F', file_unique_id: 'U', mime_type: 'application/zip' } },
    });
    expect(m && 'attachment' in m).toBe(false);
  });

  it('downloads through getFile and the file endpoint, with a size cap', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/r.pdf', file_size: 3 } }));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const tg = new TelegramClient(async () => 'TOKEN', fetchFn);
    expect([...(await tg.download('F', 10))]).toEqual([1, 2, 3]);
    expect(urls).toEqual(['https://api.telegram.org/botTOKEN/getFile', 'https://api.telegram.org/file/botTOKEN/documents/r.pdf']);
    await expect(tg.download('F', 2)).rejects.toThrow(/too large/);
  });
});
