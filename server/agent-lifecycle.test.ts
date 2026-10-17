import { expect, test } from 'bun:test';
import { handleRequest } from './index';
import { parseAgentStream } from '../src/agent/client';

test('failed DSL stream cancels queued image work with no parallel voice call', async () => {
  const previous = process.env.DEV_LLM_BASE_URL;
  let calls = 0; let imageStarted = false; let imageAborted = false;
  const encoder = new TextEncoder();
  const proxy = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/images/generations')) {
      imageStarted = true;
      return await new Promise<Response>(resolve => {
        const timer = setTimeout(() => resolve(Response.json({ data: [{ b64_json: 'test' }] })), 5000);
        request.signal.addEventListener('abort', () => { imageAborted = true; clearTimeout(timer); resolve(new Response(null, { status: 499 })); }, { once: true });
      });
    }
    calls++;
    return new Response(new ReadableStream({ async start(controller) {
      const delta = { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'image leaf "A leaf" "Leaf"\n' }, finish_reason: null }] };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta)}\n\n`));
      for (let i = 0; i < 100 && !imageStarted; i++) await Bun.sleep(5);
      controller.enqueue(encoder.encode('data: {"error":{"message":"synthetic failure","type":"server_error"}}\n\n')); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  process.env.DEV_LLM_BASE_URL = `http://127.0.0.1:${proxy.port}/v1`;
  try {
    const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body: JSON.stringify({ mode: 'turn', utterance: 'Draw a leaf image', history: [], board: { title: '', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } }) }));
    if (!response.body) throw new Error('No response body');
    const events = [];
    for await (const event of parseAgentStream(response.body)) events.push(event);
    for (let i = 0; i < 30 && !imageAborted; i++) await Bun.sleep(10);
    expect(calls).toBe(1); expect(imageStarted).toBe(true); expect(imageAborted).toBe(true);
    expect(events).toContainEqual({ type: 'pending', id: 'leaf', label: 'Generating image…' });
    expect(events.some(event => event.type === 'op' && event.op.op === 'add_image')).toBe(false);
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  } finally { if (previous === undefined) delete process.env.DEV_LLM_BASE_URL; else process.env.DEV_LLM_BASE_URL = previous; proxy.stop(true); }
}, 10000);

test('image frames and their dependent children/edges emit in dependency order while unrelated drawing streams', async () => {
  const previous = process.env.DEV_LLM_BASE_URL;
  const proxy = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/images/generations')) {
      await Bun.sleep(100); return Response.json({ data: [{ b64_json: 'test' }] });
    }
    const content = 'frame gallery "Gallery"\nimage art "A flower" "Flower" in:gallery\nbox caption blue in:gallery "Notes"\nedge link art->caption "describes"\nbox unrelated green "Independent"\n';
    const chunk = { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  process.env.DEV_LLM_BASE_URL = `http://127.0.0.1:${proxy.port}/v1`;
  try {
    const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body: JSON.stringify({ mode: 'turn', utterance: 'Draw a gallery', history: [], board: { title: '', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } }) }));
    if (!response.body) throw new Error('No response body');
    const operations: string[] = [];
    for await (const event of parseAgentStream(response.body)) {
      expect(event.type).not.toBe('error');
      if (event.type === 'op' && 'id' in event.op) operations.push(event.op.id);
    }
    expect(operations).toEqual(['unrelated', 'gallery', 'art', 'caption', 'link']);
  } finally { if (previous === undefined) delete process.env.DEV_LLM_BASE_URL; else process.env.DEV_LLM_BASE_URL = previous; proxy.stop(true); }
}, 10000);

