import { expect } from 'bun:test';
import { AgentRequest } from '../../shared/agent-protocol';
import { ConversationEngine } from '../../src/conversation/engine/conversation-engine';
import { BoardState } from '../board-state';
const requests: { input: AgentRequest; stream: ReadableStreamDefaultController<Uint8Array> }[] = [];
const original = globalThis.fetch;
globalThis.fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(stream) { requests.push({ input: AgentRequest.parse(JSON.parse(String(init?.body))), stream }); } })), { preconnect: original.preconnect });
const board = new BoardState();
const engine = new ConversationEngine({ getSummary: board.summary, apply: board.apply, showPending() {}, clearPending() {} });
const done = async (i: number) => { requests[i]?.stream.enqueue(new TextEncoder().encode('{"type":"done"}\n')); requests[i]?.stream.close(); await Bun.sleep(10); };
try {
  engine.receivePhrase("I'm thinking about a habit tracking app");
  engine.receivePhrase('uh do you have any unique angles');
  await Bun.sleep(620);
  expect(requests).toHaveLength(2);
  const policy = (i: number) => requests[i]?.input.history.find(turn => turn.text.startsWith('Question ownership: '))?.text ?? '';
  expect(policy(0)).toContain('"answer":[]'); expect(policy(1)).toContain('"answer":[{');
  engine.receivePhrase('that we could possibly take?');
  await done(0); await done(1);
  expect(requests).toHaveLength(3);
  expect(policy(2)).toContain('"answer":[]');
  expect(policy(2)).toContain('habit tracking app');
  engine.receivePhrase('and keep it simple'); await Bun.sleep(620);
  expect(requests).toHaveLength(4);
  expect(policy(3)).toContain('"answer":[]');
  expect(policy(3)).toContain('"status":"answering"');
  expect(requests.filter((_, i) => policy(i).includes('"answer":[{'))).toHaveLength(1);
  await done(2); await done(3);
} finally { engine.interrupt(); globalThis.fetch = original; }
