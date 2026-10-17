import { expect, test } from 'bun:test';
import { StretchQuestions, questionPolicyPrefix } from '../src/conversation/engine/questions';
import { answerGuard } from './answers';
import { BoardState } from './board-state';
import type { BoardOp } from '../shared/board';
const diagram = (id: string): Extract<BoardOp, { op: 'add_diagram' }> => ({ op: 'add_diagram', id, title: 'Specific options', kind: 'mindmap', nodes: [{ id: `${id}-a`, label: 'Postgres', parent: null, color: 'blue', shape: 'box' }, { id: `${id}-b`, label: 'SQLite', parent: null, color: 'green', shape: 'box' }], links: [], axes: [], placement: { kind: 'auto' } });
test('an imperative does not consume a subsequent completed question', () => {
  const ledger = new StretchQuestions();
  const first = 'Brainstorm angles for a habit tracking app.';
  expect(ledger.claim(first, false)).toContain('"answer":[{');
  expect(ledger.claim(`${first} Which database should it use?`, false)).toContain('"answer":[{');
});
test('two completed questions each retain one answer in a coalesced batch', () => {
  const ledger = new StretchQuestions(); const utterance = 'Which database for the habit app? Which editor for the notes app?';
  const policy = ledger.claim(utterance, false);
  const guard = answerGuard({ mode: 'live', utterance, history: [{ role: 'user', text: policy }], board: new BoardState().summary() });
  expect(guard.operation(diagram('database'))).toBeDefined();
  expect(guard.operation(diagram('editor'))).toBeDefined();
  expect(guard.operation(diagram('duplicate'))).toBeUndefined();
  expect(ledger.claim(`${utterance} Keep it simple`, false).slice(questionPolicyPrefix.length)).toContain('"answer":[]');
});

test('two questions never reuse the same ambiguous legacy diagram', () => {
  const board = new BoardState(); board.apply({ ...diagram('habit'), title: 'Habit app options' });
  const utterance = 'Which database for the habit app? Which editor for the habit app?';
  const ledger = new StretchQuestions();
  const guard = answerGuard({ mode: 'live', utterance, history: [{ role: 'user', text: ledger.claim(utterance, true) }], board: board.summary() });
  const first = guard.operation(diagram('database')); const second = guard.operation(diagram('editor'));
  expect(first).toBeDefined(); expect(second).toBeDefined();
  if (!first || !second || !('id' in first) || !('id' in second)) throw new Error('No answers');
  expect(first.id).not.toBe(second.id);
});
test('comparison waits for both named alternatives', () => {
  const ledger = new StretchQuestions(); const fragment = 'I am building a habit app. Compare Postgres';
  expect(ledger.claim(fragment, false)).toContain('"answer":[]');
  expect(ledger.claim(`${fragment} and SQLite.`, false)).toContain('"answer":[{');
});
