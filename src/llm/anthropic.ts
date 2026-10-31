import type { LlmRequest, ProviderAdapter } from './types.js';

const URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 25_000;

/** Anthropic Messages API over fetch. Structured output via a forced tool call; the system prompt is cache-marked. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;

  constructor(
    private readonly getKey: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async completeJson(model: string, req: LlmRequest): Promise<unknown> {
    const body = {
      model,
      max_tokens: req.maxTokens ?? 1024,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: req.user }],
      tools: [{ name: req.schemaName, description: 'Return the result.', input_schema: req.schema }],
      tool_choice: { type: 'tool', name: req.schemaName },
    };

    const res = await this.fetchFn(URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': await this.getKey(),
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const json = (await res.json().catch(() => undefined)) as
      | { content?: { type: string; name?: string; input?: unknown }[]; error?: { message?: string } }
      | undefined;
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${json?.error?.message ?? 'request failed'}`);

    const toolUse = json?.content?.find((c) => c.type === 'tool_use' && c.name === req.schemaName);
    if (!toolUse) throw new Error('Anthropic: response had no tool_use block');
    return toolUse.input;
  }
}
