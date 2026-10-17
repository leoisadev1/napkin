import { z } from 'zod';
import { runAgent } from './agent';
import { config } from './config';
import { BoardState } from './board-state';
import type { ChatTurn } from '../shared/agent-protocol';
export const livePhrases = ["so it's a habit tracker", 'with streaks', 'and daily reminders at a time you pick', 'plus a small social feed'];
if (import.meta.main) {
  const env = config();
  if (!env.DEV_LLM_BASE_URL) throw new Error('DEV_LLM_BASE_URL required');
  const response = await fetch(`${env.DEV_LLM_BASE_URL}/models`, { headers: { authorization: `Bearer ${env.DEV_LLM_API_KEY}` } });
  const available = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json()).data.map(item => item.id);
  process.stdout.write(`${JSON.stringify({ available })}\n`);
  const candidates = (process.env.BENCH_MODELS?.split(',') ?? [...new Set(['gpt-6-luna', 'gpt-5.6-luna', ...available.filter(m => /spark|mini|nano|flash/i.test(m))])]).filter(m => available.includes(m));
  for (const model of candidates) for (const effort of (process.env.BENCH_EFFORTS?.split(',') ?? ['none', 'minimal', 'low'])) {
    process.env.DEV_LLM_MODEL = model; process.env.DEV_LLM_REASONING_EFFORT = effort;
    const board = new BoardState(); const history: ChatTurn[] = [];
    for (const phrase of (process.env.BENCH_PROBE === '1' ? livePhrases.slice(0, 1) : livePhrases)) {
      const start = performance.now(); let firstOp: number | undefined; let ops = 0;
      try {
        await runAgent({ request: new Request('http://test/api/agent'), input: { mode: 'live', utterance: phrase, history, board: board.summary() }, signal: AbortSignal.timeout(20_000), emit: event => {
          if (event.type === 'op') { firstOp ??= performance.now() - start; ops++; board.apply(event.op); }
        } });
        history.push({ role: 'user', text: phrase });
        process.stdout.write(`${JSON.stringify({ model, effort, phrase, firstOpMs: Math.round(firstOp ?? -1), totalMs: Math.round(performance.now() - start), ops, board: board.summary() })}\n`);
      } catch (error) { process.stdout.write(`${JSON.stringify({ model, effort, error: error instanceof Error ? error.message : 'unknown' })}\n`); break; }
    }
  }
}
