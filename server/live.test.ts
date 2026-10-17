import { expect, test } from 'bun:test';
import { handleRequest } from './index';
import { parseAgentStream } from '../src/agent/client';
import { BoardState } from './board-state';
import { livePhrases } from './benchmark';
import type { ChatTurn } from '../shared/agent-protocol';

test.skipIf(!process.env.DEV_LLM_BASE_URL)('four sequential live phrases incrementally fill a board without speech or empty frames', async () => {
  const board = new BoardState(); const history: ChatTurn[] = [];
  for (const utterance of livePhrases) {
    const started = performance.now(); let first: number | undefined; let ops = 0;
    const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', signal: AbortSignal.timeout(15_000), body: JSON.stringify({ mode: 'live', utterance, history, board: board.summary() }) }));
    expect(response.status).toBe(200); if (!response.body) throw new Error('Missing stream');
    for await (const event of parseAgentStream(response.body)) {
      expect(event.type).not.toBe('error'); expect(event.type).not.toBe('say');
      if (event.type === 'op') { first ??= performance.now() - started; ops++; board.apply(event.op); }
    }
    process.stderr.write(`${JSON.stringify({ phrase: utterance, firstOpMs: Math.round(first ?? -1), doneMs: Math.round(performance.now() - started), ops })}\n`);
    expect(ops).toBeGreaterThan(0); expect(first ?? Infinity).toBeLessThan(8000);
    history.push({ role: 'user', text: utterance });
  }
  const items = board.summary().items;
  const frames = items.filter(item => item.kind === 'frame'); expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) expect(items.some(item => item.frame === frame.id)).toBe(true);
  expect(items.filter(item => item.kind !== 'frame').length).toBeGreaterThanOrEqual(4);
}, 65000);
