import { expect } from 'bun:test';
import { AgentRequest } from '../../shared/agent-protocol';
import { ConversationEngine } from '../../src/conversation/engine/conversation-engine';
import { BoardState } from '../board-state';
const requests: ReadableStreamDefaultController<Uint8Array>[] = [];
const original = globalThis.fetch;
globalThis.fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
  AgentRequest.parse(JSON.parse(String(init?.body)));
  return new Response(new ReadableStream<Uint8Array>({ start(stream) { requests.push(stream); } }));
}, { preconnect: original.preconnect });
const board = new BoardState();
const engine = new ConversationEngine({ getSummary: board.summary, apply: board.apply, showPending() {}, clearPending() {} });
const emit = async (index: number, op: object) => { requests[index]?.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'op', op })}\n`)); await Bun.sleep(5); };
try {
  engine.receivePhrase('A repair booking app'); engine.receivePhrase('Photo of a broken sink');
  await Bun.sleep(620); expect(requests).toHaveLength(2);
  await emit(1, { op: 'add_shape', id: 'photo', shape: 'box', label: 'Broken sink photo', color: 'blue', placement: { kind: 'auto' } });
  expect(board.summary().items.some(item => item.id === 'photo')).toBe(true);
  // Newer speech corrects a label. An old stream must not overwrite it.
  await emit(0, { op: 'add_shape', id: 'photo', shape: 'box', label: 'Wrong old label', color: 'blue', placement: { kind: 'auto' } });
  expect(board.summary().items.find(item => item.id === 'photo')?.label).toBe('Broken sink photo');
  // A reference to an item that has not arrived stays queued.
  await emit(1, { op: 'add_edge', id: 'next', from: 'photo', to: 'plumber', label: 'Match' });
  expect(board.summary().items.some(item => item.id === 'next')).toBe(false);
  await emit(0, { op: 'add_shape', id: 'plumber', shape: 'box', label: 'Local plumber', color: 'green', placement: { kind: 'auto' } });
  expect(board.summary().items.some(item => item.id === 'next')).toBe(true);

  engine.interrupt(); board.apply({ op: 'clear' });
  const shape = (id: string, label: string) => ({ op: 'add_shape', id, shape: 'box', label, color: 'blue', placement: { kind: 'auto' } } satisfies import('../../shared/board').BoardOp);
  board.apply(shape('old', 'Old item'));
  let base = requests.length;
  engine.receivePhrase('Clear the previous board'); engine.receivePhrase('Add a fresh item'); await Bun.sleep(620);
  await emit(base + 1, shape('fresh', 'Fresh item'));
  await emit(base, { op: 'clear' });
  expect(board.summary().items.map(item => item.id)).toEqual(['fresh']);

  engine.interrupt(); board.apply({ op: 'clear' }); board.apply(shape('a', 'Old A')); board.apply(shape('b', 'Old B'));
  base = requests.length;
  engine.receivePhrase('Delete the two old items'); engine.receivePhrase('Keep A and change its label'); await Bun.sleep(620);
  await emit(base + 1, { op: 'update', id: 'a', label: 'New A' });
  await emit(base, { op: 'delete', ids: ['a', 'b'] });
  expect(board.summary().items.map(item => item.label)).toEqual(['New A']);

  engine.interrupt(); board.apply({ op: 'clear' });
  const diagram = { op: 'add_diagram', id: 'flow', kind: 'flow', title: 'Existing flow', placement: { kind: 'auto' }, nodes: ['a', 'b', 'c'].map(id => ({ id, label: id.toUpperCase(), color: 'blue', shape: 'box', parent: null })), links: [], axes: [] } satisfies import('../../shared/board').BoardOp;
  board.apply(diagram); base = requests.length;
  engine.receivePhrase('Simplify the old flow'); engine.receivePhrase('Keep C and label it Corrected'); await Bun.sleep(620);
  await emit(base + 1, { op: 'update', id: 'c', label: 'Corrected' });
  await emit(base, { ...diagram, nodes: diagram.nodes.slice(0, 2) });
  expect(board.summary().items.find(item => item.id === 'c')?.label).toBe('Corrected');

  engine.interrupt(); board.apply({ op: 'clear' });
  board.apply({ op: 'add_frame', id: 'outer', title: 'Outer', placement: { kind: 'auto' } });
  board.apply({ ...diagram, placement: { kind: 'inside', frame: 'outer' } });
  base = requests.length;
  engine.receivePhrase('Delete the old outer frame'); engine.receivePhrase('Keep C with the corrected label'); await Bun.sleep(620);
  await emit(base + 1, { op: 'update', id: 'c', label: 'Newest C' });
  await emit(base, { op: 'delete', ids: ['outer'] });
  expect(board.summary().items.find(item => item.id === 'c')?.label).toBe('Newest C');
} finally { engine.interrupt(); globalThis.fetch = original; }
