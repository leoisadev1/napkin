/** Real Gradium TTS -> WAV -> real-time PCM -> STT -> production chunker/queue -> agent. No browser/server port. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { voiceSession } from './voice-smoke';
import { PCMResampler, decodePCM, fromBase64 } from '../src/voice/pcm';
import { SpeechToText } from '../src/voice/stt';
import { ConversationEngine } from '../src/conversation/engine/conversation-engine';
import { AgentRequest } from '../shared/agent-protocol';
import { BoardState } from './board-state';
import { handleRequest } from './index';

const description = "So it's a habit tracker, with streaks, and daily reminders at a time you pick. Maybe I can check in each morning, and see how I'm doing, plus a small social feed for friends.";
const evidence = process.env.RTW_EVIDENCE_DIR ?? '/tmp/rtw-live-evidence'; await mkdir(evidence, { recursive: true });
let wav = process.env.RTW_SIMULATION_WAV;
if (!wav) {
  const audio: Uint8Array[] = [];
  await voiceSession({ endpoint: 'tts', setup: { voice_id: 'YTpq7expH9539ERJ', model_name: 'default', output_format: 'pcm' }, send: async socket => {
    socket.send(JSON.stringify({ type: 'text', text: `${description} <flush>` })); socket.send(JSON.stringify({ type: 'end_of_stream' }));
  }, receive: message => { if (message.type === 'audio') audio.push(fromBase64(message.audio)); } });
  const pcm = Buffer.concat(audio); if (!pcm.length) throw new Error('No generated audio');
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  wav = join(evidence, 'description.wav'); await Bun.write(wav, Buffer.concat([header, pcm]));
}
const wavBytes = new Uint8Array(await Bun.file(wav).arrayBuffer());
const pcm = wavBytes.subarray(44);
const frames = new PCMResampler(48000).push(decodePCM(wavBytes.subarray(44)));
type Measurement = { phrase: string; firstWordAt: number; lastWordAt: number; committedAt: number; requestAt?: number; firstOpAt?: number };
const suggestionRequests: { at: number; utterance: string }[] = [];
const suggestionArrivals: { at: number; items: string[] }[] = [];
const measurements: Measurement[] = []; let awaiting: Measurement[] = []; let drawing: Measurement[] = [];
const board = new BoardState();
let audioStartedAt: number | undefined; let opsWhileAudioPlaying = 0;
const engine = new ConversationEngine({ getSummary: board.summary, apply: op => {
  const now = performance.now();
  if (audioStartedAt !== undefined && now < audioStartedAt + pcm.length / 96) opsWhileAudioPlaying++;
  for (const row of drawing) row.firstOpAt ??= now; board.apply(op);
}, showPending() {}, clearPending() {} });
let previousSuggestions = engine.getSnapshot().suggestions;
engine.subscribe(() => {
  const items = engine.getSnapshot().suggestions;
  if (items !== previousSuggestions) { previousSuggestions = items; suggestionArrivals.push({ at: performance.now(), items }); }
});
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (typeof input === 'string' && input.startsWith('/api/')) {
    if (input === '/api/agent') {
      const request = AgentRequest.parse(JSON.parse(String(init?.body)));
      if (request.mode === 'suggest') suggestionRequests.push({ at: performance.now(), utterance: request.utterance });
      else {
        drawing = []; let length = 0;
        while (awaiting[0] && length < request.utterance.length) {
          const row = awaiting.shift(); if (row) { row.requestAt = performance.now(); drawing.push(row); length += row.phrase.length + (length ? 1 : 0); }
        }
      }
    }
    return handleRequest(new Request(`http://simulation${input}`, init));
  }
  return originalFetch(input, init);
}, { preconnect: originalFetch.preconnect });
let firstWordAt: number | undefined; let lastWordAt = 0; let ended = false;
const stt = new SpeechToText({ onPartial: text => {
  if (text) { firstWordAt ??= performance.now(); lastWordAt = performance.now(); }
  engine.receivePartial(text);
}, onPhrase: phrase => {
  const row: Measurement = { phrase, firstWordAt: firstWordAt ?? performance.now(), lastWordAt, committedAt: performance.now() };
  firstWordAt = undefined; measurements.push(row); awaiting.push(row); engine.receivePhrase(phrase);
}, onTurn: () => { ended = true; engine.finishSpokenStretch(); }, onError: error => { throw error; } });
try {
  await stt.connect();
  audioStartedAt = performance.now();
  for (const frame of [...frames, ...Array.from({ length: 32 }, () => new Uint8Array(3840))]) { stt.send(frame); await Bun.sleep(80); }
  const limit = performance.now() + 45_000;
  while ((!ended || engine.getSnapshot().sketching || awaiting.length || !suggestionArrivals.length) && performance.now() < limit) await Bun.sleep(50);
  if (engine.getSnapshot().sketching || awaiting.length) throw new Error('Simulation did not drain');
  const rows = measurements.map(row => ({ phrase: row.phrase, commitMs: Math.round(row.committedAt - row.lastWordAt), queueMs: row.requestAt === undefined ? null : Math.round(row.requestAt - row.committedAt), lastWordToOpMs: row.firstOpAt === undefined ? null : Math.round(row.firstOpAt - row.lastWordAt), firstWordToOpMs: row.firstOpAt === undefined ? null : Math.round(row.firstOpAt - row.firstWordAt), requestToOpMs: row.firstOpAt === undefined || row.requestAt === undefined ? null : Math.round(row.firstOpAt - row.requestAt) }));
  const result = { wav, opsWhileAudioPlaying, audioSeconds: pcm.length / 96000,
    suggestionRequests: suggestionRequests.map(row => ({ ...row, at: Math.round(row.at - (audioStartedAt ?? 0)) })),
    suggestionArrivals: suggestionArrivals.map(row => ({ ...row, at: Math.round(row.at - (audioStartedAt ?? 0)) })), model: process.env.DEV_LLM_MODEL, rows, board: board.summary() };
  await Bun.write(join(evidence, 'simulation.json'), JSON.stringify(result, null, 2)); process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!suggestionArrivals.some(row => row.items.length >= 2)) throw new Error('No pause suggestions arrived');
  if (!opsWhileAudioPlaying || measurements.length < 2 || measurements.some(row => row.firstOpAt === undefined)) throw new Error('Some phrases produced no operations');
} finally { stt.stop(); engine.interrupt(); globalThis.fetch = originalFetch; }
