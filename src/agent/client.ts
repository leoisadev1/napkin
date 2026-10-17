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
export async function* agentEvents(input: AgentRequest, signal: AbortSignal) {
  const response = await fetch('/api/agent', { method: 'POST', signal, credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok || !response.body) throw new Error(`Could not start agent (${response.status})`);
  yield* parseAgentStream(response.body, signal);
}
