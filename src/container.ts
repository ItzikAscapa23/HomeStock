import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PARAM_NAMES, SsmParamReader } from './config/params.js';
import { SsmChatGate } from './dispatcher/chat-gate.js';
import { Dispatcher } from './dispatcher/dispatcher.js';
import { ReceiptFlow } from './dispatcher/receipt-flow.js';
import { AnthropicAdapter } from './llm/anthropic.js';
import { OpenAiAdapter } from './llm/openai.js';
import { parseRouting, RoutedLlmClient } from './llm/routing.js';
import { S3ReceiptFiles } from './persistence/receipt-files.js';
import {
  DynamoItemStore,
  DynamoListStore,
  DynamoMessageLog,
  DynamoPendingStore,
  DynamoPurchaseStore,
  DynamoReceiptStore,
} from './persistence/stores.js';
import { ReceiptExtractor } from './receipts/extractor.js';
import { ReceiptLineResolver } from './receipts/line-resolver.js';
import { ReceiptService } from './receipts/receipt-service.js';
import { ItemRegistry } from './registry/item-registry.js';
import { Resolver } from './registry/resolver.js';
import { ShoppingList } from './shopping/shopping-list.js';
import { TelegramClient, type ChatSender, type FileSource } from './telegram/client.js';

/** Composition root — the only place services are constructed. Built once per Lambda container. */
export interface Container {
  telegram: ChatSender & FileSource;
  dispatcher: Dispatcher;
}

let container: Container | undefined;

export function getContainer(): Container {
  if (container) return container;

  const table = process.env.TABLE_NAME!;
  const bucket = process.env.BUCKET_NAME!;
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

  const pending = new DynamoPendingStore(db, table);
  const newId = () => randomUUID().replace(/-/g, '').slice(0, 10);

  const receipts = new ReceiptService({
    files: telegram,
    storage: new S3ReceiptFiles(new S3Client({}), bucket),
    receipts: new DynamoReceiptStore(db, table),
    extractor: new ReceiptExtractor(llm),
    lineResolver: new ReceiptLineResolver(registry, llm),
    registry,
    purchases: new DynamoPurchaseStore(db, table),
    shopping,
  });

  const dispatcher = new Dispatcher({
    gate: new SsmChatGate(settings),
    registry,
    resolver,
    shopping,
    pending,
    log: new DynamoMessageLog(db, table),
    receipts: new ReceiptFlow(receipts, pending, newId),
    newId,
  });

  return (container = { telegram, dispatcher });
}
