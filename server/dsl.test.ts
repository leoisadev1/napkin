import { expect, test } from 'bun:test';
import { DrawingStream, parseDrawingLine } from './dsl';
import type { BoardOp } from '../shared/board';
import type { DrawingLine } from './dsl';

test('DSL covers every operation, placements, unknown IDs, escaped strings and mockups', () => {
  const cases: [string, BoardOp['op']][] = [
    ['box habit blue in:core "Check in"', 'add_shape'], ['ellipse habit green "Loop"', 'add_shape'],
    ['diamond choice yellow "Which?"', 'add_shape'], ['sticky idea pink near:missing:right "A \\"quote\\" | pipe"', 'add_shape'],
    ['text label gray "Text"', 'add_shape'], ['frame core "Core loop"', 'add_frame'],
    ['edge e1 missing->habit "updates"', 'add_edge'],
    ['phone home in:core "Today" | header:Today | list:Habits | button:Check in | tabbar:Today,Feed', 'add_mockup'],
    ['desktop web near:home:left "Web" | header:Dashboard', 'add_mockup'],
    ['update missing color:red "Changed"', 'update'], ['move missing near:habit:below', 'move'],
    ['del a b', 'delete'], ['title "Habits"', 'set_title'], ['clear', 'clear'],
  ];
  for (const [input, op] of cases) {
    const result = parseDrawingLine(input ?? '');
    expect(result?.kind).toBe('op'); if (result?.kind === 'op') expect(result.op.op).toBe(op);
  }
  expect(parseDrawingLine('image art "A flower" "Flower" near:home:right')).toEqual({ kind: 'image', id: 'art', prompt: 'A flower', caption: 'Flower', placement: { kind: 'near', target: 'home', direction: 'right' } });
});
test('invalid lines are skipped without poisoning subsequent lines', () => {
  for (const line of ['nonsense', 'box invalid_id blue "Bad"', 'box a ultraviolet "Bad"', 'box a blue "unterminated', 'edge a b "Bad"', 'phone a "Empty"', 'move a near:b:down', 'update a', 'clear everything']) expect(parseDrawingLine(line)).toBeUndefined();
});
test('suggestions are limited to three concrete short chips', () => {
  expect(parseDrawingLine('suggest: Add reminders | Add social feed | Add stats | Fourth')).toEqual({ kind: 'suggestions', items: ['Add reminders', 'Add social feed', 'Add stats'] });
});
test('stream emits complete lines immediately, buffers frames until child, drops empty frames', () => {
  const lines: DrawingLine[] = []; const parser = new DrawingStream(line => lines.push(line));
  parser.push('frame core "Core"\n'); expect(lines).toHaveLength(0);
  parser.push('box habit blue in:core "Check'); expect(lines).toHaveLength(0);
  parser.push(' in"\n'); expect(lines).toHaveLength(2);
  parser.push('frame empty "Empty"\nbox stray blue "Outside"\ntitle "Habits"');
  expect(lines).toHaveLength(3); parser.finish(); expect(lines).toHaveLength(4);
  expect(lines.some(line => line.kind === 'op' && line.op.op === 'add_frame' && line.op.id === 'empty')).toBe(false);
});

test('quoted delimiters and escapes survive updates and mockup component labels', () => {
  expect(parseDrawingLine('update x "color:red"')).toEqual({ kind: 'op', op: { op: 'update', id: 'x', label: 'color:red' } });
  const result = parseDrawingLine('phone home "Home" | text:"A | B" | button:"Say \\"hi\\""');
  expect(result?.kind).toBe('op');
  if (result?.kind === 'op' && result.op.op === 'add_mockup') expect(result.op.components).toEqual([{ kind: 'text', label: 'A | B' }, { kind: 'button', label: 'Say "hi"' }]);
  expect(parseDrawingLine('box x blue nonsense "Label"')).toBeUndefined();
  expect(parseDrawingLine('box x blue "Label" extra')).toBeUndefined();
});
test('image child defers its frame until successful image generation', () => {
  const lines: DrawingLine[] = []; const parser = new DrawingStream(line => lines.push(line));
  parser.push('frame gallery "Gallery"\nimage art "A flower" "Flower" in:gallery\n'); parser.finish();
  expect(lines).toHaveLength(1); expect(lines[0]?.kind).toBe('image');
  if (lines[0]?.kind === 'image') expect(lines[0].frame?.id).toBe('gallery');
});

test('diagram DSL parses kinds, shapes, hierarchy, links and axes', () => {
  for (const kind of ['flow', 'cycle', 'tree', 'mindmap', 'timeline', 'funnel', 'quadrant']) {
    const result = parseDrawingLine(`diagram prog ${kind} in:game "Progression loop" | earn:Earn coins:green | upgrade:Upgrade cat:blue:ellipse^earn | links: earn->upgrade "Spend" | axes: Effort | Impact`);
    expect(result?.kind).toBe('op');
    if (result?.kind !== 'op' || result.op.op !== 'add_diagram') throw new Error('Expected diagram');
    expect(String(result.op.kind)).toBe(kind); expect(result.op.nodes[1]?.parent).toBe('earn');
    expect(result.op.nodes[1]?.shape).toBe('ellipse'); expect(result.op.links).toEqual([{ from: 'earn', to: 'upgrade', label: 'Spend' }]);
    expect(result.op.axes).toEqual(['Effort', 'Impact']); expect(result.op.placement).toEqual({ kind: 'inside', frame: 'game' });
  }
  expect(parseDrawingLine('diagram bad cycle "Invalid" | only:One:blue')).toBeUndefined();
});
test('diagram quoted delimiters preserve node and link labels', () => {
  const line = parseDrawingLine('diagram d flow "Flow" | a:"A | B":blue | b:Done:green | links: a->b "yes; continue"');
  if (line?.kind !== 'op' || line.op.op !== 'add_diagram') throw new Error('Missing diagram');
  expect(line.op.nodes[0]?.label).toBe('A | B'); expect(line.op.links[0]?.label).toBe('yes; continue');
});

test('here and at placements address the pointer or existing item across drawing commands', () => {
  expect(parseDrawingLine('box payment blue here "Payment"')).toEqual({ kind: 'op', op: { op: 'add_shape', id: 'payment', shape: 'box', color: 'blue', label: 'Payment', placement: { kind: 'at_pointer' } } });
  expect(parseDrawingLine('move payment at:sketch')).toEqual({ kind: 'op', op: { op: 'move', id: 'payment', placement: { kind: 'at', target: 'sketch' } } });
  const mockup = parseDrawingLine('phone login here "Login" | header:Login | input:Email | input:Password | button:Sign in');
  expect(mockup?.kind === 'op' && mockup.op.op === 'add_mockup' && mockup.op.placement).toEqual({ kind: 'at_pointer' });
  expect(parseDrawingLine('box bad blue at: "Invalid"')).toBeUndefined();
});
