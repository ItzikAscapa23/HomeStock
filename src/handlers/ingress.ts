import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PARAM_NAMES, SsmParamReader } from '../config/params.js';
import { handleWebhook } from '../ingress/webhook.js';
import { DynamoDedupeStore } from '../persistence/dedupe-store.js';

// Ingress deliberately does NOT use the container or any LLM client (CLAUDE.md: ingress stays minimal).
const TABLE_NAME = process.env.TABLE_NAME!;
const WORKER_FUNCTION_NAME = process.env.WORKER_FUNCTION_NAME!;

const params = new SsmParamReader(new SSMClient({}));
const dedupe = new DynamoDedupeStore(new DynamoDBClient({}), TABLE_NAME);
const lambda = new LambdaClient({});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { statusCode } = await handleWebhook(
    { headers: event.headers, body: event.body, isBase64Encoded: event.isBase64Encoded },
    {
      getSecret: () => params.get(PARAM_NAMES.webhookSecret),
      dedupe,
      dispatch: async (update) => {
        await lambda.send(
          new InvokeCommand({
            FunctionName: WORKER_FUNCTION_NAME,
            InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify({ update })),
          }),
        );
      },
      log: (msg, data) => console.log(JSON.stringify({ msg, ...data })),
    },
  );
  return { statusCode };
}
