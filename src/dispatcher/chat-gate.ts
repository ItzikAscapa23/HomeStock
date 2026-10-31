import { PARAM_NAMES, type ParamReader } from '../config/params.js';

export interface ChatGate {
  isAllowed(chatId: number): Promise<boolean>;
}

/**
 * Only the household's chats are served. Anyone can find a bot and message it, and
 * every LLM call costs money, so unknown chats get silence (except /chatid).
 * The list lives in SSM so it stays out of git and changes without a deploy.
 */
export class SsmChatGate implements ChatGate {
  constructor(private readonly params: ParamReader) {}

  async isAllowed(chatId: number): Promise<boolean> {
    const raw = (await this.params.getOptional(PARAM_NAMES.allowedChatIds)) ?? '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(String(chatId));
  }
}
