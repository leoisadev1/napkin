import { expect, mock } from 'bun:test';
const contexts: { sampleRate: number; state: string }[] = [];
Object.defineProperty(globalThis, 'AudioContext', { value: class {
  sampleRate: number; state = 'running';
  constructor(options?: AudioContextOptions) { this.sampleRate = options?.sampleRate ?? 48000; contexts.push(this); }
  async resume() {} async close() { this.state = 'closed'; }
} });
mock.module('../../src/voice/stt', () => ({ SpeechToText: class { setMuted() {} async connect() {} stop() {} resetPhrases() {} send() {} } }));
let captures = 0;
mock.module('../../src/voice/microphone', () => ({ listMicrophones: async () => [], captureMicrophone: async () => {
  if (++captures === 1) throw new DOMException('Unsupported capture rate', 'NotSupportedError'); return () => {};
} }));
const original = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json({ voice: true }), { preconnect: original.preconnect });
const { ConversationEngine } = await import('../../src/conversation/engine/conversation-engine');
const engine = new ConversationEngine({ getSummary: () => ({ title: '', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } }), apply() {}, showPending() {}, clearPending() {} });
await engine.startVoice(); expect(contexts.map(context => context.sampleRate)).toEqual([24000, 48000]); expect(contexts[0]?.state).toBe('closed'); expect(engine.getSnapshot().phase.kind).toBe('listening');
engine.stopVoice(); expect(contexts[1]?.state).toBe('closed'); globalThis.fetch = original;
