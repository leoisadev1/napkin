import { expect, mock } from 'bun:test';
import type { openVoiceSocket } from '../../src/voice/socket';
import type { captureMicrophone } from '../../src/voice/microphone';
import { AgentRequest } from '../../shared/agent-protocol';
import { BoardState } from '../board-state';
let socketCallbacks: Parameters<typeof openVoiceSocket>[0] | undefined;
let microphone: Parameters<typeof captureMicrophone>[0] | undefined;
let connections = 0;
const sent: string[] = [];
mock.module('../../src/voice/socket', () => ({ openVoiceSocket: async (args: Parameters<typeof openVoiceSocket>[0]) => {
  socketCallbacks = args; connections++;
  return { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (message: string) => { sent.push(message); }, close() {} };
} }));
mock.module('../../src/voice/microphone', () => ({ captureMicrophone: async (args: Parameters<typeof captureMicrophone>[0]) => { microphone = args; return () => {}; } }));
Object.defineProperty(globalThis, 'AudioContext', { value: class { state = 'running'; async resume() {} async close() { this.state = 'closed'; } } });
const requests: { input: AgentRequest; signal: AbortSignal | null | undefined; stream: ReadableStreamDefaultController<Uint8Array> }[] = [];
const original = globalThis.fetch;
globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (url === '/api/status') return Response.json({ chatgpt: { kind: 'signed_out' }, devLlm: true, voice: true });
  return new Response(new ReadableStream<Uint8Array>({ start(stream) { requests.push({ input: AgentRequest.parse(JSON.parse(String(init?.body))), signal: init?.signal, stream }); } }));
}, { preconnect: original.preconnect });
const { ConversationEngine } = await import('../../src/conversation/engine/conversation-engine');
const board = new BoardState();
const engine = new ConversationEngine({ getSummary: board.summary, apply: board.apply, showPending() {}, clearPending() {} });
const text = (text: string) => socketCallbacks?.onMessage({ type: 'text', text });
const audioCount = () => sent.filter(message => message.includes('"type":"audio"')).length;
try {
  await engine.startVoice(); microphone?.onFrame(new Uint8Array(3840)); expect(audioCount()).toBe(1);
  text('only four words here'); expect(engine.getSnapshot().partial).toBe('only four words here');
  engine.setMuted(true); expect(engine.getSnapshot().muted).toBe(true); expect(engine.getSnapshot().partial).toBe(''); expect(requests).toHaveLength(0);
  microphone?.onFrame(new Uint8Array(3840)); text('late pending text must be ignored.'); expect(audioCount()).toBe(1); expect(engine.getSnapshot().partial).toBe('');
  // Acknowledgement of the discard flush, while muted, does not revive the partial.
  socketCallbacks?.onMessage({ type: 'flushed', flush_id: 1 });
  const at = performance.now(); engine.setMuted(false); microphone?.onFrame(new Uint8Array(3840));
  expect(performance.now() - at).toBeLessThan(300); expect(audioCount()).toBe(2); expect(connections).toBe(1);
  text('draw a payment service here'); engine.setMuted(true);
  expect(requests).toHaveLength(1); expect(requests[0]?.input.utterance).toBe('draw a payment service here');
  expect(requests[0]?.signal?.aborted).toBe(false); // Muting leaves drawing in flight.
  socketCallbacks?.onMessage({ type: 'flushed', flush_id: 2 });
  socketCallbacks?.onClose(); await Bun.sleep(10); expect(connections).toBe(2);
  microphone?.onFrame(new Uint8Array(3840)); text('text during a muted reconnect'); expect(audioCount()).toBe(2); expect(engine.getSnapshot().muted).toBe(true);
  engine.setMuted(false); microphone?.onFrame(new Uint8Array(3840)); expect(audioCount()).toBe(3);
  requests[0]?.stream.enqueue(new TextEncoder().encode('{"type":"done"}\n')); requests[0]?.stream.close(); await Bun.sleep(10);
  engine.receivePhrase('Add checkout beside the payment service'); engine.finishSpokenStretch();
  requests[1]?.stream.enqueue(new TextEncoder().encode('{"type":"done"}\n')); requests[1]?.stream.close(); await Bun.sleep(10);
  const suggestion = requests.find(request => request.input.mode === 'suggest'); expect(suggestion).toBeDefined();
  engine.setMuted(true); expect(suggestion?.signal?.aborted).toBe(true);
  engine.stopVoice(); await engine.startVoice(); expect(engine.getSnapshot().muted).toBe(true);
  microphone?.onFrame(new Uint8Array(3840)); expect(audioCount()).toBe(3);
} finally { engine.stopVoice(); globalThis.fetch = original; }
