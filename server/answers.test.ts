import { expect, test } from 'bun:test';
import { answerGuard } from './answers';
import { BoardState } from './board-state';
import type { AgentRequest } from '../shared/agent-protocol';
import type { BoardOp } from '../shared/board';
const diagram = (id: string, title: string, label = 'Comeback-first tracking'): Extract<BoardOp, { op: 'add_diagram' }> => ({ op: 'add_diagram', id, title, kind: 'mindmap', nodes: [{ id: `${id}-a`, label, parent: null, color: 'blue', shape: 'box' }, { id: `${id}-b`, label: 'Energy-aware habits', parent: null, color: 'green', shape: 'box' }], links: [], axes: [], placement: { kind: 'auto' } });
const pick = (id: string): Extract<BoardOp, { op: 'add_shape' }> => ({ op: 'add_shape', id, shape: 'sticky', label: 'Pick: Comeback-first — help people recover', color: 'green', placement: { kind: 'auto' } });
const input = (board: BoardState, mode: AgentRequest['mode'], utterance = 'Habit tracking app: do you have any unique angles that we could possibly take?'): AgentRequest => ({ mode, utterance, history: [], board: board.summary() });
test('refine replaces the specific answer and removes generic duplicates and extra picks', () => {
  const board = new BoardState();
  board.apply(diagram('generic', 'Unique angles', 'Underserved audience'));
  board.apply(diagram('specific', 'Habit tracking app angles'));
  board.apply(pick('pick-one')); board.apply(pick('pick-two'));
  const guard = answerGuard(input(board, 'refine'));
  expect(guard.operation(diagram('new-answer', 'Habit tracking app angles'))).toMatchObject({ id: 'specific', placement: { kind: 'at', target: 'specific' } });
  expect(guard.operation(diagram('another-answer', 'Habit tracking app angles'))).toBeUndefined();
  expect(guard.operation(pick('new-pick'))).toMatchObject({ id: 'pick-one', placement: { kind: 'near', target: 'specific', direction: 'below' } });
  expect(guard.operation(pick('extra-pick'))).toBeUndefined();
  expect(guard.cleanup()).toEqual([{ op: 'delete', ids: ['generic', 'generic-a', 'generic-b', 'pick-two'] }]);
});
test('incomplete or topicless questions cannot produce an answer or recommendation', () => {
  for (const utterance of ['uh do you have any unique angles', 'Do you have any unique angles?']) {
    const guard = answerGuard(input(new BoardState(), 'live', utterance));
    expect(guard.operation(diagram('generic', 'Unique angles', 'Underserved audience'))).toBeUndefined();
    expect(guard.operation(pick('pick'))).toBeUndefined();
  }
});
test('question answers stay beside the topic and request-restating stickies are dropped', () => {
  const board = new BoardState(); board.apply({ op: 'add_shape', id: 'topic', shape: 'box', label: 'Habit tracking app', color: 'blue', placement: { kind: 'auto' } });
  const guard = answerGuard(input(board, 'live'));
  expect(guard.operation(diagram('answer', 'Habit tracking app angles'))).toMatchObject({ placement: { kind: 'near', target: 'topic', direction: 'right' } });
  expect(guard.operation({ ...pick('meta'), label: 'Habit tracking app — explore a distinctive angle' })).toBeUndefined();
});

test('question ownership preserves unrelated diagrams, picks and request-like content', () => {
  const board = new BoardState();
  board.apply(diagram('weather', 'Weather tracking service'));
  board.apply(diagram('specific', 'Habit tracking app angles'));
  board.apply({ ...pick('weather-pick'), label: 'Pick: weather forecasts' });
  board.apply({ ...pick('unrelated'), shape: 'box', label: 'Explore a unique idea' });
  const guard = answerGuard(input(board, 'refine'));
  expect(guard.operation(diagram('new', 'Habit tracking app angles'))).toMatchObject({ id: 'specific' });
  expect(guard.cleanup()).toEqual([]);
  expect(guard.operation(pick('new-pick'))).not.toMatchObject({ id: 'weather-pick' });
});

test('generic labels on an unrelated named diagram do not imply question ownership', () => {
  const board = new BoardState();
  board.apply(diagram('weather', 'Weather options', 'Underserved audience'));
  board.apply(diagram('specific', 'Habit tracking app angles'));
  const guard = answerGuard(input(board, 'refine'));
  expect(guard.cleanup()).toEqual([]);
});

test('direct API refine reuses reserved answer IDs even without engine ownership metadata', () => {
  const board = new BoardState();
  board.apply(diagram('answer-earlier-1', 'Habit tracking app angles'));
  board.apply(pick('answer-earlier-1-pick'));
  const guard = answerGuard(input(board, 'refine'));
  expect(guard.operation(diagram('fresh', 'Habit tracking app angles'))).toMatchObject({ id: 'answer-earlier-1' });
  expect(guard.operation(pick('fresh-pick'))).toMatchObject({ id: 'answer-earlier-1-pick' });
});
