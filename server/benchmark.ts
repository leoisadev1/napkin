import { z } from 'zod';
import { runAgent } from './agent';
import { config } from './config';

if (import.meta.main) {
  const env = config();
  if (!env.DEV_LLM_BASE_URL) throw new Error('DEV_LLM_BASE_URL required');
  const response = await fetch(`${env.DEV_LLM_BASE_URL}/models`, { headers: { authorization: `Bearer ${env.DEV_LLM_API_KEY}` } });
  const available = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json()).data.map(item => item.id);
  process.stdout.write(`${JSON.stringify({ available: available.filter(m => /gpt-6-luna|gpt-5.6-luna|gpt-5.5/.test(m)) })}\n`);
  for (const model of ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.5']) {
    if (!available.includes(model)) { process.stdout.write(`${JSON.stringify({ model, unavailable: true })}\n`); continue; }
    process.env.DEV_LLM_MODEL = model;
    const start = performance.now(); let firstOp: number | undefined; let firstSay: number | undefined; let ops = 0; let say = '';
    try {
      await runAgent({ request: new Request('http://test/api/agent'),
        input: { utterance: "I'm building a habit tracker app with streaks, reminders and a social feed", history: [], board: { title: '', items: [], selection: [] } },
        signal: AbortSignal.timeout(90_000), emit: event => {
          if (event.type === 'op') { firstOp ??= performance.now() - start; ops++; }
          if (event.type === 'say') { firstSay ??= performance.now() - start; say += event.text; }
        },
      });
      process.stdout.write(`${JSON.stringify({ model, firstOpMs: Math.round(firstOp ?? -1), firstSayMs: Math.round(firstSay ?? -1), totalMs: Math.round(performance.now() - start), ops, say })}\n`);
    } catch (error) { process.stdout.write(`${JSON.stringify({ model, error: error instanceof Error ? error.message : 'unknown' })}\n`); }
  }
}
