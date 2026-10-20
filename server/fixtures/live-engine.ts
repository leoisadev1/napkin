import { expect, mock } from 'bun:test';
import { BoardOp } from '../../shared/board';
import { AgentRequest } from '../../shared/agent-protocol';
import type { BoardBridge } from '../../src/conversation/types';
import { BoardState } from '../board-state';
const requests: { input: AgentRequest; signal: AbortSignal | null | undefined; stream: ReadableStreamDefaultController<Uint8Array> }[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (String(input) === '/api/status') return Response.json({ voice: true });
  if (String(input) === '/api/agent') return new Response(new ReadableStream<Uint8Array>({ start(stream) {
    requests.push({ input: AgentRequest.parse(JSON.parse(String(init?.body))), signal: init?.signal, stream });
  } }));
  throw new Error('Unexpected fixture fetch');
}, { preconnect: originalFetch.preconnect });
let speech: { onPhrase?: (text: string) => void; onPartial: (text: string) => void; onTurn: (text: string) => void } | undefined;
mock.module('../../src/voice/stt', () => ({ SpeechToText: class {
  constructor(callbacks: NonNullable<typeof speech>) { speech = callbacks; }
  setMuted() {} async connect() {} send() {} stop() {} flushPhrases() {} resetPhrases() { speech?.onPartial(''); }
} }));
mock.module('../../src/voice/microphone', () => ({ listMicrophones: async () => [], captureMicrophone: async () => () => {} }));
mock.module('../../src/voice/tts', () => ({ TextToSpeech: class { constructor() { throw new Error('TTS must never open'); } } }));
Object.defineProperty(globalThis, 'AudioContext', { value: class { state = 'running'; async resume() {} async close() { this.state = 'closed'; } } });
const { ConversationEngine } = await import('../../src/conversation/engine/conversation-engine');
const board = new BoardState();
const bridge: BoardBridge = { getSummary: board.summary, apply: board.apply, showPending() {}, clearPending() {} };
const engine = new ConversationEngine(bridge, { pipeline: false }); await engine.startVoice();
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
expect(requests[1]?.input.history.some(turn => turn.text.includes('a habit tracker, with streaks, and reminders.'))).toBe(true);
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

// Pauses wait for all drawing, issue one suggestion pass, and never repeat without speech.
const paused = new ConversationEngine(bridge, { pipeline: false }); await paused.startVoice();
const base = requests.length;
speech?.onPhrase?.('Build a main screen');
speech?.onPhrase?.('with a habit list'); speech?.onTurn('');
expect(requests).toHaveLength(base + 1);
await finish(base); expect(requests[base + 1]?.input.mode).toBe('live');
await finish(base + 1);
expect(requests[base + 2]?.input.mode).toBe('refine'); await finish(base + 2);
expect(requests[base + 3]?.input.mode).toBe('suggest');
expect(requests[base + 3]?.input.utterance).toBe('Build a main screen with a habit list');
send(base + 3, '{"type":"suggestions","items":["Add reminders","Add streaks"]}\n'); await finish(base + 3);
speech?.onTurn(''); await Bun.sleep(1600);
expect(requests).toHaveLength(base + 4);
expect(paused.getSnapshot().suggestions).toEqual(['Add reminders', 'Add streaks']);
// Fallback silence also requests suggestions, and partial words cancel them immediately.
speech?.onPhrase?.('Add a check-in button'); await finish(base + 4); await Bun.sleep(1550);
expect(requests[base + 5]?.input.mode).toBe('refine'); await finish(base + 5);
expect(requests[base + 6]?.input.mode).toBe('suggest');
speech?.onPartial('And');
expect(requests[base + 6]?.signal?.aborted).toBe(true);
expect(paused.getSnapshot().suggestions).toEqual(['Add reminders', 'Add streaks']);
speech?.onPhrase?.('And a weekly chart');
expect(requests[base + 7]?.input.mode).toBe('live');
speech?.onPartial('with streaks');
expect(requests[base + 7]?.signal?.aborted).toBe(false);
// Canceling closes the stream so late events cannot replace chips.
expect(() => send(base + 6, '{"type":"suggestions","items":["Stale"]}\n')).toThrow();
expect(paused.getSnapshot().suggestions).toEqual(['Add reminders', 'Add streaks']);
await finish(base + 7); paused.stopVoice(); await Bun.sleep(1600);
expect(requests).toHaveLength(base + 8);

// Use the real chunker: its 350ms commit must not restart the 1.5s word-silence clock.
const { PhraseChunker } = await import('../../src/voice/phrase-chunker');
const timed = new ConversationEngine(bridge, { pipeline: false });
const chunker = new PhraseChunker({ onPartial: timed.receivePartial, onPhrase: timed.receivePhrase });
const timedBase = requests.length; const lastWord = performance.now();
chunker.addText('show all my habits for today');
await Bun.sleep(400); expect(requests[timedBase]?.input.mode).toBe('live'); await finish(timedBase);
await Bun.sleep(Math.max(0, 1650 - (performance.now() - lastWord)));
expect(requests[timedBase + 1]?.input.mode).toBe('refine');
expect(requests[timedBase + 2]?.input.mode).toBe('suggest');
timed.interrupt(); chunker.reset();

// Queue a follow-up before a mockup arrives; dispatch must include its actual components.
const screens = new ConversationEngine(bridge, { pipeline: false }); const screenBase = requests.length;
screens.receivePhrase('Draw a phone main screen'); screens.receivePhrase('Add a weekly chart');
const mockup = { op: 'add_mockup', id: 'main-screen', title: 'Main screen', device: 'phone', placement: { kind: 'auto' }, components: [
  { kind: 'header', label: 'Today' }, { kind: 'list', label: 'Read a chapter' }, { kind: 'button', label: 'Check in' }, { kind: 'tabbar', label: 'Today,Friends' },
] } satisfies import('../../shared/board').BoardOp;
send(screenBase, `${JSON.stringify({ type: 'op', op: mockup })}\n`); await finish(screenBase);
const screenContext = requests[screenBase + 1]?.input.history.find(turn => turn.role === 'assistant' && turn.text.startsWith('Current mockup: '));
if (!screenContext) throw new Error('Missing mockup context');
expect(BoardOp.parse(JSON.parse(screenContext.text.slice('Current mockup: '.length)))).toEqual(mockup);
screens.interrupt();
