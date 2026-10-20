/** bun run server/bench.ts -- real HTTP replay; BENCH_OUTPUT is outside the repo. */
import { mkdir } from 'node:fs/promises';
import { AgentEvent, AgentRequest } from '../shared/agent-protocol';
import type { BoardOp } from '../shared/board';
import { PhraseChunker } from '../src/voice/phrase-chunker';
import { ConversationEngine } from '../src/conversation/engine/conversation-engine';
import { BoardState } from './board-state';

export const scenarios = [
  { name: 'late-topic', phrases: ['uh just experiment with some names', 'by the way this is like a tech podcast', 'for builders shipping weird little projects', 'maybe something playful rather than corporate'] },
  { name: 'ideas', phrases: ['okay throw some ideas down', 'for a neighborhood tool lending app', 'what if we let people reserve a drill', 'and uh earn trust by returning it'] },
  { name: 'flow', phrases: ["let\'s map out a repair booking flow", 'first take a photo of the broken sink', 'then match with a local plumber', 'they quote a price and the customer confirms'] },
  { name: 'screen', phrases: ['I want a phone screen for a running club', 'uh upcoming runs and a join button', 'show distance pace and who is coming', 'actually make the join button say count me in'] },
  { name: 'comparison', phrases: ['we need storage for our offline notes app', 'how would SQLite compare with Postgres', 'people should edit on a train with no internet', 'and sync when they reconnect'] },
  { name: 'question', phrases: ['I am making a meal planning app', 'what could make it useful for busy parents', 'maybe leftovers become lunch the next day', 'and a shopping list grouped by aisle'] },
  { name: 'correction', phrases: ['a cat simulator game with coins', 'you do chores and upgrade your cat', 'no wait not chores little hunting quests', 'then unlock a rooftop and repeat'] },
  { name: 'coffee-demo', phrases: ['I want an app for ordering coffee ahead', 'pick your drink, pay, and pick it up', 'show me the phone screen for picking a drink', 'make the button say order now'] },
  { name: 'rambling', phrases: ['so uh I have been thinking about', 'a quiet coworking cafe for night owls', 'coffee downstairs and silent desks upstairs', 'what if we sold monthly desk passes'] },
];
const output = process.env.BENCH_OUTPUT ?? '/tmp/rtw-bench';
await mkdir(output, { recursive: true });
const endpoint = process.env.BENCH_URL ?? 'http://127.0.0.1:4902/api/agent';
const originalFetch = globalThis.fetch;
const results = [];
for (const scenario of scenarios.filter(row => !process.env.BENCH_SCENARIO || row.name === process.env.BENCH_SCENARIO)) {
  const board = new BoardState();
  const operations: { at: number; mode: string; text: string; op: BoardOp; appliedAt?: number }[] = [];
  const requests: { mode: string; text: string; ops: number; firstOpMs: number | null; totalMs: number; error?: string }[] = [];
  const rows: { text: string; content: boolean; endedAt: number; firstOpAt?: number }[] = [];
  const byId = new Map<string, (typeof rows)[number]>();
  let active = 0;
  // Tee the actual NDJSON stream so the engine sees each line immediately.
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (url !== '/api/agent') return originalFetch(url, init);
    const input = AgentRequest.parse(JSON.parse(String(init?.body)));
    const start = performance.now(); active++;
    const row: (typeof requests)[number] = { mode: input.mode, text: input.utterance, ops: 0, firstOpMs: null, totalMs: 0 }; requests.push(row);
    try {
      const response = await originalFetch(endpoint, init);
      if (!response.body) throw new Error('No response stream');
      let buffer = '';
      const reader = response.body.getReader();
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            while (true) {
              const { value: chunk, done } = await reader.read();
              if (done) break;
          buffer += new TextDecoder().decode(chunk, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const event = AgentEvent.parse(JSON.parse(line));
            if (event.type === 'error') row.error = event.message;
            if (event.type === 'op') { row.ops++; row.firstOpMs ??= Math.round(performance.now() - start); operations.push({ at: performance.now(), mode: input.mode, text: input.utterance, op: event.op }); }
          }
          controller.enqueue(chunk);
            }
            controller.close();
          } catch (error) { row.error = init?.signal?.aborted ? 'aborted' : 'stream failed'; controller.error(error); }
          finally { active--; row.totalMs = Math.round(performance.now() - start); reader.releaseLock(); }
        },
        cancel() { return reader.cancel(); },
      }), { status: response.status, headers: response.headers });
    } catch (error) { active--; row.error = init?.signal?.aborted ? 'aborted' : 'request failed'; row.totalMs = Math.round(performance.now() - start); throw error; }
  }, { preconnect: originalFetch.preconnect });
  let visibleApplied = false;
  const rendered = new Map<string, string>();
  const engine = new ConversationEngine({ getSummary: board.summary, apply(op) {
    const before = JSON.stringify(board.summary().items.filter(item => !['frame', 'edge'].includes(item.kind)));
    board.apply(op);
    const after = JSON.stringify(board.summary().items.filter(item => !['frame', 'edge'].includes(item.kind)));
    const payload = op.op === 'add_mockup' ? JSON.stringify(op.components) : op.op === 'add_diagram' ? JSON.stringify({ nodes: op.nodes, links: op.links, axes: op.axes, kind: op.kind }) : '';
    const structuredChange = (op.op === 'add_mockup' || op.op === 'add_diagram') && rendered.get(op.id) !== payload;
    if (op.op === 'add_mockup' || op.op === 'add_diagram') rendered.set(op.id, payload);
    const visibleAddition = structuredChange || ['add_shape', 'add_diagram', 'add_mockup', 'add_image', 'update'].includes(op.op) && before !== after;
    visibleApplied = visibleAddition;
  }, showPending() {}, clearPending() {} }, { onApplied(event) {
    if (visibleApplied) for (const id of event.ids) { const row = byId.get(id); if (row) row.firstOpAt ??= event.at; }
    visibleApplied = false;
  }, onTiming(event) {
    if (event.stage === 'request') {
      const waiting = rows.filter(row => ![...byId.values()].includes(row));
      event.ids.forEach((id, index) => { const row = waiting[index]; if (row) byId.set(id, row); });
    }
  } });
  let lastWordAt = 0;
  const chunker = new PhraseChunker({ onPartial: engine.receivePartial, onPhrase(text) {
    rows.push({ text, content: !/^so uh|^okay throw|^uh just/i.test(text), endedAt: lastWordAt });
    engine.receivePhrase(text);
  } });
  try {
    for (const text of scenario.phrases) {
      lastWordAt = performance.now(); chunker.addText(text); chunker.endSegment(); await Bun.sleep(Number(process.env.BENCH_GAP_MS ?? 1000));
    }
    chunker.endTurn(); engine.finishSpokenStretch();
    const deadline = performance.now() + 45000;
    while ((active || engine.getSnapshot().sketching || engine.getSnapshot().refining) && performance.now() < deadline) await Bun.sleep(50);
    const latencies = rows.filter(row => row.content && row.firstOpAt !== undefined).map(row => Math.round((row.firstOpAt ?? 0) - row.endedAt)).sort((a, b) => a - b);
    const labels = board.summary().items.filter(item => item.kind === 'shape').map(item => item.label.toLowerCase());
    const duplicates = labels.length - new Set(labels).size;
    const junk = labels.filter(label => /underserved audience|reverse a norm|unexpected pairing|one painful task|useful constraint/.test(label)).length;
    const result = { latencySampleCount: latencies.length, missedContentPhrases: rows.filter(row => row.content && row.firstOpAt === undefined).map(row => row.text), timedOut: active > 0, usefulStretch: labels.length > 0 || board.summary().items.some(item => item.kind === 'mockup'), refineOps: operations.filter(row => row.mode === 'refine').length, name: scenario.name, hitRate: latencies.length / rows.filter(row => row.content).length, p50: latencies[Math.floor(latencies.length * .5)] ?? null, p90: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * .9))] ?? null, duplicates, junk, requests, rows, operations, board: board.summary() };
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\"', '&quot;');
    const items = result.board.items;
    const cards = items.filter(item => item.kind !== 'edge').map(item => {
      const mockup = operations.findLast(row => row.op.op === 'add_mockup' && row.op.id === item.id)?.op;
      const detail = mockup?.op === 'add_mockup' ? mockup.components.map(component => `<p>${escape(component.kind)}: ${escape(component.label)}</p>`).join('') : '';
      return `<article><small>${escape(item.kind)}${item.frame ? ` · ${escape(item.frame)}` : ''}</small><h3>${escape(item.label)}</h3>${detail}<code>${escape(item.id)}</code></article>`;
    }).join('');
    await Bun.write(`${output}/${scenario.name}.html`, `<!doctype html><meta charset="utf-8"><title>${escape(scenario.name)}</title><style>body{font:16px system-ui;margin:24px;color:#182333;background:#f5f7fa}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}article{padding:18px;border:1px solid #ccd5df;border-radius:12px;background:white}small,code{color:#526377;font-size:12px}h3{margin:10px 0}p{border-top:1px solid #ddd;padding-top:8px}</style><h1>${escape(result.board.title || scenario.name)}</h1><p>Semantic board snapshot; cards show final items and screen components, not canvas geometry.</p><main>${cards}</main>`);
    results.push(result); await Bun.write(`${output}/${scenario.name}.json`, JSON.stringify(result, null, 2));
    process.stdout.write(`${JSON.stringify({ name: result.name, hitRate: result.hitRate, p50: result.p50, p90: result.p90, duplicates, junk, errors: requests.filter(row => row.error).length })}\n`);
  } finally { chunker.reset(); engine.interrupt(); globalThis.fetch = originalFetch; }
}
await Bun.write(`${output}/results.json`, JSON.stringify(results, null, 2));
