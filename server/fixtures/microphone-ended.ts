import { expect } from 'bun:test';
import { captureMicrophone } from '../../src/voice/microphone';
let finishModule: (() => void) | undefined;
let ended = 0; let stopped = 0; let modules = 0;
class Track {
  readyState = 'live'; muted = false;
  onended: (() => void) | null = null; onmute = null; onunmute = null;
  stop() { stopped++; this.readyState = 'ended'; }
}
let track = new Track();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } } });
const node = () => ({ connect() {}, disconnect() {} });
Object.defineProperty(globalThis, 'AudioContext', { value: class {
  sampleRate = 24000; destination = node();
  audioWorklet = { addModule: () => new Promise<void>(resolve => { modules++; if (modules > 1) throw new DOMException("Processor already registered", "NotSupportedError"); finishModule = resolve; }) };
  createGain() { return { ...node(), gain: { value: 0 } }; }
  createMediaStreamSource() { return node(); }
} });
Object.defineProperty(globalThis, 'AudioWorkletNode', { value: class { port = { onmessage: null }; connect() {} disconnect() {} } });
const args = { context: new AudioContext(), onFrame() {}, onLevel() {}, onEnded() { ended++; } };
const initial = captureMicrophone(args);
await Bun.sleep(0); track.readyState = 'ended'; track.onended?.(); finishModule?.();
await expect(initial).rejects.toThrow('Microphone disconnected while starting');
expect(ended).toBe(0); expect(stopped).toBe(1);
track = new Track(); const next = captureMicrophone(args); await Bun.sleep(0); finishModule?.();
const stop = await next; expect(modules).toBe(1); track.onended?.(); expect(ended).toBe(1); stop(); expect(stopped).toBe(2); expect(track.onended).toBeNull();
