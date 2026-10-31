import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { PARAM_NAMES } from '../src/config/params.js';
import { TTL_ATTRIBUTE } from '../src/persistence/keys.js';

const src = (rel: string) => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));

export class HomeStockStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    Tags.of(this).add('project', 'homestock');

    // --- Data (RETAIN: a typo'd construct ID must not delete purchase history) ---
    const table = new Table(this, 'Table', {
      tableName: 'homestock',
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const bucket = new Bucket(this, 'ReceiptsBucket', {
      bucketName: Fn.join('-', ['homestock-receipts', Stack.of(this).account]),
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Lambdas: no VPC (C3), explicit 7-day log groups ---
    const paramArn = (name: string) =>
      Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.replace(/^\//, '') });

    const fnDefaults = (name: string): NodejsFunctionProps => ({
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      logGroup: new LogGroup(this, `${name}Logs`, {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: OutputFormat.ESM,
        minify: true,
        sourceMap: true,
        target: 'node22',
        // ESM bundles need `require` shimmed for CJS deps.
        banner: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
      },
    });

    const worker = new NodejsFunction(this, 'Worker', {
      ...fnDefaults('Worker'),
      entry: src('handlers/worker.ts'),
      memorySize: 512,
      timeout: Duration.seconds(60),
      retryAttempts: 0, // a retry after a successful send would double-reply (R25, R26)
      environment: { TABLE_NAME: table.tableName, NODE_OPTIONS: '--enable-source-maps' },
    });
    table.grantReadWriteData(worker);
    bucket.grantReadWrite(worker);
    worker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [paramArn(PARAM_NAMES.botToken)],
      }),
    );

    const ingress = new NodejsFunction(this, 'Ingress', {
      ...fnDefaults('Ingress'),
      entry: src('handlers/ingress.ts'),
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        WORKER_FUNCTION_NAME: worker.functionName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    table.grantReadWriteData(ingress);
    worker.grantInvoke(ingress);
    ingress.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [paramArn(PARAM_NAMES.webhookSecret)],
      }),
    );

    // --- HTTP API: one route, Telegram webhook ---
    const api = new HttpApi(this, 'Api', { apiName: 'homestock' });
    api.addRoutes({
      path: '/telegram',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('IngressIntegration', ingress),
    });

    new CfnOutput(this, 'WebhookUrl', { value: `${api.apiEndpoint}/telegram` });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
