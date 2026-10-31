import type { InboundMessage } from '../domain/message.js';

/** Decides the reply to an inbound message. Phase 0: echo-level "pong". Phase 1 grows intent routing here. */
export interface MessageDispatcher {
  handle(msg: InboundMessage): Promise<string | undefined>;
}

const COPY = { pong: 'pong' } as const;

export class Dispatcher implements MessageDispatcher {
  async handle(_msg: InboundMessage): Promise<string | undefined> {
    return COPY.pong;
  }
}
