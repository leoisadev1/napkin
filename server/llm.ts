import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel, streamText } from 'ai';
import { z } from 'zod';
import { config } from './config';
import type { AgentRequest } from '../shared/agent-protocol';

export function supportedEffort(model: string, requested: 'none' | 'minimal' | 'low' | 'medium') {
  return /^gpt-(?:6|5\.6)/.test(model) && (requested === 'none' || requested === 'minimal') ? 'low' : requested;
}
/** One model call's settings. `image` is absent when the provider has no image generation. */
export type Provider = { model: LanguageModel; modelId: string; providerOptions: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>; image?: (prompt: string, signal: AbortSignal) => Promise<string> };
export async function selectProvider(_request: Request, effort?: 'none' | 'low' | 'medium', mode: AgentRequest['mode'] = 'turn'): Promise<Provider> {
  const env = config();
  const requestedEffort = effort ?? (mode === 'refine' ? env.DEV_LLM_REFINE_REASONING_EFFORT : env.DEV_LLM_REASONING_EFFORT);
  // A configured OpenAI-compatible endpoint wins locally (tests, the proxy); production strips it, leaving the shared Claude key.
  if (!env.DEV_LLM_BASE_URL) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('No model is configured on this server');
    // Pinned: the SDK otherwise honours ANTHROPIC_BASE_URL, which a developer shell may point at a local proxy.
    const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: 'https://api.anthropic.com/v1' });
    // Live phrases and suggestions need the first box on screen fast, so they skip thinking; tidy-ups get a little.
    const thinking = mode === 'live' || mode === 'suggest' ? { type: 'disabled' as const } : { type: 'adaptive' as const };
    return { model: anthropic(env.ANTHROPIC_MODEL), modelId: env.ANTHROPIC_MODEL, providerOptions: { anthropic: { thinking, effort: 'low' } } };
  }
  const selected = (mode === 'refine' ? env.DEV_LLM_REFINE_MODEL : mode === 'suggest' ? env.DEV_LLM_SUGGEST_MODEL : env.DEV_LLM_LIVE_MODEL) ?? env.DEV_LLM_MODEL;
  const reasoningEffort = supportedEffort(selected, requestedEffort);
  const provider = createOpenAI({ baseURL: env.DEV_LLM_BASE_URL, apiKey: env.DEV_LLM_API_KEY,
    // Proxy aliases evolve faster than the SDK's model capability table. Send the requested
    // effort at the HTTP boundary so benchmarks measure it instead of an SDK fallback.
    fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (typeof init?.body !== 'string') return fetch(url, init);
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(init.body));
      return fetch(url, { ...init, body: JSON.stringify({ ...body, reasoning_effort: reasoningEffort }) });
    }, { preconnect: fetch.preconnect }),
  });
  return { model: provider.chat(selected), modelId: selected, providerOptions: { openai: { reasoningEffort } }, image: async (prompt: string, signal: AbortSignal) => {
    const response = await fetch(`${env.DEV_LLM_BASE_URL?.replace(/\/$/, '')}/images/generations`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DEV_LLM_API_KEY}` },
      body: JSON.stringify({ model: env.DEV_IMAGE_MODEL, prompt, size: '1024x1024', quality: 'low', response_format: 'b64_json', n: 1 }),
    });
    if (!response.ok) throw new Error('Image generation failed');
    const result = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) }).parse(await response.json());
    return `data:image/png;base64,${result.data[0]?.b64_json}`;
  } };
}
