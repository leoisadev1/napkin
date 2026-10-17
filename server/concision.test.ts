import { expect, test } from 'bun:test';
import { parseDrawingLine } from './dsl';
import { validateOperation } from './agent';

test('DSL caps shape, node, title, recommendation and edge words before schema validation', () => {
  const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
  const lines = [
    [`box topic blue "${long}"`, 'label', 'one two three four five six'],
    [`sticky pick green "Pick: ${long}"`, 'label', 'Pick: one two three four five six seven eight nine ten eleven twelve thirteen'],
    [`edge link a->b "${long}"`, 'label', 'one two three'],
    [`title "${long}"`, 'title', 'one two three four five six'],
    [`update topic "${long}"`, 'label', 'one two three four five six'],
  ];
  for (const [line, key, expected] of lines) {
    const parsed = parseDrawingLine(line ?? '');
    expect(parsed?.kind).toBe('op');
    if (parsed?.kind === 'op') expect(Reflect.get(parsed.op, key ?? '')).toBe(expected);
  }
  const diagram = parseDrawingLine(`diagram answer mindmap "${long}" | a:${long}:blue | b:Comeback-first tracking:green | links: a->b "${long}"`);
  expect(diagram?.kind).toBe('op');
  if (diagram?.kind === 'op' && diagram.op.op === 'add_diagram') {
    expect(diagram.op.title).toBe('one two three four five six');
    expect(diagram.op.nodes[0]?.label).toBe('one two three four five six');
    expect(diagram.op.links[0]?.label).toBe('one two three');
  }
  expect(parseDrawingLine(`box topic blue "${'word '.repeat(100)}"`)).toBeDefined();
});
test('validated server operations receive the same limits', () => {
  expect(validateOperation({ op: 'add_shape', id: 'topic', shape: 'box', color: 'blue', placement: { kind: 'auto' }, label: 'Missed days are when habit apps lose people' })).toMatchObject({ label: 'Missed days are when habit apps' });
});

test('only Pick stickies get the longer recommendation budget', () => {
  expect(validateOperation({ op: 'add_shape', id: 'pick', shape: 'box', color: 'green', placement: { kind: 'auto' }, label: 'Pick: Comeback-first tracking because missed days lose people' })).toMatchObject({ label: 'Pick: Comeback-first tracking because missed days' });
});
