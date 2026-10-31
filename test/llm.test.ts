import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../src/llm/anthropic.js';
import { OpenAiAdapter } from '../src/llm/openai.js';
import { DEFAULT_ROUTING, parseRouting, RoutedLlmClient } from '../src/llm/routing.js';
import type { LlmRequest, ProviderAdapter } from '../src/llm/types.js';

const req: LlmRequest = {
  task: 'resolve-item',
  system: 'SYSTEM',
  user: 'נגמר חלב',
  schemaName: 'resolution',
  schema: { type: 'object' },
  maxTokens: 100,
};

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('AnthropicAdapter', () => {
  it('forces a tool call with the schema, cache-marks the system prompt, returns the tool input', async () => {
    const { fn, calls } = fakeFetch(200, { content: [{ type: 'tool_use', name: 'resolution', input: { ok: 1 } }] });
    const out = await new AnthropicAdapter(async () => 'KEY', fn).completeJson('claude-haiku-5-5', req);
    expect(out).toEqual({ ok: 1 });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    expect(c.headers['x-api-key']).toBe('KEY');
    expect(c.body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 100,
      system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'נגמר חלב' }],
      tools: [{ name: 'resolution', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'resolution' },
    });
  });

  it('surfaces API errors without the key', async () => {
    const { fn } = fakeFetch(401, { error: { message: 'invalid x-api-key' } });
    const p = new AnthropicAdapter(async () => 'SECRET', fn).completeJson('m', req);
    await expect(p).rejects.toThrow('Anthropic 401: invalid x-api-key');
  });

  it('fails if there is no tool_use block', async () => {
    const { fn } = fakeFetch(200, { content: [{ type: 'text', text: 'hi' }] });
    await expect(new AnthropicAdapter(async () => 'K', fn).completeJson('m', req)).rejects.toThrow(/no tool_use/);
  });
});

describe('OpenAiAdapter', () => {
  it('uses strict json_schema and parses the JSON content', async () => {
    const { fn, calls } = fakeFetch(200, { choices: [{ message: { content: '{"ok":2}' } }] });
    const out = await new OpenAiAdapter(async () => 'KEY', fn).completeJson('gpt-5.4-mini', req);
    expect(out).toEqual({ ok: 2 });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(c.headers.authorization).toBe('Bearer KEY');
    expect(c.body).toMatchObject({
      model: 'gpt-5.4-mini',
      max_completion_tokens: 100,
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'נגמר חלב' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'resolution', strict: true, schema: { type: 'object' } } },
    });
  });

  it('reports refusals and API errors', async () => {
    const refused = fakeFetch(200, { choices: [{ message: { content: null, refusal: 'no' } }] });
    await expect(new OpenAiAdapter(async () => 'K', refused.fn).completeJson('m', req)).rejects.toThrow('OpenAI refused: no');
    const bad = fakeFetch(429, { error: { message: 'rate limited' } });
    await expect(new OpenAiAdapter(async () => 'K', bad.fn).completeJson('m', req)).rejects.toThrow('OpenAI 429: rate limited');
  });
});

describe('routing', () => {
  const adapter = (provider: 'anthropic' | 'openai'): ProviderAdapter & { models: string[] } => {
    const models: string[] = [];
    return { provider, models, completeJson: async (model) => (models.push(model), { from: provider }) };
  };

  it('defaults resolve-item to Anthropic', () => {
    expect(parseRouting(undefined)).toEqual(DEFAULT_ROUTING);
    expect(DEFAULT_ROUTING['resolve-item'].provider).toBe('anthropic');
  });

  it('switching provider is configuration only', async () => {
    const a = adapter('anthropic');
    const o = adapter('openai');
    const routing = parseRouting('{"resolve-item":{"provider":"openai","model":"gpt-5.4-mini"}}');
    const client = new RoutedLlmClient(routing, [a, o]);
    const res = await client.complete(req, (j) => j);
    expect(res).toEqual({ value: { from: 'openai' }, provider: 'openai', model: 'gpt-5.4-mini' });
    expect(a.models).toEqual([]);
  });

  it('rejects bad routing config at startup', () => {
    expect(() => parseRouting('{"nope":{"provider":"openai","model":"x"}}')).toThrow(/unknown task/);
    expect(() => parseRouting('{"resolve-item":{"provider":"gemini","model":"x"}}')).toThrow(/unknown provider/);
    expect(() => parseRouting('{"resolve-item":{"provider":"openai"}}')).toThrow(/needs a model/);
  });

  it('fails clearly if the routed provider has no adapter', async () => {
    const client = new RoutedLlmClient(DEFAULT_ROUTING, [adapter('openai')]);
    await expect(client.complete(req, (j) => j)).rejects.toThrow(/No adapter registered for provider "anthropic"/);
  });
});
