/** Reproducible REST TTS WAV corpus -> actual streaming resampler -> real-time STT matrix. */
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { config } from './config';
import { voiceSession } from './voice-smoke';
import { PCMResampler, decodePCM, toBase64 } from '../src/voice/pcm';
const dir = process.env.RTW_EVIDENCE_DIR ?? '/tmp/rtw-accuracy'; await mkdir(dir, { recursive: true });
const headers = { 'x-api-key': config().GRADIUM_API_KEY, 'content-type': 'application/json' };
const voicesResponse = await fetch('https://api.gradium.ai/api/voices/', { headers, signal: AbortSignal.timeout(10000) });
const raw: unknown = await voicesResponse.json();
const list = z.array(z.object({ uid: z.string(), language: z.string().optional() })).safeParse(raw);
const voices = process.env.RTW_TEST_VOICES?.split(',') ?? (list.success ? list.data.filter(v => !v.language || v.language === 'en').map(v => v.uid).slice(0, 3) : ['YTpq7expH9539ERJ']);
if (!voices.length) voices.push('YTpq7expH9539ERJ');
const scripts = [
  'Cat Simulator, a Roblox game. Brainstorm a progression system with XP and prestige. Earn coins, upgrade your cat, unlock new areas, and repeat with harder tasks.',
  'A habit tracker called Streakly, with daily reminders and a weekly progress chart.',
  'Integrate Roblox, Supabase, and PostgreSQL with an onboarding flow for new players.',
  'Our roadmap starts with a prototype in October, beta in November, and launch in December.',
  'Cat Simulator needs a progression system with XP and prestige, rare cats, quests, and new worlds.',
];
function words(text: string) { return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/); }
export function wordErrors(reference: string, actual: string) {
  const a = words(reference), b = words(actual); let row = b.map((_, i) => i + 1); row.unshift(0);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min((next[j - 1] ?? 0) + 1, (row[j] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; }
  return { errors: row[b.length] ?? 0, words: a.length };
}
const corpus: { script: string; voice: string; frames: Uint8Array[] }[] = [];
for (const [i, script] of scripts.entries()) {
  const voice = voices[i % voices.length] ?? voices[0] ?? 'YTpq7expH9539ERJ';
  const path = process.env.RTW_REUSE_CORPUS === '1' ? `${dir}/sample-${i}.wav` : `${dir}/sample-${i}-${voice}.wav`;
  if (!await Bun.file(path).exists()) {
    const response = await fetch('https://api.gradium.ai/api/post/speech/tts', { method: 'POST', headers, body: JSON.stringify({ text: script, voice_id: voice, output_format: 'wav', only_audio: true }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`TTS ${response.status}`); await Bun.write(path, await response.arrayBuffer());
  }
  const converted = Bun.spawn(['ffmpeg', '-v', 'error', '-i', path, '-ar', '48000', '-ac', '1', '-f', 's16le', '-'], { stdout: 'pipe', stderr: 'pipe' });
  const pcm = new Uint8Array(await new Response(converted.stdout).arrayBuffer()); if (await converted.exited) throw new Error('ffmpeg failed');
  corpus.push({ script, voice, frames: new PCMResampler(48000).push(decodePCM(pcm)) });
}
const rows = [];
for (const delay of (process.env.RTW_TEST_DELAYS?.split(',').map(Number) ?? [8, 16, 24])) for (const boost of (process.env.RTW_TEST_BOOSTS?.split(',').map(Number) ?? [0, 3])) for (const [i, sample] of corpus.entries()) {
  if (process.env.RTW_TEST_SAMPLES && !process.env.RTW_TEST_SAMPLES.split(',').map(Number).includes(i)) continue;
  const dictionary = ['Cat', 'cat', 'Simulator', 'Roblox', 'Streakly', 'Supabase', 'PostgreSQL', 'XP', 'prestige'];
  const keywords = process.env.RTW_TEST_CASE_VARIANTS === '1' ? [...new Set(dictionary.flatMap(word => [word, word.toLowerCase()]))] : dictionary;
  const transcript: string[] = []; let started = 0; let first: number | undefined;
  await voiceSession({ endpoint: 'asr', setup: { model_name: 'default', input_format: 'pcm', json_config: { language: 'en', delay_in_frames: delay, ...(boost ? { keywords: { words: keywords, boost } } : {}) } },
    send: async socket => { started = performance.now(); for (const frame of [...sample.frames, ...Array.from({ length: 30 }, () => new Uint8Array(3840))]) { socket.send(JSON.stringify({ type: 'audio', audio: toBase64(frame) })); await Bun.sleep(80); } socket.send(JSON.stringify({ type: 'end_of_stream' })); },
    receive: message => { if (message.type === 'text') { first ??= performance.now() - started; transcript.push(message.text); } },
  });
  const text = transcript.join(' '); const row = { keywords: boost ? keywords : [], sample: i, voice: sample.voice, delay, boost, firstTextMs: Math.round(first ?? -1), ...wordErrors(sample.script, text), transcript: text }; rows.push(row);
  await Bun.write(`${dir}/${process.env.RTW_TEST_RESULT ?? 'accuracy'}.json`, JSON.stringify({ voicesStatus: voicesResponse.status, voices, rows }, null, 2)); process.stdout.write(`${JSON.stringify(row)}\n`);
}
