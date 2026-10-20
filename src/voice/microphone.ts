import { z } from 'zod';
import { diagnostic, debugControl } from './diagnostics';
import { PCMResampler, rms } from './pcm';

const workletSource = `class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) this.port.postMessage(input.slice());
    return true;
  }
}
registerProcessor('rtw-capture', Capture);`;
const captureModules = new WeakMap<AudioContext, Promise<void>>();
function initializeCapture(context: AudioContext) {
  const loaded = captureModules.get(context);
  if (loaded) return loaded;
  const blob = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
  const loading = context.audioWorklet.addModule(blob).catch(error => { captureModules.delete(context); throw error; }).finally(() => URL.revokeObjectURL(blob));
  captureModules.set(context, loading);
  return loading;
}
export type MicDevice = { id: string; label: string };
/** Real inputs, without the "default"/"communications" aliases that point at one of them. */
export async function listMicrophones(): Promise<(MicDevice & { group: string })[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications' && device.deviceId !== '')
    .map((device, index) => ({ id: device.deviceId, group: device.groupId, label: device.label || `Microphone ${index + 1}` }));
}
const constraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
async function openStream(deviceId: string | undefined) {
  if (!deviceId) return navigator.mediaDevices.getUserMedia({ audio: constraints });
  try { return await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: { exact: deviceId } } }); }
  catch (error) {
    // A remembered mic that is gone (an unplugged headset, an iPhone out of range) falls back to the system default.
    if (error instanceof DOMException && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) { diagnostic('mic.fallback', { reason: error.name }); return navigator.mediaDevices.getUserMedia({ audio: constraints }); }
    throw error;
  }
}
/** How long an open mic may deliver nothing but exact zeros (a muted track does too) before it counts as dead. Real mics always carry some noise. */
const DEAD_AFTER_MS = 4000;
export async function captureMicrophone(args: { context: AudioContext; deviceId?: string; onFrame: (frame: Uint8Array<ArrayBuffer>) => void; onLevel: (level: number) => void; onEnded?: () => void;
  onDevice?: (device: { id: string; group: string; label: string }) => void; onDead?: (device: { id: string; group: string; label: string; muted: boolean }) => void }) {
  const { context, onFrame, onLevel } = args;
  const stream = await openStream(args.deviceId);
  const tracks = stream.getAudioTracks();
  const settings = tracks[0]?.getSettings?.();
  const device = { id: settings?.deviceId ?? '', group: settings?.groupId ?? '', label: tracks[0]?.label ?? '' };
  args.onDevice?.(device);
  let capturing = false;
  let lastSound = performance.now();
  let silenced = false;
  let reportedDead = false;
  for (const track of tracks) {
    diagnostic('mic.track', { state: track.readyState, muted: track.muted });
    track.onended = () => { diagnostic('mic.ended'); if (capturing) args.onEnded?.(); };
    track.onmute = () => diagnostic('mic.mute');
    track.onunmute = () => { diagnostic('mic.unmute'); lastSound = performance.now(); reportedDead = false; };
  }
  const removeEnd = debugControl('endMic', () => { for (const track of tracks) { track.stop(); track.dispatchEvent(new Event('ended')); } });
  const removeSilence = debugControl('silenceMic', () => { silenced = true; lastSound = -Infinity; });
  const removeDebug = () => { removeEnd(); removeSilence(); };
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  const mute = context.createGain(); mute.gain.value = 0;
  // A Continuity iPhone mic that drops away often leaves the track "live" but silent, so watch the samples too.
  const watchdog = setInterval(() => {
    if (!capturing || reportedDead) return;
    if (context.state !== 'running' || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) { lastSound = performance.now(); return; }
    if (performance.now() - lastSound < DEAD_AFTER_MS) return;
    const muted = tracks.every(track => track.muted);
    reportedDead = true; diagnostic('mic.silent', { muted }); args.onDead?.({ ...device, muted });
  }, 1000);
  try {
    source = context.createMediaStreamSource(stream);
    await initializeCapture(context);
    node = new AudioWorkletNode(context, 'rtw-capture');
    const resampler = new PCMResampler(context.sampleRate);
    let lastLevel = 0;
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      const samples = z.instanceof(Float32Array).parse(event.data);
      for (const frame of resampler.push(samples)) onFrame(frame);
      if (!silenced && samples.some(sample => sample !== 0)) lastSound = performance.now();
      if (performance.now() - lastLevel >= 32) { onLevel(rms(samples)); lastLevel = performance.now(); }
    };
    if (tracks.some(track => track.readyState === 'ended')) throw new Error('Microphone disconnected while starting. Tap Retry.');
    source.connect(node); node.connect(mute); mute.connect(context.destination);
    capturing = true;
  } catch (error) { clearInterval(watchdog); removeDebug(); stream.getTracks().forEach(track => track.stop()); source?.disconnect(); node?.disconnect(); throw error; }
  return () => { clearInterval(watchdog); removeDebug(); diagnostic('mic.stop'); for (const track of tracks) { track.onended = null; track.onmute = null; track.onunmute = null; } stream.getTracks().forEach(track => track.stop()); if (node) { node.port.onmessage = null; node.disconnect(); } source?.disconnect(); mute.disconnect(); onLevel(0); };
}
