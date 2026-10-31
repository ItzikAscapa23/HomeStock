import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** SSM Parameter Store names. Created by hand (SecureString, standard tier) — see HANDOVER. */
export const PARAM_NAMES = {
  botToken: '/homestock/telegram/bot-token',
  webhookSecret: '/homestock/telegram/webhook-secret',
} as const;

export interface ParamReader {
  get(name: string): Promise<string>;
}

/** Reads SecureString parameters once per Lambda container and caches them. */
export class SsmParamReader implements ParamReader {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly ssm: SSMClient) {}

  get(name: string): Promise<string> {
    let value = this.cache.get(name);
    if (!value) {
      value = this.fetch(name);
      this.cache.set(name, value);
      // Don't cache a failure for the container's lifetime.
      value.catch(() => this.cache.delete(name));
    }
    return value;
  }

  private async fetch(name: string): Promise<string> {
    const res = await this.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = res.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter ${name} is empty or missing`);
    return value;
  }
}
