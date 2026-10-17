import { expect } from 'bun:test';
import { AgentRequest } from '../../shared/agent-protocol';
import type { BoardOp } from '../../shared/board';
import { ConversationEngine } from '../../src/conversation/engine/conversation-engine';
import { BoardState } from '../board-state';
const requests: { input: AgentRequest; signal: AbortSignal | null | undefined; stream: ReadableStreamDefaultController<Uint8Array> }[] = [];
const original = globalThis.fetch;
globalThis.fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(stream) { requests.push({ input: AgentRequest.parse(JSON.parse(String(init?.body))), signal: init?.signal, stream }); } })), { preconnect: original.preconnect });
const board = new BoardState(); const applied: BoardOp[] = [];
const engine = new ConversationEngine({ getSummary: board.summary, apply: op => { applied.push(op); board.apply(op); }, showPending() {}, clearPending() {} });
const emit = (i: number, event: object) => requests[i]?.stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
const op = (i: number, title: string) => emit(i, { type: 'op', op: { op: 'set_title', title } });
const done = async (i: number) => { emit(i, { type: 'done' }); requests[i]?.stream.close(); await Bun.sleep(10); };
try {
  engine.receivePhrase('Draw a payment service'); engine.receivePhrase('Add checkout beside payment');
  expect(engine.getSnapshot().pendingPhrases.map(row => row.status)).toEqual(['drawing', 'queued']);
  expect(requests).toHaveLength(1);
  op(0, 'First'); await Bun.sleep(10);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.input.history.some(turn => turn.text.includes('Being drawn by a parallel request') && turn.text.includes('payment service'))).toBe(true);
  expect(engine.getSnapshot().pendingPhrases.map(row => row.status)).toEqual(['drawing']);
  engine.receivePhrase('Add a login screen');
  op(1, 'Second'); await done(1);
  expect(applied).toEqual([{ op: 'set_title', title: 'First' }]);
  expect(engine.getSnapshot().pendingPhrases.map(row => row.text)).toEqual(['Add a login screen']);
  expect(requests).toHaveLength(2);
  // Later ops of phrase one still precede phrase two, even if phrase two completed first.
  op(0, 'First last'); await done(0);
  expect(applied).toEqual([{ op: 'set_title', title: 'First' }, { op: 'set_title', title: 'First last' }, { op: 'set_title', title: 'Second' }]);
  expect(requests).toHaveLength(3);
  expect(engine.getSnapshot().pendingPhrases.map(row => row.text)).toEqual(['Add a login screen']);
  await done(2); expect(engine.getSnapshot().pendingPhrases).toEqual([]); expect(engine.getSnapshot().sketching).toBe(false);
  // Deadline unlocks a second request even when the first hasn't produced anything.
  engine.receivePhrase('Draw one'); engine.receivePhrase('Draw two'); engine.receivePhrase('Draw three');
  await Bun.sleep(620); expect(requests).toHaveLength(5);
  expect(engine.getSnapshot().pendingPhrases.map(row => row.status)).toEqual(['drawing', 'drawing', 'drawing']);
  op(4, 'Buffered'); await Bun.sleep(10); expect(board.summary().title).toBe('Second');
  engine.interrupt(); expect(requests[3]?.signal?.aborted).toBe(true); expect(requests[4]?.signal?.aborted).toBe(true);
  expect(engine.getSnapshot().pendingPhrases).toEqual([]); expect(board.summary().title).toBe('Second');
  // A near-limit phrase still fits when the parallel-context instruction is prepended.
  const base = requests.length;
  engine.receivePhrase('x'.repeat(3949)); engine.receivePhrase('Add checkout');
  op(base, 'Long phrase'); await Bun.sleep(10);
  expect(requests).toHaveLength(base + 2);
  expect(requests[base + 1]?.input.history.every(turn => turn.text.length <= 4000)).toBe(true);
} finally { engine.interrupt(); globalThis.fetch = original; }
