import { expect, test } from 'bun:test';
import { BoardSummary, type BoardOp } from '../shared/board';
import { handleRequest } from './index';
import { parseAgentStream } from '../src/agent/client';
import { boardContext } from './board-context';

const board = BoardSummary.parse({ title: 'Checkout', selection: [], pointer: { x: 220, y: 160, over: 'my-sketch' }, viewport: { x: 0, y: 0, w: 1000, h: 800 }, items: [
  { id: 'my-sketch', kind: 'sketch', origin: 'user', label: '', bounds: { x: 150, y: 100, w: 180, h: 100 }, frame: null, link: '' },
  { id: 'checkout', kind: 'shape', origin: 'agent', label: 'Checkout', bounds: { x: 450, y: 100, w: 180, h: 100 }, frame: null, link: '' },
] });

test('compact context retains selected/pointed/named items on large boards and bounds prompt growth', () => {
  const large = { ...board, items: [...board.items, ...Array.from({ length: 398 }, (_, i): BoardSummary['items'][number] => ({ kind: 'shape', origin: 'agent', label: '', bounds: { x: 0, y: 0, w: 100, h: 100 }, frame: null, link: '', id: `other-${i}` }))] };
  const text = boardContext(large, 'Connect to checkout');
  expect(text).toContain('my-sketch sketch user'); expect(text).toContain('checkout shape agent');
  expect(text).toContain('400 total'); expect(text).toContain('345 omitted');
  expect(text.length).toBeLessThan(JSON.stringify(large).length / 4);
});

async function draw(utterance: string) {
  const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', signal: AbortSignal.timeout(15000), body: JSON.stringify({ board, utterance, history: [], mode: 'live' }) }));
  expect(response.status).toBe(200); if (!response.body) throw new Error('No stream');
  const ops: BoardOp[] = [];
  for await (const event of parseAgentStream(response.body)) { expect(event.type).not.toBe('error'); if (event.type === 'op') ops.push(event.op); }
  return ops;
}

test.skipIf(!process.env.DEV_LLM_BASE_URL)('dev LLM labels and connects the user sketch under the pointer using its ID', async () => {
  const ops = await draw('label this as the payment service and connect it to checkout');
  expect(ops.some(op => op.op === 'update' && op.id === 'my-sketch' && /payment service/i.test(op.label ?? ''))).toBe(true);
  expect(ops.some(op => op.op === 'add_edge' && op.from === 'my-sketch' && op.to === 'checkout')).toBe(true);
  expect(ops.some(op => op.op === 'delete' || op.op === 'add_shape')).toBe(false);
}, 20000);

test.skipIf(!process.env.DEV_LLM_BASE_URL)('dev LLM puts a login mockup at the pointer', async () => {
  const ops = await draw('put a login screen here');
  expect(ops.some(op => op.op === 'add_mockup' && op.placement.kind === 'at_pointer')).toBe(true);
}, 20000);


test('dependency expansion cannot crowd the focused sketch out of compact context', () => {
  const endpoints = Array.from({ length: 108 }, (_, i): BoardSummary['items'][number] => ({ id: `node-${i}`, kind: 'shape', origin: 'agent', label: 'old', bounds: { x: 5000, y: 5000, w: 100, h: 100 }, frame: null, link: '' }));
  const edges = Array.from({ length: 54 }, (_, i): BoardSummary['items'][number] => ({ id: `edge-${i}`, kind: 'edge', origin: 'agent', label: 'recent', bounds: { x: 0, y: 0, w: 100, h: 100 }, frame: null, link: `node-${i * 2} -> node-${i * 2 + 1}` }));
  const text = boardContext({ ...board, selection: ['my-sketch'], items: [...endpoints, ...edges, ...board.items.slice(0, 1)] }, 'this');
  expect(text).toContain('my-sketch sketch user');
  expect(text).toContain('@150,100 180x100');
});

test.skipIf(!process.env.DEV_LLM_BASE_URL)('dev LLM cleans a requested user sketch into a flow at its original spot', async () => {
  const ops = await draw('turn this sketch into a flowchart: validate payment, charge card, then send receipt');
  expect(ops.some(op => op.op === 'delete' && op.ids.includes('my-sketch'))).toBe(true);
  expect(ops.some(op => op.op === 'add_diagram' && op.kind === 'flow' && op.placement.kind === 'at' && op.placement.target === 'my-sketch')).toBe(true);
}, 20000);
