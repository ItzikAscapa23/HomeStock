import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PARAM_NAMES, SsmParamReader } from './config/params.js';
import { SsmChatGate } from './dispatcher/chat-gate.js';
import { Dispatcher } from './dispatcher/dispatcher.js';
import { AnthropicAdapter } from './llm/anthropic.js';
import { OpenAiAdapter } from './llm/openai.js';
import { parseRouting, RoutedLlmClient } from './llm/routing.js';
import {
  DynamoItemStore,
  DynamoListStore,
  DynamoMessageLog,
  DynamoPendingStore,
} from './persistence/stores.js';
import { ItemRegistry } from './registry/item-registry.js';
import { Resolver } from './registry/resolver.js';
import { ShoppingList } from './shopping/shopping-list.js';
import { TelegramClient, type ChatSender } from './telegram/client.js';

/** Composition root — the only place services are constructed. Built once per Lambda container. */
export interface Container {
  telegram: ChatSender;
  dispatcher: Dispatcher;
}

let container: Container | undefined;

export function getContainer(): Container {
  if (container) return container;

  const table = process.env.TABLE_NAME!;
  const ssm = new SSMClient({});
  const secrets = new SsmParamReader(ssm);
  const settings = new SsmParamReader(ssm, 5 * 60_000); // allowlist edits apply within 5 min, no deploy
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const telegram = new TelegramClient(() => secrets.get(PARAM_NAMES.botToken));

  const llm = new RoutedLlmClient(parseRouting(process.env.LLM_ROUTING), [
    new AnthropicAdapter(() => secrets.get(PARAM_NAMES.anthropicKey)),
    new OpenAiAdapter(() => secrets.get(PARAM_NAMES.openaiKey)),
  ]);

  const itemStore = new DynamoItemStore(db, table);
  const registry = new ItemRegistry(itemStore);
  const resolver = new Resolver(registry, llm);
  const shopping = new ShoppingList(itemStore, new DynamoListStore(db, table));

  const dispatcher = new Dispatcher({
    gate: new SsmChatGate(settings),
    registry,
    resolver,
    shopping,
    pending: new DynamoPendingStore(db, table),
    log: new DynamoMessageLog(db, table),
  });

  return (container = { telegram, dispatcher });
}
