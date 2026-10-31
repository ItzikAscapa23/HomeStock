/** Domain view of an inbound chat message. Telegram API shapes stop at `telegram/`. */
export interface InboundMessage {
  updateId: number;
  chatId: number;
  /** Telegram user id — attribution only, never authorisation (R24, N10). */
  fromUserId: number | undefined;
  text: string;
  receivedAt: Date;
}
