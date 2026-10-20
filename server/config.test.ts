import { expect, test } from 'bun:test';
import { config } from './config';
import { selectProvider } from './llm';

for (const optIn of [undefined, '0', '1']) {
  test(`production ignores the dev endpoint unless opted in, and otherwise uses the shared Claude key (${optIn ?? 'unset'})`, async () => {
    const previous = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.DEV_LLM_BASE_URL = 'http://dev.invalid/v1';
      process.env.ANTHROPIC_API_KEY = 'test-only';
      delete process.env.ANTHROPIC_MODEL;
      if (optIn === undefined) delete process.env.ALLOW_DEV_LLM_IN_PRODUCTION;
      else process.env.ALLOW_DEV_LLM_IN_PRODUCTION = optIn;
      const enabled = optIn === '1';
      expect((await selectProvider(new Request('http://test'))).modelId).toBe(enabled ? config().DEV_LLM_MODEL : 'claude-haiku-5-5');
      if (!enabled) {
        expect(config().DEV_LLM_BASE_URL).toBeUndefined();
        process.env.DEV_LLM_BASE_URL = 'invalid ignored URL';
        expect(config().DEV_LLM_BASE_URL).toBeUndefined();
      }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });
}
