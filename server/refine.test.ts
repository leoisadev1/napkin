import { expect, test } from 'bun:test';
import { handleRequest } from './index';
import { parseAgentStream } from '../src/agent/client';
import { BoardState } from './board-state';
import type { AgentRequest } from '../shared/agent-protocol';

for (const [topic, kind] of [
  ['Cat Simulator, a Roblox game. Brainstorm a progression system with XP and prestige. Earn coins, upgrade your cat, unlock areas, then repeat with harder tasks.', 'cycle'],
  ['Our roadmap: prototype in October, beta in November, launch in December, then expansion in January.', 'timeline'],
]) test.skipIf(!process.env.DEV_LLM_BASE_URL)(`real refine draws ${kind} and fixes fragments`, async () => {
  const board = new BoardState(); const ops = [];
  if (kind === 'cycle') board.apply({ op: 'add_shape', id: 'game', shape: 'box', label: 'Cast Simulator', color: 'blue', placement: { kind: 'auto' } });
  if (kind === 'cycle') board.apply({ op: 'add_shape', id: 'fragment', shape: 'box', label: 'Cat', color: 'blue', placement: { kind: 'auto' } });
  // An existing image isolates diagram latency; the real image path has its own smoke run.
  board.apply({ op: 'add_image', id: 'concept', caption: 'Concept', dataUrl: 'data:image/png;base64,AA==', placement: { kind: 'auto' } });
  const started = performance.now();
  const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', signal: AbortSignal.timeout(12000), body: JSON.stringify({ mode: 'refine', utterance: topic, history: [], board: board.summary() } satisfies AgentRequest) }));
  expect(response.status).toBe(200); if (!response.body) throw new Error('No response body');
  for await (const event of parseAgentStream(response.body)) {
    expect(event.type).not.toBe('error');
    if (event.type === 'op') { ops.push(event.op); board.apply(event.op); }
  }
  process.stderr.write(`${JSON.stringify({ kind, refineMs: Math.round(performance.now() - started), board: board.summary(), ops })}\n`);
  expect(ops.some(op => op.op === 'add_diagram' && (op.kind === kind || kind === 'cycle' && op.kind === 'flow'))).toBe(true);
  expect(board.summary().items.some(item => /^(cat|cast simulator)$/i.test(item.label))).toBe(false);
}, 15000);
