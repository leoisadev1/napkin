import { expect } from 'bun:test';
import { ConversationEngine } from '../../src/conversation/engine/conversation-engine';
import { AgentRequest } from '../../shared/agent-protocol';
const original = globalThis.fetch; const originalTimer = globalThis.setTimeout;
globalThis.setTimeout = Object.assign((callback: TimerHandler, ms?: number, ...args: unknown[]) => originalTimer(callback, ms === 60_000 ? 30 : ms, ...args), originalTimer);
let requests = 0; let canceled = false;
globalThis.fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
  AgentRequest.parse(JSON.parse(String(init?.body))); requests++;
  return requests === 1 ? new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } })) : new Response('{"type":"done"}\n');
}, { preconnect: original.preconnect });
const engine = new ConversationEngine({ getSummary: () => ({ title: '', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1000, h: 800 } }), apply() {}, showPending() {}, clearPending() {} });
try {
  engine.sendText('Draw customers'); engine.sendText('Draw orders');
  for (let i = 0; i < 100 && engine.getSnapshot().pendingPhrases.length; i++) await Bun.sleep(5);
  expect(canceled).toBe(true); expect(requests).toBe(2);
  expect(engine.getSnapshot().pendingPhrases).toEqual([]); expect(engine.getSnapshot().sketching).toBe(false); expect(engine.getSnapshot().phase.kind).toBe('idle');
  expect(engine.getSnapshot().transcript.filter(entry => entry.role === 'user')).toHaveLength(2);
} finally { engine.stopVoice(); globalThis.fetch = original; globalThis.setTimeout = originalTimer; }
