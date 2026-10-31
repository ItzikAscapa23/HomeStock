import type { LlmRequest, ProviderAdapter } from './types.js';

const URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Anthropic Messages API over fetch. Structured output via native JSON-schema output
 * (`output_config.format`) — forced tool choice is rejected by Sonnet 5.5. The system prompt
 * is cache-marked. Newer models may think before answering, so the JSON is taken from the
 * text block(s), whatever else the response contains.
 */
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
      messages: [{ role: 'user', content: userContent(req) }],
      output_config: { format: { type: 'json_schema', schema: req.schema } },
    };

    const res = await this.fetchFn(URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': await this.getKey(),
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    const json = (await res.json().catch(() => undefined)) as
      | { content?: { type: string; text?: string }[]; stop_reason?: string; error?: { message?: string } }
      | undefined;
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${json?.error?.message ?? 'request failed'}`);

    // Truncated or refused output may not match the schema — fail loudly rather than parse garbage.
    if (json?.stop_reason === 'max_tokens') throw new Error('Anthropic: output truncated (max_tokens)');
    if (json?.stop_reason === 'refusal') throw new Error('Anthropic: refused');

    const text = (json?.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    if (!text) throw new Error('Anthropic: response had no text block');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Anthropic: response was not valid JSON');
    }
  }
}

/** Files first, then the text (Anthropic's recommended order for documents). */
function userContent(req: LlmRequest): string | unknown[] {
  if (!req.attachments?.length) return req.user;
  return [
    ...req.attachments.map((a) =>
      a.mediaType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } }
        : { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } },
    ),
    { type: 'text', text: req.user },
  ];
}
