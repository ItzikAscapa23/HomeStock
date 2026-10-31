import { getContainer } from '../container.js';
import { toInboundMessage } from '../telegram/parse.js';

interface WorkerEvent {
  update: unknown;
}

/** Async worker: invoked by ingress with InvocationType=Event. Thin — logic lives in services. */
export async function handler(event: WorkerEvent): Promise<void> {
  const msg = toInboundMessage(event.update);
  if (!msg) return;

  const { dispatcher, telegram } = getContainer();
  const reply = await dispatcher.handle(msg);
  if (reply) await telegram.sendMessage(msg.chatId, reply);
}
