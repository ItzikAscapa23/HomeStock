/**
 * Loads the item registry into DynamoDB. Safe to re-run: merges onto existing items and
 * keeps aliases the bot has learned. Never deletes items.
 *
 *   AWS_PROFILE=homestock npm run seed                  # seed/registry.local.json
 *   AWS_PROFILE=homestock npm run seed -- --dry-run     # show what would change
 *   AWS_PROFILE=homestock npm run seed -- path/to/file.json
 *
 * Household data stays out of git: copy seed/registry.example.json to
 * seed/registry.local.json and edit that.
 *
 * (Scripts are separate entry points, so they construct their own stores.)
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { existsSync, readFileSync } from 'node:fs';
import { DynamoItemStore } from '../src/persistence/stores.js';
import { planSeed, type SeedEntry } from '../src/registry/seed.js';

const STACK_NAME = 'HomeStock';
const DEFAULT_FILE = 'seed/registry.local.json';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--')) ?? DEFAULT_FILE;

  if (!existsSync(file)) {
    throw new Error(`${file} not found. Copy seed/registry.example.json to ${DEFAULT_FILE} and edit it first.`);
  }
  const entries = (JSON.parse(readFileSync(file, 'utf8')) as { items?: SeedEntry[] }).items;
  if (!Array.isArray(entries)) throw new Error(`${file}: expected { "items": [...] }`);

  const table = await tableName();
  const store = new DynamoItemStore(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    table,
  );

  const existing = await store.listAll();
  const plan = planSeed(entries, existing, new Date());

  if (plan.errors.length) {
    console.error(`Fix these in ${file} first:\n  ${plan.errors.join('\n  ')}`);
    process.exit(1);
  }
  if (plan.collisions.length) {
    console.error('Alias collisions (one alias, several items) — make each alias unique:');
    for (const [alias, ids] of plan.collisions) console.error(`  "${alias}": ${ids.join(', ')}`);
    process.exit(1);
  }

  const existingIds = new Set(existing.map((i) => i.id));
  const created = plan.items.filter((i) => !existingIds.has(i.id)).length;
  console.log(`${table}: ${plan.items.length} items in ${file} — ${created} new, ${plan.items.length - created} updated.`);
  if (dryRun) return console.log('Dry run — nothing written.');

  for (const item of plan.items) await store.put(item);
  console.log('Done.');
}

async function tableName(): Promise<string> {
  const cfn = new CloudFormationClient({});
  const stack = (await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }))).Stacks?.[0];
  const name = stack?.Outputs?.find((o) => o.OutputKey === 'TableName')?.OutputValue;
  if (!name) throw new Error(`TableName output not found on stack ${STACK_NAME} — deploy first`);
  return name;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
