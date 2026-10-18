/** Real provider selection, guard, streaming parser and board consumer. No alternate prompt. */
import { runAgent } from './agent';
import { BoardState } from './board-state';
import type { AgentRequest } from '../shared/agent-protocol';
import type { BoardOp } from '../shared/board';
const models = process.env.BENCH_MODELS?.split(',') ?? ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-luna', 'claude-haiku-5-5', 'grok-4.20-0309-non-reasoning'];
for (const model of models) {
  process.env.DEV_LLM_MODEL = model;
  process.env.DEV_LLM_LIVE_MODEL = model; process.env.DEV_LLM_REFINE_MODEL = model;
  process.env.DEV_LLM_REASONING_EFFORT = 'low';
  for (const mode of ['live', 'refine'] satisfies AgentRequest['mode'][]) {
    const board = new BoardState(); const operations: BoardOp[] = [];
    const start = performance.now(); let first: number | undefined;
    try {
      await runAgent({ request: new Request('http://bench/api/agent'), input: { mode, utterance: 'We are building an offline notes app. Compare SQLite and Postgres for notes edited on a train then synced at home.', history: [], board: board.summary() }, signal: AbortSignal.timeout(20000), emit(event) {
        if (event.type === 'op') { first ??= performance.now() - start; operations.push(event.op); board.apply(event.op); }
      } });
      process.stdout.write(`${JSON.stringify({ model, mode, firstOpMs: Math.round(first ?? -1), totalMs: Math.round(performance.now() - start), ops: operations.length, operations, board: board.summary() })}\n`);
    } catch (error) { process.stdout.write(`${JSON.stringify({ model, mode, error: error instanceof Error ? error.message.slice(0, 250) : 'unknown' })}\n`); }
  }
}
