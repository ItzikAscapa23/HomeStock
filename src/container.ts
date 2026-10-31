import { SSMClient } from '@aws-sdk/client-ssm';
import { PARAM_NAMES, SsmParamReader } from './config/params.js';
import { Dispatcher, type MessageDispatcher } from './dispatcher/dispatcher.js';
import { TelegramClient, type ChatSender } from './telegram/client.js';

/** Composition root — the only place services are constructed. Built once per Lambda container. */
export interface Container {
  telegram: ChatSender;
  dispatcher: MessageDispatcher;
}

let container: Container | undefined;

export function getContainer(): Container {
  if (container) return container;

  const params = new SsmParamReader(new SSMClient({}));
  const telegram = new TelegramClient(() => params.get(PARAM_NAMES.botToken));
  const dispatcher = new Dispatcher();

  return (container = { telegram, dispatcher });
}
