/** Domain view of inbound Telegram traffic. Telegram API shapes stop at `telegram/`. */

export interface InboundMessage {
  kind: 'message';
  updateId: number;
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel' | 'unknown';
  messageId: number;
  /** Telegram user id — attribution only, never authorisation (R24, N10). */
  fromUserId: number | undefined;
  fromName: string | undefined;
  text: string;
  /** Bot command without the leading slash or @botname suffix, lower-cased ("list"). */
  command: string | undefined;
  receivedAt: Date;
}

export interface InboundCallback {
  kind: 'callback';
  updateId: number;
  callbackId: string;
  chatId: number;
  /** The bot message the button belongs to. */
  messageId: number;
  fromUserId: number | undefined;
  fromName: string | undefined;
  data: string;
  receivedAt: Date;
}

export type Inbound = InboundMessage | InboundCallback;

/** A one-tap button. `data` must fit Telegram's 64-byte callback_data limit. */
export interface Button {
  text: string;
  data: string;
}

/** What the dispatcher wants said. Rendering to the Bot API happens in `telegram/`. */
export type Reply =
  | { type: 'send'; text: string; buttons?: Button[][] }
  | { type: 'edit'; messageId: number; text: string; buttons?: Button[][] }
  | { type: 'ack'; callbackId: string; text?: string };
