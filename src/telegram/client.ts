export interface ChatSender {
  sendMessage(chatId: number, text: string): Promise<void>;
}

/** Minimal Bot API client over global fetch — no SDK, keeps the bundle small. */
export class TelegramClient implements ChatSender {
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text });
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
