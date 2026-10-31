/**
 * Provider-agnostic LLM interface (Q4 decision). Callers name a *task*; routing config
 * picks provider + model. Callers never see a provider or model name.
 */

export const LLM_TASKS = ['resolve-item'] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

export const LLM_PROVIDERS = ['anthropic', 'openai'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** JSON Schema for structured output. Keep it strict-mode compatible: every property
 *  required, `additionalProperties: false`, optional values expressed as nullable. */
export type JsonSchema = Record<string, unknown>;

export interface LlmRequest {
  task: LlmTask;
  /** Static instructions + reference data. Providers cache this prefix where they can. */
  system: string;
  /** The per-call input (the user's message). */
  user: string;
  /** Output shape, enforced by the provider (tool use / json_schema). */
  schemaName: string;
  schema: JsonSchema;
  maxTokens?: number;
}

export interface LlmResult<T> {
  value: T;
  provider: LlmProvider;
  model: string;
}

export interface LlmClient {
  /** Calls the model routed for `req.task` and validates the JSON it returns. */
  complete<T>(req: LlmRequest, validate: (json: unknown) => T): Promise<LlmResult<T>>;
}

/** One per provider. Adapters translate LlmRequest into that provider's wire format. */
export interface ProviderAdapter {
  readonly provider: LlmProvider;
  completeJson(model: string, req: LlmRequest): Promise<unknown>;
}

export type RoutingConfig = Record<LlmTask, { provider: LlmProvider; model: string }>;
