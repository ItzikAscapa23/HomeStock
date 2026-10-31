import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';

/** SSM Parameter Store names. Created by hand (standard tier) — see README. */
export const PARAM_NAMES = {
  botToken: '/homestock/telegram/bot-token',
  webhookSecret: '/homestock/telegram/webhook-secret',
  /** Plain String, comma-separated chat ids the bot serves. Household-specific — never in git. */
  allowedChatIds: '/homestock/telegram/allowed-chat-ids',
  anthropicKey: '/homestock/llm/anthropic-api-key',
  openaiKey: '/homestock/llm/openai-api-key',
} as const;

export interface ParamReader {
  get(name: string): Promise<string>;
  /** undefined if the parameter doesn't exist. */
  getOptional(name: string): Promise<string | undefined>;
}

/** Reads parameters (decrypting SecureStrings) and caches them per Lambda container. */
export class SsmParamReader implements ParamReader {
  private readonly cache = new Map<string, { value: Promise<string | undefined>; at: number }>();

  constructor(
    private readonly ssm: SSMClient,
    private readonly maxAgeMs = Number.POSITIVE_INFINITY,
    private readonly now: () => number = Date.now,
  ) {}

  async get(name: string): Promise<string> {
    const value = await this.getOptional(name);
    if (!value) throw new Error(`SSM parameter ${name} is empty or missing`);
    return value;
  }

  getOptional(name: string): Promise<string | undefined> {
    const hit = this.cache.get(name);
    if (hit && this.now() - hit.at < this.maxAgeMs) return hit.value;

    const value = this.fetch(name);
    this.cache.set(name, { value, at: this.now() });
    value.catch(() => this.cache.delete(name)); // don't cache a failure
    return value;
  }

  private async fetch(name: string): Promise<string | undefined> {
    try {
      const res = await this.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return res.Parameter?.Value || undefined;
    } catch (err) {
      if (err instanceof ParameterNotFound) return undefined;
      throw err;
    }
  }
}
