import { createOpenAI } from '@ai-sdk/openai';
import { createChatGPTProxyProvider } from '@opencoredev/loginwithchatgpt-ai';
import { z } from 'zod';
import { auth } from './auth';
import { config } from './config';
import { imageClient } from './chatgpt-images';

export function chooseModel(models: string[]) {
  return models.find(model => /mini|spark|luna|nano/i.test(model)) ?? models[0];
}
export async function selectProvider(request: Request) {
  const session = await auth.getSession(request);
  if (session.status === 'authenticated') {
    const models = await auth.getModels(request) ?? [];
    const selected = chooseModel(models);
    if (!selected) throw new Error('No models available for this ChatGPT account');
    const proxyFetch = auth.proxyFetch(request);
    const provider = Object.assign(createChatGPTProxyProvider({ fetch: proxyFetch, headers: {
      'x-login-with-chatgpt-reasoning-effort': 'low', 'x-login-with-chatgpt-service-tier': 'default',
    } }), { images: imageClient(proxyFetch) });
    return { model: provider(selected), modelId: selected, image: async (prompt: string, signal: AbortSignal) => {
      const result = await provider.images.generate({ prompt, model: models.find(m => !/mini|spark|luna|nano/i.test(m)) ?? selected, quality: 'low', size: '1024x1024', format: 'png', signal });
      const first = result.data[0];
      if (!first) throw new Error('No image returned');
      return first.dataUrl;
    } };
  }
  const env = config();
  if (!env.DEV_LLM_BASE_URL) throw new Error('Sign in with ChatGPT to start');
  const provider = createOpenAI({ baseURL: env.DEV_LLM_BASE_URL, apiKey: env.DEV_LLM_API_KEY });
  return { model: provider.chat(env.DEV_LLM_MODEL), modelId: env.DEV_LLM_MODEL, image: async (prompt: string, signal: AbortSignal) => {
    const response = await fetch(`${env.DEV_LLM_BASE_URL?.replace(/\/$/, '')}/images/generations`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DEV_LLM_API_KEY}` },
      body: JSON.stringify({ model: env.DEV_IMAGE_MODEL, prompt, size: '1024x1024', quality: 'low', response_format: 'b64_json', n: 1 }),
    });
    if (!response.ok) throw new Error('Image generation failed');
    const result = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) }).parse(await response.json());
    return `data:image/png;base64,${result.data[0]?.b64_json}`;
  } };
}
