import { expect, test } from 'bun:test';
import { handleRequest } from './index';
import { parseAgentStream } from '../src/agent/client';
import { BoardState } from './board-state';
import { StretchQuestions } from '../src/conversation/engine/questions';
import type { AgentRequest, ChatTurn } from '../shared/agent-protocol';
import type { BoardOp } from '../shared/board';

for (let run = 1; run <= 3; run++) test.skipIf(!process.env.DEV_LLM_BASE_URL)(`habit question live phrases then refine replay ${run}`, async () => {
  const board = new BoardState(); const history: ChatTurn[] = []; const ledger = new StretchQuestions();
  const diagrams = new Map<string, Extract<BoardOp, { op: 'add_diagram' }>>();
  const operations: BoardOp[] = []; let stretch = '';
  const phrases = ["I'm thinking about a habit tracking app", 'uh do you have any unique angles', 'that we could possibly take?'];
  let liveAnswerId: string | undefined;
  for (let step = 0; step < 4; step++) {
    const mode = step < 3 ? 'live' : 'refine';
    const utterance = phrases[step] ?? stretch;
    if (mode === 'live') stretch = `${stretch} ${utterance}`.trim();
    const context: ChatTurn[] = [...history, { role: 'user', text: `Whole current speaking stretch so far (NEW words are the request utterance): ${stretch}` }, { role: 'user', text: mode === 'live' ? ledger.claim(stretch, board.summary().items.length > 0) : ledger.policy() }, ...[...diagrams.values()].map(op => ({ role: 'assistant', text: `Current diagram: ${JSON.stringify(op)}` } satisfies ChatTurn))];
    const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', signal: AbortSignal.timeout(30000), body: JSON.stringify({ mode, utterance, history: context.slice(-20), board: board.summary() } satisfies AgentRequest) }));
    expect(response.status).toBe(200); if (!response.body) throw new Error('No stream');
    for await (const event of parseAgentStream(response.body)) {
      expect(event.type).not.toBe('error');
      if (event.type !== 'op') continue;
      operations.push(event.op); board.apply(event.op);
      const op = event.op;
      if (op.op === 'add_diagram') { diagrams.set(op.id, op); ledger.complete([op.id]); if (mode === 'live') liveAnswerId = op.id; }
      if (op.op === 'delete') for (const id of op.ids) diagrams.delete(id);
    }
    history.push({ role: 'user', text: utterance });
    if (step < 2) expect(diagrams.size).toBe(0);
    if (step === 2) expect(diagrams.size).toBe(1);
  }
  const items = board.summary().items;
  expect(diagrams.size).toBe(1); if (!liveAnswerId) throw new Error('No live answer'); expect([...diagrams.keys()][0]).toBe(liveAnswerId);
  expect(items.filter(item => /^Pick:/i.test(item.label)).length).toBeLessThanOrEqual(1);
  expect(items.some(item => /underserved audience|reverse a norm|unexpected pairing|one painful task|useful constraint/i.test(item.label))).toBe(false);
  expect(items.some(item => /explore a distinctive angle/i.test(item.label))).toBe(false);
  for (const op of operations) {
    if (op.op === 'add_diagram') {
      expect(op.title.split(/\s+/).length).toBeLessThanOrEqual(6);
      for (const node of op.nodes) expect(node.label.split(/\s+/).length).toBeLessThanOrEqual(6);
      for (const link of op.links) expect(link.label.split(/\s+/).length).toBeLessThanOrEqual(3);
    }
    if (op.op === 'add_shape') expect(op.label.split(/\s+/).length).toBeLessThanOrEqual(/^Pick:/.test(op.label) ? 14 : 6);
    if (op.op === 'add_edge') expect(op.label.split(/\s+/).length).toBeLessThanOrEqual(3);
  }
  process.stderr.write(`${JSON.stringify({ replay: run, diagram: [...diagrams.values()], picks: items.filter(item => /^Pick:/i.test(item.label)), operations })}\n`);
}, 125000);
