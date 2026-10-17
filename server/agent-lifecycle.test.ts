import { expect, test } from 'bun:test';
import { handleRequest } from './index';
import { z } from 'zod';
import { parseAgentStream } from '../src/agent/client';

test('failed LLM stream aborts queued image work before closing NDJSON', async () => {
  const previous = process.env.DEV_LLM_BASE_URL;
  let drawingCalls = 0; let voiceCalls = 0; let imageStarted = false; let imageAborted = false;
  let markImageStarted: (() => void) | undefined;
  const imageReady = new Promise<void>(resolve => { markImageStarted = resolve; });
  const encoder = new TextEncoder();
  const proxy = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/images/generations')) {
      imageStarted = true; markImageStarted?.();
      return await new Promise<Response>(resolve => {
        const timer = setTimeout(() => resolve(Response.json({ data: [{ b64_json: 'test' }] })), 5000);
        request.signal.addEventListener('abort', () => { imageAborted = true; clearTimeout(timer); resolve(new Response(null, { status: 499 })); }, { once: true });
      });
    }
    const body = z.object({ tools: z.array(z.unknown()).optional() }).parse(await request.json());
    if (!body.tools?.length) {
      voiceCalls++;
      // Fail the parallel voice request only once drawing has queued real image work.
      await imageReady;
      return Response.json({ error: { message: 'synthetic failure' } }, { status: 400 });
    }
    if (++drawingCalls > 1) return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const toolArguments = JSON.stringify({ id: 'leaf-image', prompt: 'leaf', caption: 'Leaf', placement: { kind: 'auto' } });
    const delta = { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'generate_image', arguments: toolArguments } }] }, finish_reason: null }] };
    const finish = { ...delta, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`)); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  process.env.DEV_LLM_BASE_URL = `http://127.0.0.1:${proxy.port}/v1`;
  try {
    const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body: JSON.stringify({ utterance: 'Draw a leaf image', history: [], board: { title: '', items: [], selection: [] } }) }));
    if (!response.body) throw new Error('No response body');
    const events = [];
    for await (const event of parseAgentStream(response.body)) events.push(event);
    for (let attempt = 0; attempt < 30 && !imageAborted; attempt++) await Bun.sleep(10);
    expect(voiceCalls).toBe(1); expect(drawingCalls).toBeGreaterThanOrEqual(1);
    expect(imageStarted).toBe(true); expect(imageAborted).toBe(true);
    expect(events).toContainEqual({ type: 'pending', id: 'leaf-image', label: 'Generating image…' });
    expect(events.some(event => event.type === 'op' && event.op.op === 'add_image')).toBe(false);
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  } finally { if (previous === undefined) delete process.env.DEV_LLM_BASE_URL; else process.env.DEV_LLM_BASE_URL = previous; proxy.stop(true); }
}, 10000);
