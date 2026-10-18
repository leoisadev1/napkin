import { expect } from 'bun:test';
import { agentEvents } from '../../src/agent/client';
import type { AgentRequest } from '../../shared/agent-protocol';
const original = globalThis.fetch; let canceled = false;
globalThis.fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } })), { preconnect: original.preconnect });
const input: AgentRequest = { mode: 'live', utterance: 'draw payments', history: [], board: { title: '', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } };
try {
  let error: unknown;
  const start = performance.now();
  const guard = setTimeout(() => { process.stderr.write('Stalled request never timed out'); process.exit(1); }, 1000);
  try { for await (const event of agentEvents(input, new AbortController().signal, { timeoutMs: 20 })) void event; }
  catch (caught) { error = caught; } finally { clearTimeout(guard); }
  expect(error).toBeInstanceOf(Error); expect(canceled).toBe(true); expect(performance.now() - start).toBeLessThan(500);
  // A later request can complete normally.
  globalThis.fetch = Object.assign(async () => new Response('{"type":"done"}\n'), { preconnect: original.preconnect });
  const events = []; for await (const event of agentEvents(input, new AbortController().signal, { timeoutMs: 100 })) events.push(event);
  expect(events).toEqual([{ type: 'done' }]);
} finally { globalThis.fetch = original; }
