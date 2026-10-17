import { mock } from 'bun:test';
import type { openVoiceSocket } from '../../src/voice/socket';
let callbacks: Parameters<typeof openVoiceSocket>[0] | undefined;
let connections = 0; let failure: Error | undefined; let sent = 0;
mock.module('../../src/voice/socket', () => ({ openVoiceSocket: async (args: Parameters<typeof openVoiceSocket>[0]) => {
  callbacks = args; connections++;
  return { readyState: WebSocket.OPEN, bufferedAmount: 0, send() { sent++; }, close() {} };
} }));
const originalNow = Date.now;
let elapsed = 0;
Date.now = () => originalNow() + elapsed;
const { SpeechToText } = await import('../../src/voice/stt');
const stt = new SpeechToText({ onPartial() {}, onTurn() {}, onBargeIn() {}, onError(error) { failure = error; } });
async function disconnect() {
  const before = connections;
  callbacks?.onClose();
  for (let attempt = 0; attempt < 1800 && connections === before && !failure; attempt++) await Bun.sleep(1);
  if (failure) throw failure;
  if (connections !== before + 1) throw new Error('Reconnect did not happen');
}
try {
  await stt.connect();
  await disconnect(); await disconnect(); await disconnect();
  if (process.argv[2] === 'healthy') {
    elapsed += 30_001;
    stt.send(new Uint8Array([0, 0]));
    if (sent !== 1) throw new Error('Audio not sent');
    await disconnect();
  } else {
    callbacks?.onClose();
    if (!failure) throw new Error('Rapid reconnect failures must exhaust the budget');
  }
} finally { stt.stop(); Date.now = originalNow; }
