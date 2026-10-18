import { createOpenAI } from '@ai-sdk/openai';
import { createChatGPTProxyProvider } from '@opencoredev/loginwithchatgpt-ai';
import { z } from 'zod';
import { auth } from './auth';
import { config } from './config';
import type { AgentRequest } from '../shared/agent-protocol';
import { imageClient } from './chatgpt-images';

export function chooseModel(models: string[], mode: AgentRequest['mode'] = 'refine') {
  if (mode === 'live' || mode === 'suggest') {
    const fast = ['gpt-5.3-codex-spark', 'gpt-5.4-mini'].find(id => models.includes(id));
    if (fast) return fast;
  }
  return models.find(model => model === 'gpt-6.1-sol') ?? ['spark', 'nano', 'mini', 'luna'].map(name => models.find(model => model.toLowerCase().includes(name))).find(Boolean) ?? models[0];
}
export function supportedEffort(model: string, requested: 'none' | 'minimal' | 'low' | 'medium') {
  return /^gpt-(?:6|5\.6)/.test(model) && (requested === 'none' || requested === 'minimal') ? 'low' : requested;
}
export async function selectProvider(request: Request, effort?: 'none' | 'low' | 'medium', mode: AgentRequest['mode'] = 'turn') {
  const env = config();
  const requestedEffort = effort ?? (mode === 'refine' ? env.DEV_LLM_REFINE_REASONING_EFFORT : env.DEV_LLM_REASONING_EFFORT);
  const session = await auth.getSession(request);
  if (session.status === 'authenticated') {
    const models = await auth.getModels(request) ?? [];
    const override = mode === 'refine' ? env.CHATGPT_REFINE_MODEL : mode === 'suggest' ? env.CHATGPT_SUGGEST_MODEL : env.CHATGPT_LIVE_MODEL;
    if (override && !models.includes(override)) throw new Error('Configured model unavailable for this ChatGPT account');
    const selected = override ?? chooseModel(models, mode);
    if (!selected) throw new Error('No models available for this ChatGPT account');
    const proxyFetch = auth.proxyFetch(request);
    const provider = Object.assign(createChatGPTProxyProvider({ fetch: proxyFetch, headers: {
      'x-login-with-chatgpt-reasoning-effort': supportedEffort(selected, requestedEffort), 'x-login-with-chatgpt-service-tier': 'default',
    } }), { images: imageClient(proxyFetch) });
    return { model: provider(selected), modelId: selected, reasoningEffort: supportedEffort(selected, requestedEffort), image: async (prompt: string, signal: AbortSignal) => {
      const result = await provider.images.generate({ prompt, model: models.find(m => !/mini|spark|luna|nano/i.test(m)) ?? selected, quality: 'low', size: '1024x1024', format: 'png', signal });
      const first = result.data[0];
      if (!first) throw new Error('No image returned');
      return first.dataUrl;
    } };
  }
  const selected = (mode === 'refine' ? env.DEV_LLM_REFINE_MODEL : mode === 'suggest' ? env.DEV_LLM_SUGGEST_MODEL : env.DEV_LLM_LIVE_MODEL) ?? env.DEV_LLM_MODEL;
  const reasoningEffort = supportedEffort(selected, requestedEffort);
  if (!env.DEV_LLM_BASE_URL) throw new Error('Sign in with ChatGPT to start');
  const provider = createOpenAI({ baseURL: env.DEV_LLM_BASE_URL, apiKey: env.DEV_LLM_API_KEY,
    // Proxy aliases evolve faster than the SDK's model capability table. Send the requested
    // effort at the HTTP boundary so benchmarks measure it instead of an SDK fallback.
    fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (typeof init?.body !== 'string') return fetch(url, init);
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(init.body));
      return fetch(url, { ...init, body: JSON.stringify({ ...body, reasoning_effort: reasoningEffort }) });
    }, { preconnect: fetch.preconnect }),
  });
  return { model: provider.chat(selected), modelId: selected, reasoningEffort, image: async (prompt: string, signal: AbortSignal) => {
    const response = await fetch(`${env.DEV_LLM_BASE_URL?.replace(/\/$/, '')}/images/generations`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DEV_LLM_API_KEY}` },
      body: JSON.stringify({ model: env.DEV_IMAGE_MODEL, prompt, size: '1024x1024', quality: 'low', response_format: 'b64_json', n: 1 }),
    });
    if (!response.ok) throw new Error('Image generation failed');
    const result = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) }).parse(await response.json());
    return `data:image/png;base64,${result.data[0]?.b64_json}`;
  } };
}
