import { expect, test } from 'bun:test';
import { config } from './config';
import { handleRequest } from './index';
import { selectProvider } from './llm';
import { parseAgentStream } from '../src/agent/client';

for (const optIn of [undefined, '0', '1']) {
  test(`production dev fallback requires explicit opt-in (${optIn ?? 'unset'})`, async () => {
    const previous = { ...process.env };
    const originalFetch = globalThis.fetch;
    let tokenCalls = 0;
    try {
      process.env.NODE_ENV = 'production';
      process.env.DEV_LLM_BASE_URL = 'http://dev.invalid/v1';
      process.env.GRADIUM_API_KEY = 'test-only';
      if (optIn === undefined) delete process.env.ALLOW_DEV_LLM_IN_PRODUCTION;
      else process.env.ALLOW_DEV_LLM_IN_PRODUCTION = optIn;
      globalThis.fetch = Object.assign(async () => { tokenCalls++; return Response.json({ token: 'fixture', expires_at: 'tomorrow' }); }, { preconnect: originalFetch.preconnect });
      const enabled = optIn === '1';
      const status = await handleRequest(new Request('http://test/api/status'));
      expect(await status.json()).toMatchObject({ devLlm: enabled });
      const token = await handleRequest(new Request('http://test/api/gradium/token'));
      expect(token.status).toBe(enabled ? 200 : 401); expect(tokenCalls).toBe(enabled ? 1 : 0);
      if (enabled) expect((await selectProvider(new Request('http://test'))).modelId).toBe(config().DEV_LLM_MODEL);
      else {
        const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body: JSON.stringify({ mode: 'turn', utterance: 'Draw', history: [], board: { title: '', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } }) }));
        if (!response.body) throw new Error('No response body');
        const events = [];
        for await (const event of parseAgentStream(response.body)) events.push(event);
        expect(events).toContainEqual({ type: 'error', message: 'Sign in with ChatGPT to start' });
        expect(config().DEV_LLM_BASE_URL).toBeUndefined();
        process.env.DEV_LLM_BASE_URL = 'invalid ignored URL';
        expect(config().DEV_LLM_BASE_URL).toBeUndefined();
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });
}
