import type { Button, Reply } from '../domain/message.js';

export interface ChatSender {
  /** Render a domain Reply to the Bot API. */
  deliver(chatId: number, reply: Reply): Promise<void>;
}

export interface FileSource {
  /** Downloads a file sent to the bot. Rejects files over `maxBytes`. */
  download(fileId: string, maxBytes: number): Promise<Uint8Array>;
}

/** Minimal Bot API client over global fetch — no SDK, keeps the bundle small. */
export class TelegramClient implements ChatSender, FileSource {
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async download(fileId: string, maxBytes: number): Promise<Uint8Array> {
    const meta = (await this.call('getFile', { file_id: fileId })) as {
      result?: { file_path?: string; file_size?: number };
    };
    const path = meta.result?.file_path;
    if (!path) throw new Error('Telegram getFile returned no file_path');
    if ((meta.result?.file_size ?? 0) > maxBytes) throw new Error(`File too large (${meta.result?.file_size} bytes)`);

    const token = await this.getToken();
    const res = await this.fetchFn(`https://api.telegram.org/file/bot${token}/${path}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`); // no URL: it carries the token
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`File too large (${bytes.byteLength} bytes)`);
    return bytes;
  }

  async deliver(chatId: number, reply: Reply): Promise<void> {
    switch (reply.type) {
      case 'send':
        await this.call('sendMessage', {
          chat_id: chatId,
          text: reply.text,
          ...(reply.buttons && { reply_markup: keyboard(reply.buttons) }),
        });
        return;
      case 'edit':
        await this.call('editMessageText', {
          chat_id: chatId,
          message_id: reply.messageId,
          text: reply.text,
          reply_markup: keyboard(reply.buttons ?? []),
        });
        return;
      case 'ack':
        await this.call('answerCallbackQuery', {
          callback_query_id: reply.callbackId,
          ...(reply.text && { text: reply.text }),
        });
        return;
    }
  }

  private async call(method: string, payload: unknown): Promise<unknown> {
    const token = await this.getToken();
    const res = await this.fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    // Never include the URL (it carries the token) in errors or logs.
    if (!res.ok || !body.ok) {
      throw new Error(`Telegram ${method} failed: ${res.status} ${body.description ?? ''}`.trim());
    }
    return body;
  }
}

function keyboard(rows: Button[][]) {
  return { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}
