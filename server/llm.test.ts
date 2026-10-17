import { expect, test } from 'bun:test';
import { z } from 'zod';
import { chooseModel } from './llm';
import { runAgent } from './agent';

test('account model selection prefers GPT-6.1 Sol, then fast fallback variants', () => {
  expect(chooseModel(['gpt-6-sol', 'gpt-6-luna', 'gpt-spark'])).toBe('gpt-spark');
  expect(chooseModel(['gpt-6-sol', 'gpt-mini'])).toBe('gpt-mini');
  expect(chooseModel(['gpt-6-sol'])).toBe('gpt-6-sol');
  expect(chooseModel([])).toBeUndefined();
  expect(chooseModel(['gpt-mini', 'gpt-6.1-sol'])).toBe('gpt-6.1-sol');
});
test('live mode pins none on the wire despite dev defaults without parallel speech/tools', async () => {
  const previous = { ...process.env }; const efforts: string[] = [];
  const proxy = Bun.serve({ port: 0, async fetch(request) {
    const body = z.object({ reasoning_effort: z.string(), tools: z.unknown().optional() }).parse(await request.json());
    efforts.push(body.reasoning_effort); expect(body.tools).toBeUndefined();
    const chunk = { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'box item blue "Item"\n' }, finish_reason: null }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    process.env.DEV_LLM_BASE_URL = `http://127.0.0.1:${proxy.port}/v1`; process.env.DEV_LLM_MODEL = 'gpt-6.1-sol';
    for (const effort of ['none', 'minimal', 'low']) {
      process.env.DEV_LLM_REASONING_EFFORT = effort;
      await runAgent({ request: new Request('http://test/api/agent'), input: { mode: 'live', utterance: 'An item', history: [], board: { title: '', items: [], selection: [] } }, signal: AbortSignal.timeout(5000), emit: event => { expect(event.type).not.toBe('say'); } });
    }
    expect(efforts).toEqual(['none', 'none', 'none']);
  } finally {
    proxy.stop(true); for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
  }
});
