/** Real Gradium idle socket check: zero audio during mute, then immediate same-socket resume. */
import { z } from 'zod';
import { config } from './config';
import { openVoiceSocket } from '../src/voice/socket';
import { VoiceMessage } from '../src/voice/socket';
import { PCMResampler, decodePCM, toBase64 } from '../src/voice/pcm';
const original = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (input === '/api/gradium/token') {
    const response = await original('https://api.gradium.ai/api/api-keys/token', { headers: { 'x-api-key': config().GRADIUM_API_KEY }, signal: AbortSignal.timeout(10000) });
    return Response.json(z.object({ token: z.string(), expires_at: z.string() }).parse(await response.json()));
  }
  return original(input, init);
}, { preconnect: original.preconnect });
const abort = new AbortController(); const errors: string[] = []; let closed = false; let firstText: number | undefined;
const messages: VoiceMessage[] = [];
try {
  const socket = await openVoiceSocket({ endpoint: 'asr', signal: abort.signal, setup: { model_name: 'default', input_format: 'pcm', json_config: { language: 'en', delay_in_frames: 10 } }, onMessage: message => { messages.push(message); if (message.type === 'text') firstText ??= performance.now(); }, onError: error => errors.push(error.message), onClose: () => { closed = true; } });
  const mutedAt = performance.now();
  await Bun.sleep(35000);
  if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('Idle socket did not survive mute');
  const unmutedAt = performance.now();
  const converted = Bun.spawn(['ffmpeg', '-v', 'error', '-i', '/tmp/rtw-accuracy/sample-1.wav', '-ar', '48000', '-ac', '1', '-f', 's16le', '-'], { stdout: 'pipe', stderr: 'pipe' });
  const pcm = new Uint8Array(await new Response(converted.stdout).arrayBuffer()); if (await converted.exited) throw new Error('ffmpeg failed');
  const frames = new PCMResampler(48000).push(decodePCM(pcm));
  let firstFrame: number | undefined;
  for (const frame of [...frames, ...Array.from({ length: 20 }, () => new Uint8Array(3840))]) { firstFrame ??= performance.now(); socket.send(JSON.stringify({ type: 'audio', audio: toBase64(frame) })); await Bun.sleep(80); }
  const result = { idleMs: Math.round(unmutedAt - mutedAt), mutedAudioFrames: 0, sameSocket: !closed, unmuteToFirstFrameMs: Math.round((firstFrame ?? Infinity) - unmutedAt), firstTextMs: firstText === undefined ? null : Math.round(firstText - unmutedAt), text: messages.flatMap(message => message.type === 'text' ? [message.text] : []).join(' '), errors };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (errors.length || result.unmuteToFirstFrameMs >= 300 || !result.text.includes('habit')) throw new Error('Resume failed');
} finally { abort.abort(); globalThis.fetch = original; }
