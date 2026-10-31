import type { InboundMessage } from '../domain/message.js';

/** The subset of the Telegram Update object we read. Kept private to `telegram/`. */
interface TgUpdate {
  update_id?: unknown;
  message?: {
    date?: number;
    text?: string;
    caption?: string;
    chat?: { id?: number };
    from?: { id?: number; is_bot?: boolean };
  };
}

/** Extracts update_id from a raw webhook body, or undefined if the body isn't an Update. */
export function extractUpdateId(body: unknown): number | undefined {
  const id = (body as TgUpdate | null)?.update_id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined;
}

/** Maps a Telegram Update to a domain message. Non-message updates and bot senders return undefined. */
export function toInboundMessage(update: unknown): InboundMessage | undefined {
  const u = update as TgUpdate | null;
  const updateId = extractUpdateId(u);
  const msg = u?.message;
  const chatId = msg?.chat?.id;
  if (updateId === undefined || !msg || typeof chatId !== 'number') return undefined;
  if (msg.from?.is_bot) return undefined;

  return {
    updateId,
    chatId,
    fromUserId: msg.from?.id,
    text: msg.text ?? msg.caption ?? '',
    receivedAt: new Date((msg.date ?? 0) * 1000),
  };
}
