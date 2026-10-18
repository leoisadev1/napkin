import { expect, mock } from 'bun:test';
import type { openVoiceSocket } from '../../src/voice/socket';
let callbacks: Parameters<typeof openVoiceSocket>[0] | undefined;
let connections = 0; let failure: Error | undefined;
const originalTimer = globalThis.setTimeout;
globalThis.setTimeout = Object.assign((callback: TimerHandler, ms?: number, ...args: unknown[]) => originalTimer(callback, Math.min(ms ?? 0, 10), ...args), originalTimer);
mock.module('../../src/voice/socket', () => ({ openVoiceSocket: async (args: Parameters<typeof openVoiceSocket>[0]) => {
  connections++;
  if (connections === 2 || connections === 3) throw new Error('Temporary token service failure');
  callbacks = args;
  return { readyState: WebSocket.OPEN, bufferedAmount: 0, send() {}, close() { args.onClose(); } };
} }));
const phrases: string[] = []; const states: string[] = [];
const { SpeechToText } = await import('../../src/voice/stt');
const stt = new SpeechToText({ onPartial() {}, onTurn() {}, onPhrase: text => phrases.push(text), onConnection: state => states.push(state), onError: error => { failure = error; } });
async function until(check: () => boolean) { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(2); expect(check()).toBe(true); }
try {
  await stt.connect();
  callbacks?.onMessage({ type: 'text', text: 'add payments' });
  callbacks?.onClose();
  await until(() => connections === 4);
  expect(failure).toBeUndefined(); expect(phrases).toEqual(['add payments']); expect(states.at(-1)).toBe('listening');
  callbacks?.onMessage({ type: 'text', text: 'after reconnect.' }); callbacks?.onMessage({ type: 'end_text' });
  expect(phrases.at(-1)).toBe('after reconnect.');
  // Missing acknowledgement previously called stop() permanently. Now rotate the socket.
  stt.resetPhrases();
  await until(() => connections === 5);
  expect(failure).toBeUndefined();
  stt.stop(); const stoppedAt = connections;
  await Bun.sleep(40); expect(connections).toBe(stoppedAt);
} finally { stt.stop(); globalThis.setTimeout = originalTimer; }
