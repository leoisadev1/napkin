import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { config, log } from './config';

/** Claude Haiku 5.5 list prices in dollars per token (prompts under 100K tokens, which every board request is). */
const PRICE = { input: 0.10 / 1e6, output: 0.50 / 1e6 };
const Ledger = z.object({ month: z.string(), dollars: z.number().nonnegative() });
type Ledger = z.infer<typeof Ledger>;
const file = '.data/budget.json';

const thisMonth = () => new Date().toISOString().slice(0, 7);
let ledger: Ledger | undefined;
let saving = Promise.resolve();

async function load(): Promise<Ledger> {
  if (ledger?.month === thisMonth()) return ledger;
  try {
    const stored = Ledger.parse(JSON.parse(await readFile(file, 'utf8')));
    ledger = stored.month === thisMonth() ? stored : { month: thisMonth(), dollars: 0 };
  } catch { ledger = { month: thisMonth(), dollars: 0 }; }
  return ledger;
}

/** Whether the shared key still has budget left this calendar month (UTC). */
export async function budgetLeft() {
  return (await load()).dollars < config().MONTHLY_BUDGET_USD;
}

export type Usage = { inputTokens?: number | undefined; outputTokens?: number | undefined };
/** Adds one request's cost to the month's total and writes it to disk (a mounted volume in production). */
export async function recordUsage(usage: Usage) {
  const current = await load();
  // Thinking tokens bill as output and are included in outputTokens.
  current.dollars += (usage.inputTokens ?? 0) * PRICE.input + (usage.outputTokens ?? 0) * PRICE.output;
  const snapshot = JSON.stringify(current);
  saving = saving.then(async () => {
    await mkdir('.data', { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, snapshot, { mode: 0o600 }); await rename(temp, file);
  }).catch(() => log('budget_save_failed'));
  await saving;
}
