import type { LlmRequest, ProviderAdapter } from './types.js';

const URL = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 25_000;

/** OpenAI Chat Completions over fetch. Structured output via strict json_schema; prefix caching is automatic. */
export class OpenAiAdapter implements ProviderAdapter {
  readonly provider = 'openai' as const;

  constructor(
    private readonly getKey: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async completeJson(model: string, req: LlmRequest): Promise<unknown> {
    const body = {
      model,
      max_completion_tokens: req.maxTokens ?? 1024,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: req.schemaName, strict: true, schema: req.schema },
      },
    };

    const res = await this.fetchFn(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.getKey()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const json = (await res.json().catch(() => undefined)) as
      | { choices?: { message?: { content?: string | null; refusal?: string | null } }[]; error?: { message?: string } }
      | undefined;
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${json?.error?.message ?? 'request failed'}`);

    const message = json?.choices?.[0]?.message;
    if (message?.refusal) throw new Error(`OpenAI refused: ${message.refusal}`);
    if (!message?.content) throw new Error('OpenAI: response had no content');
    return JSON.parse(message.content);
  }
}
