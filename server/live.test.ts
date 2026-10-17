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

test.skipIf(!process.env.DEV_LLM_BASE_URL)('pause suggestions return 2-3 short next additions without drawing within four seconds', async () => {
  const started = performance.now(); let arrived: number | undefined; let ops = 0;
  const suggestions: string[][] = [];
  const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', signal: AbortSignal.timeout(5000), body: JSON.stringify({
    mode: 'suggest', utterance: 'A habit tracker with daily check-ins, streaks and reminders.', history: [],
    board: { title: 'Habit tracker', items: [], selection: [] },
  }) }));
  expect(response.status).toBe(200); if (!response.body) throw new Error('Missing stream');
  for await (const event of parseAgentStream(response.body)) {
    expect(event.type).not.toBe('error');
    if (event.type === 'op' || event.type === 'pending') ops++;
    if (event.type === 'suggestions') { arrived = performance.now() - started; suggestions.push(event.items); }
  }
  expect(ops).toBe(0); expect(suggestions).toHaveLength(1);
  expect(suggestions[0]?.length).toBeGreaterThanOrEqual(2); expect(suggestions[0]?.length).toBeLessThanOrEqual(3);
  for (const item of suggestions[0] ?? []) expect(item.length).toBeLessThanOrEqual(40);
  process.stderr.write(`${JSON.stringify({ suggestMs: Math.round(arrived ?? -1), suggestions, ops })}\n`);
  expect(arrived ?? Infinity).toBeLessThan(4000);
}, 8000);

test.skipIf(!process.env.DEV_LLM_BASE_URL)('live screens have meaningful components, enrich the same mockup, and separate distinct areas', async () => {
  const board = new BoardState(); const history: ChatTurn[] = [];
  let screen: Extract<import('../shared/board').BoardOp, { op: 'add_mockup' }> | undefined;
  for (const utterance of [
    'Core loop: a habit tracker with morning check-ins and streaks.',
    'Draw a phone main screen with Today, a habit list, check-in buttons and tabs.',
    'On that same main screen, add a weekly progress chart while keeping the habit list, check-in buttons and tabs.',
    'Engagement is a separate area: add a social feed and friend reminders.',
  ]) {
    const previous = screen;
    const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', signal: AbortSignal.timeout(15000), body: JSON.stringify({ mode: 'live', utterance, history, board: board.summary() }) }));
    if (!response.body) throw new Error('Missing stream');
    for await (const event of parseAgentStream(response.body)) {
      expect(event.type).not.toBe('error');
      if (event.type === 'op') {
        board.apply(event.op);
        if (event.op.op === 'add_mockup') {
          screen = event.op;
          expect(screen.components.length).toBeGreaterThanOrEqual(4); expect(screen.components.length).toBeLessThanOrEqual(8);
          if (previous) expect(screen.id).toBe(previous.id);
        }
      }
    }
    history.push({ role: 'user', text: utterance });
    if (utterance.includes('Draw a phone')) expect(screen).toBeDefined();
    if (utterance.includes('weekly progress chart')) {
      expect(screen).not.toBe(previous);
      expect(screen?.components.some(component => component.kind === 'chart')).toBe(true);
      expect(screen?.components.some(component => component.kind === 'list')).toBe(true);
      expect(screen?.components.some(component => component.kind === 'button')).toBe(true);
    }
    if (screen) history.push({ role: 'assistant', text: `Current mockup: ${JSON.stringify(screen)}` });
  }
  const frames = board.summary().items.filter(item => item.kind === 'frame');
  process.stderr.write(`${JSON.stringify({ screen, frames })}\n`);
  expect(frames.length).toBeGreaterThanOrEqual(3);
}, 65000);
