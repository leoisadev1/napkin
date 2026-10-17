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
// Streaming 65-tap Blackman-windowed low-pass before fractional downsampling.
// Keep filter history across worklet blocks; native 24 kHz capture bypasses it.
export class PCMResampler {
  private sum = 0;
  private weight = 0;
  private frame: number[] = [];
  private history = new Float32Array(65);
  private cursor = 0;
  private readonly taps: number[];
  private readonly inputRate: number;
  private readonly outputRate: number;
  private readonly frameSize: number;
  constructor(inputRate: number, outputRate = 24000, frameSize = 1920) {
    this.inputRate = inputRate; this.outputRate = outputRate; this.frameSize = frameSize;
    if (inputRate < outputRate || outputRate <= 0) throw new Error('Unsupported sample rate');
    const cutoff = 0.45 * outputRate / inputRate;
    const taps = Array.from({ length: 65 }, (_, i) => {
      const x = i - 32;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      return sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / 64) + 0.08 * Math.cos(4 * Math.PI * i / 64));
    });
    const total = taps.reduce((a, b) => a + b, 0); this.taps = taps.map(tap => tap / total);
  }
  push(samples: Float32Array): Uint8Array<ArrayBuffer>[] {
    const frames: Uint8Array<ArrayBuffer>[] = [];
    const ratio = this.inputRate / this.outputRate;
    for (const raw of samples) {
      let sample = raw;
      if (ratio > 1) {
        this.history[this.cursor] = raw; sample = 0;
        for (let i = 0; i < this.taps.length; i++) sample += (this.taps[i] ?? 0) * (this.history[(this.cursor - i + 65) % 65] ?? 0);
        this.cursor = (this.cursor + 1) % 65;
      }
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
