import { expect, test } from 'bun:test';
import { parseAgentStream } from '../src/agent/client';
function stream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}
test('NDJSON handles split lines, CRLF, blanks and missing trailing newline', async () => {
  const events = [];
  for await (const event of parseAgentStream(stream(['{"type":"say","te', 'xt":"Hello"}\r\n\n{"type":"do', 'ne"}']))) events.push(event);
  expect(events).toEqual([{ type: 'say', text: 'Hello' }, { type: 'done' }]);
});
test('NDJSON rejects invalid operations', async () => {
  let failed = false;
  try { for await (const event of parseAgentStream(stream(['{"type":"op","op":{"op":"clear_all"}}\n']))) void event; } catch { failed = true; }
  expect(failed).toBe(true);
});
test('NDJSON abort cancels a stalled reader', async () => {
  const abort = new AbortController();
  const parser = parseAgentStream(new ReadableStream<Uint8Array>(), abort.signal);
  const next = parser.next(); abort.abort();
  expect(next).rejects.toThrow();
});
