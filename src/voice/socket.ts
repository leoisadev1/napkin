import { z } from 'zod';
import { diagnostic, voiceFailureCategory } from './diagnostics';
export const VoiceMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('audio'), audio: z.string() }),
  z.object({ type: z.literal('text'), text: z.string(), start_s: z.number().optional() }),
  z.object({ type: z.literal('end_text') }),
  z.object({ type: z.literal('step'), vad: z.array(z.object({ inactivity_prob: z.number().min(0).max(1) })) }),
  z.object({ type: z.literal('flushed'), flush_id: z.number() }),
  z.object({ type: z.literal('end_of_stream') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type VoiceMessage = z.infer<typeof VoiceMessage>;
export async function openVoiceSocket(args: {
  endpoint: 'tts' | 'asr'; setup: object; signal: AbortSignal;
  onMessage: (message: VoiceMessage) => void; onClose: () => void; onError: (error: Error) => void;
}): Promise<WebSocket> {
  args.signal.throwIfAborted();
  const response = await fetch('/api/gradium/token', { signal: AbortSignal.any([args.signal, AbortSignal.timeout(10_000)]), credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not start voice (${response.status})`);
  const { token } = z.object({ token: z.string().min(1), expires_at: z.string() }).parse(await response.json());
  args.signal.throwIfAborted();
  const url = new URL(`wss://api.gradium.ai/api/speech/${args.endpoint}`); url.searchParams.set('token', token);
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => { reject(new Error('Voice connection timed out')); socket.close(); }, 10_000);
    const abort = () => { reject(new DOMException('Aborted', 'AbortError')); socket.close(); };
    args.signal.addEventListener('abort', abort, { once: true });
    socket.onopen = () => { diagnostic('socket.open', { endpoint: args.endpoint }); socket.send(JSON.stringify({ ...args.setup, type: 'setup' })); };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      try {
        if (typeof event.data !== 'string') return;
        const parsed = VoiceMessage.safeParse(JSON.parse(event.data));
        if (!parsed.success) return; // Ignore unrelated timestamps/usage and future message variants.
        const message = parsed.data;
        if (message.type === 'error') { diagnostic('socket.provider_error', { endpoint: args.endpoint, reason: voiceFailureCategory(message.message) }); throw new Error(message.message); }
        if (message.type === 'ready') { ready = true; clearTimeout(timer); resolve(socket); }
        args.onMessage(message);
      } catch (error) { const failure = error instanceof Error ? error : new Error('Invalid voice message'); reject(failure); args.onError(failure); socket.close(); }
    };
    socket.onerror = () => { const error = new Error('Voice connection failed'); reject(error); args.onError(error); socket.close(); };
    socket.onclose = event => { diagnostic('socket.close', { endpoint: args.endpoint, code: event.code, reason: voiceFailureCategory(event.reason), clean: event.wasClean }); clearTimeout(timer); args.signal.removeEventListener('abort', abort); if (!ready) reject(new Error('Voice connection closed')); args.onClose(); };
  });
}
