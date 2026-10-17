import { decodePCM, fromBase64, rms } from './pcm';
import { openVoiceSocket } from './socket';

// Hold the last word until whitespace arrives so punctuation stays attached.
export class WordBuffer {
  private buffer = '';
  push(text: string) {
    this.buffer += text;
    // A sentence-final word can go out now; waiting for the next space can stall the last word of a reply.
    if (/[.!?]["')\]]?$/.test(this.buffer.trimEnd())) { const complete = this.buffer.trim(); this.buffer = ''; return complete; }
    const index = this.buffer.search(/\s+\S*$/);
    if (index < 0) return '';
    const complete = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index).trimStart(); return complete;
  }
  finish() { const text = this.buffer.trim(); this.buffer = ''; return text; }
}
export class TextToSpeech {
  private socket: WebSocket | undefined;
  private readonly abort = new AbortController();
  private readonly words = new WordBuffer();
  private queue: string[] = [];
  private finished = false;
  private eos = false;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private analyser: AnalyserNode;
  private meter: ReturnType<typeof setInterval>;
  private context;
  private callbacks;
  constructor(context: AudioContext, callbacks: { onSpeaking: () => void; onDone: () => void; onQuiet?: () => void; onLevel: (level: number) => void; onError: (error: Error) => void }) {
    this.context = context; this.callbacks = callbacks;
    this.analyser = context.createAnalyser(); this.analyser.fftSize = 256; this.analyser.connect(context.destination);
    const samples = new Float32Array(256);
    this.meter = setInterval(() => { this.analyser.getFloatTimeDomainData(samples); callbacks.onLevel(rms(samples)); }, 32);
  }
  async connect() {
    this.socket = await openVoiceSocket({ endpoint: 'tts', signal: this.abort.signal,
      setup: { model_name: 'default', voice_id: 'YTpq7expH9539ERJ', output_format: 'pcm' },
      onMessage: message => {
        if (message.type === 'audio' && !this.abort.signal.aborted) this.play(message.audio);
        if (message.type === 'end_of_stream') { this.eos = true; this.maybeDone(); }
      },
      onError: error => { if (!this.abort.signal.aborted) this.callbacks.onError(error); },
      onClose: () => { if (!this.abort.signal.aborted && !this.eos) this.callbacks.onError(new Error('Speech disconnected')); },
    });
    this.drain();
  }
  push(text: string) { const complete = this.words.push(text); if (complete) this.queue.push(complete); this.drain(); }
  finish() { const final = this.words.finish(); if (final) this.queue.push(final); this.finished = true; this.drain(); }
  private drain() {
    if (this.abort.signal.aborted || this.socket?.readyState !== WebSocket.OPEN) return;
    for (const text of this.queue.splice(0)) {
      this.socket.send(JSON.stringify({ type: 'text', text }));
      if (/[.!?]$/.test(text)) this.socket.send(JSON.stringify({ type: 'text', text: '<flush>' }));
    }
    if (this.finished) {
      this.socket.send(JSON.stringify({ type: 'text', text: '<flush>' }));
      this.socket.send(JSON.stringify({ type: 'end_of_stream' })); this.finished = false;
    }
  }
  private play(base64: string) {
    const samples = decodePCM(fromBase64(base64));
    if (!samples.length) return;
    const buffer = this.context.createBuffer(1, samples.length, 48000); buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.analyser);
    const start = Math.max(this.context.currentTime + 0.015, this.nextTime);
    this.nextTime = start + buffer.duration; this.sources.add(source);
    this.callbacks.onSpeaking();
    source.onended = () => { source.disconnect(); this.sources.delete(source); if (this.sources.size === 0) { this.callbacks.onLevel(0); this.callbacks.onQuiet?.(); } this.maybeDone(); };
    source.start(start);
  }
  private maybeDone() { if (this.eos && this.sources.size === 0) { clearInterval(this.meter); this.analyser.disconnect(); this.callbacks.onLevel(0); this.callbacks.onDone(); } }
  stop() {
    clearInterval(this.meter); this.analyser.disconnect();
    this.abort.abort(); this.socket?.close(); this.socket = undefined;
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.queue = []; this.callbacks.onLevel(0);
  }
}
