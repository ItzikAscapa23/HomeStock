import { App } from 'aws-cdk-lib';
import { HomeStockStack } from '../homestock-stack.js';

const app = new App();

// Account/region come from the `homestock` AWS profile at deploy time.
new HomeStockStack(app, 'HomeStock', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
