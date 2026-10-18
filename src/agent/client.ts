import { diagnostic } from '../voice/diagnostics';
import { AgentEvent, type AgentRequest } from '../../shared/agent-protocol';

export async function* parseAgentStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => { void reader.cancel(signal?.reason); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 20_000_000) throw new Error('Agent event is too large');
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) yield AgentEvent.parse(JSON.parse(line));
      if (done) break;
    }
    if (buffer.trim()) yield AgentEvent.parse(JSON.parse(buffer));
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function* agentEvents(input: AgentRequest, signal: AbortSignal, options: { timeoutMs?: number } = {}) {
  const id = crypto.randomUUID();
  const deadline = new AbortController();
  const timeoutMs = options.timeoutMs ?? (input.mode === 'suggest' ? 15_000 : input.mode === 'refine' ? 8000 : 60_000);
  const timer = setTimeout(() => { diagnostic('request.timeout', { id, mode: input.mode ?? 'turn', timeoutMs }); deadline.abort(new Error('Drawing timed out. You can keep talking.')); }, timeoutMs);
  const bounded = AbortSignal.any([signal, deadline.signal]);
  diagnostic('request.start', { id, mode: input.mode ?? 'turn' });
  try {
    const response = await fetch('/api/agent', { method: 'POST', signal: bounded, credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (!response.ok || !response.body) throw new Error(`Could not start agent (${response.status})`);
    yield* parseAgentStream(response.body, bounded);
  } finally { clearTimeout(timer); diagnostic('request.end', { id, aborted: bounded.aborted }); }
}
