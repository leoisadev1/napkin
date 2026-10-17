import { mock } from 'bun:test';
import type { BoardBridge } from '../../src/conversation/types';
let failVoice: ((error: Error) => void) | undefined;
let connections = 0; let stopped = 0; let micStopped = 0; let closed = 0;
mock.module('../../src/voice/microphone', () => ({ captureMicrophone: async () => () => { micStopped++; } }));
mock.module('../../src/voice/stt', () => ({ SpeechToText: class {
  constructor(callbacks: { onError: (error: Error) => void }) { failVoice = callbacks.onError; }
  async connect() { connections++; if (process.argv[2] === 'connect' && connections === 1) throw new Error('STT connect failed'); }
  stop() { stopped++; } resetPhrases() {} send() {}
} }));
Object.defineProperty(globalThis, 'AudioContext', { value: class {
  state = 'running'; async resume() {} async close() { closed++; this.state = 'closed'; }
} });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
  if (String(input) === '/api/status') return Response.json({ chatgpt: { kind: 'signed_out' }, devLlm: true, voice: true });
  if (String(input) === '/api/agent') {
    if (process.argv[2] === 'agent') return new Response('{"type":"error","message":"Agent failed"}\n');
    return new Response(new ReadableStream<Uint8Array>());
  }
  throw new Error('Unexpected fixture fetch');
}, { preconnect: originalFetch.preconnect });
const { ConversationEngine } = await import('../../src/conversation/engine/conversation-engine');
const bridge: BoardBridge = { getSummary: () => ({ title: '', items: [], selection: [] }), apply() {}, showPending() {}, clearPending() {} };
const engine = new ConversationEngine(bridge);
await engine.startVoice();
if (process.argv[2] !== 'connect') engine.sendText('Build a tracker');
if (process.argv[2] === 'stt') failVoice?.(new Error('STT failed'));
for (let attempt = 0; attempt < 100 && engine.getSnapshot().phase.kind !== 'error'; attempt++) await Bun.sleep(1);
if (engine.getSnapshot().phase.kind !== 'error') throw new Error('Expected voice error');
await engine.startVoice();
if (connections !== 2 || stopped !== 1 || micStopped !== (process.argv[2] === 'connect' ? 0 : 1) || closed !== 1) throw new Error(`Retry did not replace session: ${JSON.stringify({ connections, stopped, micStopped, closed })}`);
if (engine.getSnapshot().phase.kind !== 'listening') throw new Error('Retry did not restore listening');
engine.stopVoice();
