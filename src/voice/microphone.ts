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
export async function captureMicrophone(args: { context: AudioContext; onFrame: (frame: Uint8Array<ArrayBuffer>) => void; onLevel: (level: number) => void; onEnded?: () => void }) {
  const { context, onFrame, onLevel } = args;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const tracks = stream.getAudioTracks();
  let capturing = false;
  for (const track of tracks) {
    diagnostic('mic.track', { state: track.readyState, muted: track.muted });
    track.onended = () => { diagnostic('mic.ended'); if (capturing) args.onEnded?.(); };
    track.onmute = () => diagnostic('mic.mute');
    track.onunmute = () => diagnostic('mic.unmute');
  }
  const removeDebug = debugControl('endMic', () => { for (const track of tracks) { track.stop(); track.dispatchEvent(new Event('ended')); } });
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  const mute = context.createGain(); mute.gain.value = 0;
  try {
    source = context.createMediaStreamSource(stream);
    await initializeCapture(context);
    node = new AudioWorkletNode(context, 'rtw-capture');
    const resampler = new PCMResampler(context.sampleRate);
    let lastLevel = 0;
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      const samples = z.instanceof(Float32Array).parse(event.data);
      for (const frame of resampler.push(samples)) onFrame(frame);
      if (performance.now() - lastLevel >= 32) { onLevel(rms(samples)); lastLevel = performance.now(); }
    };
    if (tracks.some(track => track.readyState === 'ended')) throw new Error('Microphone disconnected while starting. Tap Retry.');
    source.connect(node); node.connect(mute); mute.connect(context.destination);
    capturing = true;
  } catch (error) { removeDebug(); stream.getTracks().forEach(track => track.stop()); source?.disconnect(); node?.disconnect(); throw error; }
  return () => { removeDebug(); diagnostic('mic.stop'); for (const track of tracks) { track.onended = null; track.onmute = null; track.onunmute = null; } stream.getTracks().forEach(track => track.stop()); if (node) { node.port.onmessage = null; node.disconnect(); } source?.disconnect(); mute.disconnect(); onLevel(0); };
}
