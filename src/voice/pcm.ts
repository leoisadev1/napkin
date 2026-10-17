export function encodePCM(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
export function decodePCM(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  if (bytes.length % 2) throw new Error('Invalid PCM byte count');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768);
}
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export function fromBase64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export function rms(samples: Float32Array) {
  return Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / Math.max(1, samples.length)) * 4);
}
// Integrate across source samples, retaining fractional phase across worklet blocks.
// Averaging also suppresses high-frequency aliasing when downsampling.
export class PCMResampler {
  private sum = 0;
  private weight = 0;
  private frame: number[] = [];
  private readonly inputRate: number;
  private readonly outputRate: number;
  private readonly frameSize: number;
  constructor(inputRate: number, outputRate = 24000, frameSize = 1920) {
    this.inputRate = inputRate; this.outputRate = outputRate; this.frameSize = frameSize;
    if (inputRate < outputRate || outputRate <= 0) throw new Error('Unsupported sample rate');
  }
  push(samples: Float32Array): Uint8Array<ArrayBuffer>[] {
    const frames: Uint8Array<ArrayBuffer>[] = [];
    const ratio = this.inputRate / this.outputRate;
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 1e-9) {
        const used = Math.min(remaining, ratio - this.weight);
        this.sum += sample * used; this.weight += used; remaining -= used;
        if (this.weight >= ratio - 1e-9) {
          this.frame.push(this.sum / ratio); this.sum = 0; this.weight = 0;
          if (this.frame.length === this.frameSize) { frames.push(encodePCM(Float32Array.from(this.frame))); this.frame = []; }
        }
      }
    }
    return frames;
  }
}
