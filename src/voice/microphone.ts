import { z } from 'zod';
import { PCMResampler, rms } from './pcm';

const workletSource = `class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) this.port.postMessage(input.slice());
    return true;
  }
}
registerProcessor('rtw-capture', Capture);`;
export async function captureMicrophone(args: { context: AudioContext; onFrame: (frame: Uint8Array<ArrayBuffer>) => void; onLevel: (level: number) => void }) {
  const { context, onFrame, onLevel } = args;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  const mute = context.createGain(); mute.gain.value = 0;
  const blob = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
  try {
    source = context.createMediaStreamSource(stream);
    await context.audioWorklet.addModule(blob);
    node = new AudioWorkletNode(context, 'rtw-capture');
    const resampler = new PCMResampler(context.sampleRate);
    let lastLevel = 0;
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      const samples = z.instanceof(Float32Array).parse(event.data);
      for (const frame of resampler.push(samples)) onFrame(frame);
      if (performance.now() - lastLevel >= 32) { onLevel(rms(samples)); lastLevel = performance.now(); }
    };
    source.connect(node); node.connect(mute); mute.connect(context.destination);
  } catch (error) { stream.getTracks().forEach(track => track.stop()); source?.disconnect(); node?.disconnect(); throw error; }
  finally { URL.revokeObjectURL(blob); }
  return () => { stream.getTracks().forEach(track => track.stop()); if (node) { node.port.onmessage = null; node.disconnect(); } source?.disconnect(); mute.disconnect(); onLevel(0); };
}
