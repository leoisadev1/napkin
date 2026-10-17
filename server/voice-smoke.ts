import { z } from 'zod';
import { config } from './config';
import { VoiceMessage } from '../src/voice/socket';
import { decodePCM, PCMResampler, fromBase64, toBase64 } from '../src/voice/pcm';

async function token() {
  const response = await fetch('https://api.gradium.ai/api/api-keys/token', { headers: { 'x-api-key': config().GRADIUM_API_KEY }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Token mint failed: ${response.status}`);
  return z.object({ token: z.string().min(1), expires_at: z.string() }).parse(await response.json()).token;
}
export async function voiceSession(args: { endpoint: 'tts' | 'asr'; setup: object; send: (socket: WebSocket) => Promise<void>; receive: (message: VoiceMessage) => void }) {
  const url = new URL(`wss://api.gradium.ai/api/speech/${args.endpoint}`); url.searchParams.set('token', await token());
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    let complete = false;
    const timer = setTimeout(() => { reject(new Error('Voice smoke timed out')); socket.close(); }, 30_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'setup', ...args.setup }));
    socket.onmessage = event => {
      try {
        if (typeof event.data !== 'string') return;
        const parsed = VoiceMessage.safeParse(JSON.parse(event.data)); if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === 'error') throw new Error(message.message);
        if (message.type === 'ready') void args.send(socket).catch(reject);
        args.receive(message);
        if (message.type === 'end_of_stream') { complete = true; clearTimeout(timer); resolve(); socket.close(); }
      } catch (error) { clearTimeout(timer); reject(error); socket.close(); }
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Voice smoke socket error')); };
    socket.onclose = () => { clearTimeout(timer); if (!complete) reject(new Error('Voice smoke closed before EOS')); };
  });
}
export async function voiceSmoke() {
  if (!config().GRADIUM_API_KEY) { process.stdout.write('SKIP: GRADIUM_API_KEY unset\n'); return; }
  const sentence = 'Build a habit tracker with daily reminders.';
  const audio: Uint8Array[] = []; let sentAt = 0; let ttfa: number | undefined;
  await voiceSession({ endpoint: 'tts', setup: { voice_id: 'YTpq7expH9539ERJ', model_name: 'default', output_format: 'pcm' },
    send: async socket => { sentAt = performance.now(); socket.send(JSON.stringify({ type: 'text', text: `${sentence} <flush>` })); socket.send(JSON.stringify({ type: 'end_of_stream' })); },
    receive: message => { if (message.type === 'audio') { ttfa ??= performance.now() - sentAt; audio.push(fromBase64(message.audio)); } },
  });
  const resampler = new PCMResampler(48000);
  const frames = audio.flatMap(bytes => resampler.push(decodePCM(bytes)));
  const duration = audio.reduce((sum, bytes) => sum + bytes.length, 0) / 96000;
  const transcript: string[] = []; let sttStart = 0; let firstText: number | undefined;
  await voiceSession({ endpoint: 'asr', setup: { model_name: 'default', input_format: 'pcm', json_config: { language: 'en', delay_in_frames: 8 } },
    send: async socket => {
      sttStart = performance.now();
      for (const frame of [...frames, ...Array.from({ length: 12 }, () => new Uint8Array(3840))]) {
        socket.send(JSON.stringify({ type: 'audio', audio: toBase64(frame) })); await Bun.sleep(80);
      }
      socket.send(JSON.stringify({ type: 'end_of_stream' }));
    },
    receive: message => { if (message.type === 'text') { firstText ??= performance.now() - sttStart; transcript.push(message.text); } },
  });
  const text = transcript.join(' ');
  const normalized = text.toLowerCase();
  const matched = ['habit', 'tracker', 'reminders'].filter(word => normalized.includes(word)).length;
  const result = { tokenMint: 'PASS', tts: audio.length > 0 ? 'PASS' : 'FAIL', stt: matched === 3 ? 'PASS' : 'FAIL', ttfaMs: Math.round(ttfa ?? -1), sttFirstTextMs: Math.round(firstText ?? -1), durationSeconds: duration, transcript: text };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!audio.length || matched !== 3) throw new Error('Voice smoke transcript mismatch');
}
if (import.meta.main) await voiceSmoke();
