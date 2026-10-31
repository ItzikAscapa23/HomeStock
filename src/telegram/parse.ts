import type { Attachment, Inbound, InboundCallback, InboundMessage } from '../domain/message.js';

/** The subset of the Telegram Update object we read. Kept private to `telegram/`. */
interface TgUser {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
}
interface TgMessage {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  chat?: { id?: number; type?: string };
  from?: TgUser;
  entities?: { type?: string; offset?: number; length?: number }[];
  document?: TgFile & { mime_type?: string; file_name?: string };
  photo?: (TgFile & { width?: number; height?: number })[];
}
interface TgFile {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
}
interface TgUpdate {
  update_id?: unknown;
  message?: TgMessage;
  callback_query?: { id?: string; data?: string; from?: TgUser; message?: TgMessage };
}

/** Extracts update_id from a raw webhook body, or undefined if the body isn't an Update. */
export function extractUpdateId(body: unknown): number | undefined {
  const id = (body as TgUpdate | null)?.update_id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined;
}

/** Maps a Telegram Update to a domain event. Unsupported updates and bot senders return undefined. */
export function toInbound(update: unknown, now: Date = new Date()): Inbound | undefined {
  const u = update as TgUpdate | null;
  const updateId = extractUpdateId(u);
  if (updateId === undefined || !u) return undefined;
  if (u.message) return toMessage(updateId, u.message);
  if (u.callback_query) return toCallback(updateId, u.callback_query, now);
  return undefined;
}

function toMessage(updateId: number, msg: TgMessage): InboundMessage | undefined {
  const chatId = msg.chat?.id;
  if (typeof chatId !== 'number' || typeof msg.message_id !== 'number' || msg.from?.is_bot) return undefined;

  const text = msg.text ?? msg.caption ?? '';
  const cmdEntity = msg.entities?.find((e) => e.type === 'bot_command' && e.offset === 0);
  const command = cmdEntity
    ? text.slice(1, cmdEntity.length ?? text.length).split('@')[0]?.toLowerCase()
    : undefined;

  const attachment = attachmentOf(msg);
  return {
    kind: 'message',
    updateId,
    chatId,
    chatType: chatTypeOf(msg.chat?.type),
    messageId: msg.message_id,
    fromUserId: msg.from?.id,
    fromName: msg.from?.first_name,
    text,
    command: command || undefined,
    ...(attachment && { attachment }),
    receivedAt: new Date((msg.date ?? 0) * 1000),
  };
}

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** A PDF document, an image sent as a file, or a photo (largest size). Anything else: none. */
function attachmentOf(msg: TgMessage): Attachment | undefined {
  const doc = msg.document;
  if (doc?.file_id && doc.file_unique_id) {
    const mime = doc.mime_type ?? '';
    if (mime === 'application/pdf' || IMAGE_MIME.has(mime)) {
      return {
        kind: mime === 'application/pdf' ? 'pdf' : 'image',
        fileId: doc.file_id,
        fileUniqueId: doc.file_unique_id,
        mimeType: mime as Attachment['mimeType'],
        sizeBytes: doc.file_size,
      };
    }
    return undefined;
  }
  const largest = [...(msg.photo ?? [])]
    .filter((p) => p.file_id && p.file_unique_id)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];
  if (!largest) return undefined;
  return {
    kind: 'image',
    fileId: largest.file_id!,
    fileUniqueId: largest.file_unique_id!,
    mimeType: 'image/jpeg', // Telegram re-encodes photos as JPEG
    sizeBytes: largest.file_size,
  };
}

function toCallback(
  updateId: number,
  cb: NonNullable<TgUpdate['callback_query']>,
  now: Date,
): InboundCallback | undefined {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!cb.id || typeof chatId !== 'number' || typeof messageId !== 'number' || typeof cb.data !== 'string') {
    return undefined;
  }
  return {
    kind: 'callback',
    updateId,
    callbackId: cb.id,
    chatId,
    messageId,
    fromUserId: cb.from?.id,
    fromName: cb.from?.first_name,
    data: cb.data,
    receivedAt: now, // callback_query carries no timestamp of its own
  };
}

function chatTypeOf(t: string | undefined): InboundMessage['chatType'] {
  return t === 'private' || t === 'group' || t === 'supergroup' || t === 'channel' ? t : 'unknown';
}
