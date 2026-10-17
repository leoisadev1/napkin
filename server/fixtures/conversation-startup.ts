import { mock } from 'bun:test';
import type { TextToSpeech } from '../../src/voice/tts';
import type { BoardBridge } from '../../src/conversation/types';
// Separate process: voice-device doubles cannot leak into other tests.
let captureReady: ((stop: () => void) => void) | undefined;
let speaking: (() => void) | undefined;
mock.module('../../src/voice/microphone', () => ({ captureMicrophone: () => new Promise<() => void>(resolve => { captureReady = resolve; }) }));
mock.module('../../src/voice/stt', () => ({ SpeechToText: class { async connect() {} stop() {} send() {} } }));
mock.module('../../src/voice/tts', () => ({ TextToSpeech: class {
  constructor(_context: AudioContext, callbacks: ConstructorParameters<typeof TextToSpeech>[1]) { speaking = callbacks.onSpeaking; }
  async connect() {} push() {} finish() {} stop() {}
} }));
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
const bridge: BoardBridge = { getSummary: () => ({ title: '', items: [], selection: [] }), apply() {}, showPending() {}, clearPending() {} };
const engine = new ConversationEngine(bridge);
const start = engine.startVoice();
for (let attempts = 0; attempts < 100 && !captureReady; attempts++) await Bun.sleep(1);
if (!captureReady) throw new Error('Microphone never started');
engine.sendText('Build a tracker');
if (engine.getSnapshot().phase.kind !== 'thinking') throw new Error('Typed turn must be thinking');
speaking?.();
if (engine.getSnapshot().phase.kind !== 'speaking') throw new Error('Playback must be speaking');
captureReady(() => {}); await start;
if (engine.getSnapshot().phase.kind !== 'speaking') throw new Error('Voice readiness overwrote active playback');
engine.stopVoice();
