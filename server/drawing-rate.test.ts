import { expect, test } from 'bun:test';
import { answerGuard } from './answers';
import { BoardState } from './board-state';
import type { BoardOp } from '../shared/board';
const flow: Extract<BoardOp, { op: 'add_diagram' }> = { op: 'add_diagram', id: 'repair-flow', title: 'Repair booking', kind: 'flow', nodes: [
  { id: 'photo', label: 'Photo', color: 'blue', shape: 'box', parent: null },
  { id: 'quote', label: 'Plumber quote', color: 'green', shape: 'box', parent: null },
], links: [], axes: [], placement: { kind: 'auto' } };
test('ordinary diagrams survive question-like speech without an owned answer', () => {
  const guard = answerGuard({ mode: 'live', utterance: 'what if we let people book a plumber', history: [], board: new BoardState().summary() });
  expect(guard.operation(flow)).toBeDefined();
});
test('unanswered refine preserves existing content until a replacement arrives', () => {
  const board = new BoardState();
  board.apply({ ...flow, id: 'generic', title: 'Unique angles', nodes: flow.nodes.map(node => ({ ...node, id: `generic-${node.id}`, label: 'Underserved audience' })) });
  board.apply({ ...flow, id: 'specific', title: 'Repair app angles' });
  const guard = answerGuard({ mode: 'refine', utterance: 'Brainstorm angles for a repair app.', history: [], board: board.summary() });
  expect(guard.cleanup()).toEqual([]);
});

test('an ordinary options diagram retains its ID with explicit question ownership metadata', () => {
  const guard = answerGuard({ mode: 'live', utterance: 'describe the shipping options', history: [{ role: 'user', text: 'Question ownership: {"answer":[],"existing":[]}' }], board: new BoardState().summary() });
  expect(guard.operation({ ...flow, title: 'Shipping options' })).toMatchObject({ id: 'repair-flow' });
  expect(guard.operation({ ...flow, id: 'answer-unowned', title: 'Offline storage' })).toBeUndefined();
});

test('ordinary options diagrams are not adopted as the owned question answer', () => {
  const board = new BoardState(); board.apply({ ...flow, id: 'shipping-options', title: 'Shop shipping options' });
  const guard = answerGuard({ mode: 'live', utterance: 'Which shipping integration for our shop?', history: [{ role: 'user', text: 'Question ownership: {"answer":[{"id":"answer-test-1","text":"Which shipping integration for our shop?","status":"answering"}],"existing":[]}' }], board: board.summary() });
  expect(guard.operation({ ...flow, id: 'answer-test-1', title: 'Shop shipping integration' })).toMatchObject({ id: 'answer-test-1' });
});
test('a parallel request cannot update a reserved answer outside its ownership slots', () => {
  const guard = answerGuard({ mode: 'live', utterance: 'show the repair flow', history: [{ role: 'user', text: 'Question ownership: {"answer":[],"existing":[]}' }], board: new BoardState().summary() });
  expect(guard.operation({ op: 'update', id: 'answer-other-1', label: 'Wrong answer' })).toBeUndefined();
});
