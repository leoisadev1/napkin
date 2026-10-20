import { mock } from 'bun:test';
import type { BoardBridge } from '../../src/conversation/types';
// Separate process: voice-device doubles cannot leak into other tests.
let captureReady: ((stop: () => void) => void) | undefined;

mock.module('../../src/voice/microphone', () => ({ listMicrophones: async () => [], unlockMicrophones: async () => [], captureMicrophone: () => new Promise<() => void>(resolve => { captureReady = resolve; }) }));
mock.module('../../src/voice/stt', () => ({ SpeechToText: class { setMuted() {} async connect() {} stop() {} resetPhrases() {} send() {} } }));
Object.defineProperty(globalThis, 'AudioContext', { value: class {
  state = 'running'; async resume() {} async close() { this.state = 'closed'; }
} });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
  if (String(input) === '/api/status') return Response.json({ chatgpt: { kind: 'signed_out' }, devLlm: true, voice: true });
  if (String(input) === '/api/agent') return new Response(new ReadableStream<Uint8Array>());
  throw new Error('Unexpected fixture fetch');
}, { preconnect: originalFetch.preconnect });
const { ConversationEngine } = await import('../../src/conversation/engine/conversation-engine');
const bridge: BoardBridge = { getSummary: () => ({ title: '', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } }), apply() {}, showPending() {}, clearPending() {} };
const engine = new ConversationEngine(bridge);
const start = engine.startVoice();
for (let attempts = 0; attempts < 100 && !captureReady; attempts++) await Bun.sleep(1);
if (!captureReady) throw new Error('Microphone never started');
engine.sendText('Build a tracker');
if (!engine.getSnapshot().sketching) throw new Error('Typed turn must be sketching');
captureReady(() => {}); await start;
if (engine.getSnapshot().phase.kind !== 'listening' || !engine.getSnapshot().sketching) throw new Error('Voice readiness must listen while sketching');
engine.stopVoice();
