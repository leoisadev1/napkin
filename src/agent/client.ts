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
/**
 * A request that fails before any response (TypeError "Failed to fetch") never reached the server: the HTTPS proxy in
 * front of it occasionally hands the browser a dead pooled connection. Retrying on a fresh connection is safe and
 * keeps the phrase instead of dropping it with an error flash.
 */
async function fetchWithRetry(url: string, init: RequestInit & { signal: AbortSignal }, id: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (init.signal.aborted || !(error instanceof TypeError) || attempt >= 2) throw error;
      diagnostic('request.retry', { id, attempt: attempt + 1 });
      await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
}
export async function* agentEvents(input: AgentRequest, signal: AbortSignal, options: { timeoutMs?: number } = {}) {
  const id = crypto.randomUUID();
  const deadline = new AbortController();
  const timeoutMs = options.timeoutMs ?? (input.mode === 'suggest' ? 15_000 : input.mode === 'refine' ? 14_000 : 60_000);
  const timer = setTimeout(() => { diagnostic('request.timeout', { id, mode: input.mode ?? 'turn', timeoutMs }); deadline.abort(new Error('Drawing timed out. You can keep talking.')); }, timeoutMs);
  const bounded = AbortSignal.any([signal, deadline.signal]);
  diagnostic('request.start', { id, mode: input.mode ?? 'turn' });
  try {
    const response = await fetchWithRetry('/api/agent', { method: 'POST', signal: bounded, credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, id);
    if (!response.ok || !response.body) throw new Error(`Could not start agent (${response.status})`);
    yield* parseAgentStream(response.body, bounded);
  } finally { clearTimeout(timer); diagnostic('request.end', { id, aborted: bounded.aborted }); }
}
