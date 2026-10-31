/**
 * One-time webhook registration. Deliberately NOT part of deploy.
 *
 *   AWS_PROFILE=homestock npm run webhook
 *
 * Reads the bot token and webhook secret from SSM, the webhook URL from the stack
 * outputs, and calls Telegram setWebhook. Prints getWebhookInfo afterwards.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SSMClient } from '@aws-sdk/client-ssm';
import { PARAM_NAMES, SsmParamReader } from '../src/config/params.js';

const STACK_NAME = 'HomeStock';

async function main(): Promise<void> {
  const params = new SsmParamReader(new SSMClient({}));
  const [token, secret] = await Promise.all([
    params.get(PARAM_NAMES.botToken),
    params.get(PARAM_NAMES.webhookSecret),
  ]);

  const cfn = new CloudFormationClient({});
  const stack = (await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }))).Stacks?.[0];
  const url = stack?.Outputs?.find((o) => o.OutputKey === 'WebhookUrl')?.OutputValue;
  if (!url) throw new Error(`WebhookUrl output not found on stack ${STACK_NAME} — deploy first`);

  const api = (method: string, body?: unknown) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then((r) => r.json() as Promise<{ ok: boolean; description?: string; result?: unknown }>);

  const set = await api('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    max_connections: 10,
  });
  if (!set.ok) throw new Error(`setWebhook failed: ${set.description}`);
  console.log(`Webhook set: ${url}`);
  console.log(JSON.stringify((await api('getWebhookInfo')).result, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