for (const scenario of ['delete-frame', 'failed-clear']) {
  test(`async image ordering preserves ${scenario}`, async () => {
    const previous = process.env.DEV_LLM_BASE_URL;
    const proxy = Bun.serve({ port: 0, async fetch(request) {
      if (new URL(request.url).pathname.endsWith('/images/generations')) {
        await Bun.sleep(100);
        return scenario === 'failed-clear' ? new Response(null, { status: 500 }) : Response.json({ data: [{ b64_json: 'test' }] });
      }
      const content = scenario === 'delete-frame' ? 'image art "A flower" "Flower" in:gallery\ndel gallery\n' : 'image art "A flower" "Flower"\nclear\nbox fresh blue "Fresh"\n';
      const chunk = { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
    process.env.DEV_LLM_BASE_URL = `http://127.0.0.1:${proxy.port}/v1`;
    try {
      const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body: JSON.stringify({ mode: 'turn', utterance: 'Change gallery', history: [], board: { title: '', items: [{ origin: 'agent', bounds: { x: 0, y: 0, w: 200, h: 100 }, id: 'gallery', kind: 'frame', label: 'Gallery', frame: null, link: '' }], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } }) }));
      if (!response.body) throw new Error('No response body');
      const operations: string[] = []; const events: string[] = [];
      for await (const event of parseAgentStream(response.body)) {
        events.push(event.type);
        if (event.type === 'op') operations.push(event.op.op);
      }
      expect(operations).toEqual(scenario === 'delete-frame' ? ['add_image', 'delete'] : ['clear', 'add_shape']);
      if (scenario === 'failed-clear') expect(events.slice(-3)).toEqual(['op', 'error', 'done']);
    } finally { if (previous === undefined) delete process.env.DEV_LLM_BASE_URL; else process.env.DEV_LLM_BASE_URL = previous; proxy.stop(true); }
  }, 10000);
}

test('existing images prevent automatic repeats while explicit voice requests allow one new image', async () => {
  const previous = process.env.DEV_LLM_BASE_URL; let images = 0;
  const proxy = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname.endsWith('/images/generations')) { images++; return Response.json({ data: [{ b64_json: 'test' }] }); }
    const chunk = { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'image art "Cat" "Cat"\nimage art-two "Cat" "Cat"\n' }, finish_reason: null }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  process.env.DEV_LLM_BASE_URL = `http://127.0.0.1:${proxy.port}/v1`;
  try {
    for (const mode of ['live', 'turn', 'refine']) {
      const before = images;
      const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body: JSON.stringify({ mode, utterance: 'Improve Cat Simulator progression', history: [], board: { title: 'Cat Simulator', items: [{ origin: 'agent', bounds: { x: 0, y: 0, w: 200, h: 100 }, id: 'concept', kind: 'image', label: 'Concept', frame: null, link: '' }], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } }) }));
      if (!response.body) throw new Error('No response body'); for await (const _event of parseAgentStream(response.body)) { /* drain */ }
      expect(images).toBe(before);
    }
    const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body: JSON.stringify({ mode: 'live', utterance: 'Please add another image of a cat', history: [], board: { title: 'Cat Simulator', items: [{ origin: 'agent', bounds: { x: 0, y: 0, w: 200, h: 100 }, id: 'concept', kind: 'image', label: 'Concept', frame: null, link: '' }], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } }) }));
    if (!response.body) throw new Error('No response body'); for await (const _event of parseAgentStream(response.body)) { /* drain */ }
    expect(images).toBe(1);
  } finally { if (previous === undefined) delete process.env.DEV_LLM_BASE_URL; else process.env.DEV_LLM_BASE_URL = previous; proxy.stop(true); }
});

test('each completed DSL line reaches the HTTP client before the provider finishes', async () => {
  const previous = process.env.DEV_LLM_BASE_URL;
  let complete: (() => void) | undefined;
  const proxy = Bun.serve({ port: 0, fetch() {
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      const delta = { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'box first blue here "First"\n' }, finish_reason: null }] };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta)}\n\n`));
      await new Promise<void>(resolve => { complete = resolve; });
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  process.env.DEV_LLM_BASE_URL = `http://127.0.0.1:${proxy.port}/v1`;
  try {
    const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body: JSON.stringify({ mode: 'live', utterance: 'Draw a box here', history: [], board: { title: '', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } }) }));
    if (!response.body) throw new Error('No stream');
    const reader = response.body.getReader();
    const result = await Promise.race([reader.read(), Bun.sleep(2000).then(() => { throw new Error('Buffered first op'); })]);
    expect(new TextDecoder().decode(result.value)).toContain('"op":"add_shape"');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    complete?.(); await reader.cancel();
  } finally { complete?.(); if (previous === undefined) delete process.env.DEV_LLM_BASE_URL; else process.env.DEV_LLM_BASE_URL = previous; proxy.stop(true); }
}, 5000);
