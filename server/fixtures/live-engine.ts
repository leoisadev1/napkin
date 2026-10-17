import { expect, mock } from 'bun:test';
import { AgentRequest } from '../../shared/agent-protocol';
import type { BoardBridge } from '../../src/conversation/types';
import { BoardState } from '../board-state';
const requests: { input: AgentRequest; signal: AbortSignal | null | undefined; stream: ReadableStreamDefaultController<Uint8Array> }[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (String(input) === '/api/status') return Response.json({ chatgpt: { kind: 'signed_out' }, devLlm: true, voice: true });
  if (String(input) === '/api/agent') return new Response(new ReadableStream<Uint8Array>({ start(stream) {
    requests.push({ input: AgentRequest.parse(JSON.parse(String(init?.body))), signal: init?.signal, stream });
  } }));
  throw new Error('Unexpected fixture fetch');
}, { preconnect: originalFetch.preconnect });
let speech: { onPhrase?: (text: string) => void; onPartial: (text: string) => void; onTurn: (text: string) => void } | undefined;
mock.module('../../src/voice/stt', () => ({ SpeechToText: class {
  constructor(callbacks: NonNullable<typeof speech>) { speech = callbacks; }
  async connect() {} send() {} stop() {} resetPhrases() { speech?.onPartial(''); }
} }));
mock.module('../../src/voice/microphone', () => ({ captureMicrophone: async () => () => {} }));
mock.module('../../src/voice/tts', () => ({ TextToSpeech: class { constructor() { throw new Error('TTS must never open'); } } }));
Object.defineProperty(globalThis, 'AudioContext', { value: class { state = 'running'; async resume() {} async close() { this.state = 'closed'; } } });
const { ConversationEngine } = await import('../../src/conversation/engine/conversation-engine');
const board = new BoardState();
const bridge: BoardBridge = { getSummary: board.summary, apply: board.apply, showPending() {}, clearPending() {} };
const engine = new ConversationEngine(bridge); await engine.startVoice();
const send = (index: number, data: string) => requests[index]?.stream.enqueue(new TextEncoder().encode(data));
const finish = async (index: number) => { send(index, '{"type":"done"}\n'); requests[index]?.stream.close(); await Bun.sleep(5); };
speech?.onPhrase?.('a habit tracker,');
expect(requests).toHaveLength(1); expect(engine.getSnapshot().sketching).toBe(true); expect(engine.getSnapshot().phase.kind).toBe('listening');
speech?.onPartial('still speaking'); speech?.onPhrase?.('with streaks,'); speech?.onPhrase?.('and reminders.');
expect(requests).toHaveLength(1); expect(requests[0]?.signal?.aborted).toBe(false);
expect(engine.getSnapshot().transcript.filter(t => t.role === 'user')).toHaveLength(1);
send(0, '{"type":"op","op":{"op":"set_title","title":"Habits"}}\n'); await finish(0);
expect(requests).toHaveLength(2); expect(requests[1]?.input.utterance).toBe('with streaks, and reminders.');
expect(requests[1]?.input.mode).toBe('live'); expect(requests[1]?.input.board.title).toBe('Habits');
expect(requests[1]?.input.history).toEqual([{ role: 'user', text: 'a habit tracker,' }]);
speech?.onTurn(''); speech?.onPhrase?.('social feed.'); expect(engine.getSnapshot().transcript.filter(t => t.role === 'user')).toHaveLength(2);
engine.interrupt(); expect(requests[1]?.signal?.aborted).toBe(true); await Bun.sleep(5);
expect(requests).toHaveLength(2); expect(engine.getSnapshot().sketching).toBe(false); expect(engine.getSnapshot().partial).toBe('');
engine.pickSuggestion('Add stats'); expect(requests[2]?.input.mode).toBe('turn');
expect(requests[2]?.input.history.some(turn => turn.text === 'social feed.')).toBe(false);
send(2, '{"type":"suggestions","items":["Add a calendar"]}\n'); await finish(2);
expect(engine.getSnapshot().suggestions).toEqual(['Add a calendar']);
expect(engine.getSnapshot().transcript.filter(t => t.role === 'assistant')).toHaveLength(0);
// A long queue must stay below the protocol limit and still drain in order.
engine.receivePhrase('first'); engine.receivePhrase('a'.repeat(3000)); engine.receivePhrase('b'.repeat(3000)); await finish(3);
expect(requests[4]?.input.utterance.length).toBe(3000); await finish(4); expect(requests[5]?.input.utterance.length).toBe(3000); await finish(5);
engine.stopVoice();
