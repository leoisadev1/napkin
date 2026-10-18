import { z } from 'zod';
import { expect, test } from 'bun:test';
import { StretchQuestions, questionPolicyPrefix } from '../src/conversation/engine/questions';
import { answerGuard } from './answers';
import { BoardState } from './board-state';
import type { BoardOp } from '../shared/board';
const policyIds = (text: string) => z.object({ answer: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(text.slice(questionPolicyPrefix.length))).answer.map(question => question.id);
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
  expect(guard.operation(diagram(policyIds(policy)[0] ?? 'missing'))).toBeDefined();
  expect(guard.operation(diagram(policyIds(policy)[1] ?? 'missing'))).toBeDefined();
  expect(guard.operation(diagram('answer-unowned'))).toBeUndefined();
  expect(ledger.claim(`${utterance} Keep it simple`, false).slice(questionPolicyPrefix.length)).toContain('"answer":[]');
});

test('two questions never reuse the same ambiguous legacy diagram', () => {
  const board = new BoardState(); board.apply({ ...diagram('habit'), title: 'Habit app options' });
  const utterance = 'Which database for the habit app? Which editor for the habit app?';
  const ledger = new StretchQuestions();
  const policy = ledger.claim(utterance, true);
  const guard = answerGuard({ mode: 'live', utterance, history: [{ role: 'user', text: policy }], board: board.summary() });
  const first = guard.operation(diagram(policyIds(policy)[0] ?? 'missing')); const second = guard.operation(diagram(policyIds(policy)[1] ?? 'missing'));
  expect(first).toBeDefined(); expect(second).toBeDefined();
  if (!first || !second || !('id' in first) || !('id' in second)) throw new Error('No answers');
  expect(first.id).not.toBe(second.id);
});
test('comparison waits for both named alternatives', () => {
  const ledger = new StretchQuestions(); const fragment = 'I am building a habit app. Compare Postgres';
  expect(ledger.claim(fragment, false)).toContain('"answer":[]');
  expect(ledger.claim(`${fragment} and SQLite.`, false)).toContain('"answer":[{');
});
test('a casual naming request is claimed once its topic arrives', () => {
  const ledger = new StretchQuestions(); const request = 'just experiment with some names';
  expect(ledger.claim(request, false)).toContain('"answer":[]');
  expect(ledger.hasOpen()).toBe(false);
  expect(ledger.claim(`${request} by the way this is like a tech podcast so`, false)).toContain('"answer":[{');
  expect(ledger.hasOpen()).toBe(true);
});

test('relative-clause continuations do not claim a second parallel answer', () => {
  const ledger = new StretchQuestions();
  const first = 'How should we store notes in our app';
  expect(policyIds(ledger.claim(first, false))).toHaveLength(1);
  expect(policyIds(ledger.claim(`${first} which people will edit on trains without internet?`, false))).toHaveLength(0);
});
test('a new explicit naming request does not merge into a previous unpunctuated question', () => {
  const ledger = new StretchQuestions(); const first = 'How should we store notes in our app';
  const initial = policyIds(ledger.claim(first, false));
  const next = policyIds(ledger.claim(`${first} Generate some names for the app`, false));
  expect(next).toHaveLength(1); expect(next[0]).not.toBe(initial[0]);
});
