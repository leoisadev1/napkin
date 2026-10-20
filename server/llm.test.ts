import { expect, test } from 'bun:test';
import { z } from 'zod';
import { runAgent } from './agent';

test('live mode normalizes unsupported efforts on the wire without parallel speech/tools', async () => {
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
      await runAgent({ request: new Request('http://test/api/agent'), input: { mode: 'live', utterance: 'An item', history: [], board: { title: '', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } }, signal: AbortSignal.timeout(5000), emit: event => { expect(event.type).not.toBe('say'); } });
    }
    expect(efforts).toEqual(['low', 'low', 'low']);
  } finally {
    proxy.stop(true); for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
  }
});

