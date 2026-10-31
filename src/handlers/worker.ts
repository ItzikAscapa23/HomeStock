import { getContainer } from '../container.js';
import { toInbound } from '../telegram/parse.js';

interface WorkerEvent {
  update: unknown;
}

/** Async worker: invoked by ingress with InvocationType=Event. Thin — logic lives in services. */
export async function handler(event: WorkerEvent): Promise<void> {
  const inbound = toInbound(event.update);
  if (!inbound) return;

  const { dispatcher, telegram } = getContainer();
  const deliver = (reply: Parameters<typeof telegram.deliver>[1]) => telegram.deliver(inbound.chatId, reply);
  const replies = await dispatcher.handle(inbound, event.update, deliver);
  for (const reply of replies) await deliver(reply);
}
