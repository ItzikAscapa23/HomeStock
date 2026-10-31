import {
  LLM_PROVIDERS,
  LLM_TASKS,
  type LlmClient,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type ProviderAdapter,
  type RoutingConfig,
} from './types.js';

/** Defaults. Override any task with the LLM_ROUTING env var (set from CDK context `llmRouting`). */
export const DEFAULT_ROUTING: RoutingConfig = {
  'resolve-item': { provider: 'anthropic', model: 'claude-haiku-5-5' },
  // Reading a multi-page Hebrew receipt (bidi text, promo lines, substitutions) justifies the stronger model.
  'extract-receipt': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  'resolve-receipt-lines': { provider: 'anthropic', model: 'claude-haiku-5-5' },
};

/** Merges a JSON override (e.g. {"resolve-item":{"provider":"openai","model":"gpt-5.4-mini"}}) onto the defaults. */
export function parseRouting(json: string | undefined): RoutingConfig {
  const routing: RoutingConfig = structuredClone(DEFAULT_ROUTING);
  if (!json?.trim()) return routing;

  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('LLM_ROUTING must be a JSON object');

  for (const [task, route] of Object.entries(parsed)) {
    if (!(LLM_TASKS as readonly string[]).includes(task)) throw new Error(`LLM_ROUTING: unknown task "${task}"`);
    const r = route as { provider?: unknown; model?: unknown };
    if (!(LLM_PROVIDERS as readonly unknown[]).includes(r.provider)) {
      throw new Error(`LLM_ROUTING: task "${task}" has unknown provider "${String(r.provider)}"`);
    }
    if (typeof r.model !== 'string' || !r.model) throw new Error(`LLM_ROUTING: task "${task}" needs a model`);
    routing[task as keyof RoutingConfig] = { provider: r.provider as LlmProvider, model: r.model };
  }
  return routing;
}

export class RoutedLlmClient implements LlmClient {
  private readonly adapters: Map<LlmProvider, ProviderAdapter>;

  constructor(private readonly routing: RoutingConfig, adapters: ProviderAdapter[]) {
    this.adapters = new Map(adapters.map((a) => [a.provider, a]));
  }

  async complete<T>(req: LlmRequest, validate: (json: unknown) => T): Promise<LlmResult<T>> {
    const { provider, model } = this.routing[req.task];
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`No adapter registered for provider "${provider}"`);
    const json = await adapter.completeJson(model, req);
    return { value: validate(json), provider, model };
  }
}
