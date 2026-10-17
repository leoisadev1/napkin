import { openVoiceSocket } from './socket';
import { toBase64 } from './pcm';
import { PhraseChunker } from './phrase-chunker';
import { TurnDetector } from './turn-detector';
export class SpeechToText {
  private muted = false;
  private connecting: Promise<void> | undefined;
  private socket: WebSocket | undefined;
  private readonly abort = new AbortController();
  private readonly detector = new TurnDetector();
  private flushId = 0;
  private discarding = false;
  private flushing: number | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnects = 0;
  private connectedAt = 0;
  private callbacks;
  private chunker: PhraseChunker;
  constructor(callbacks: { chunking?: { minWords: number; quietMs: number }; onText?: (text: string, startSeconds: number | undefined) => void; delayInFrames?: number; getKeywords?: () => string[]; onPartial: (text: string) => void; onTurn: (text: string) => void; onBargeIn?: () => void; onPhrase?: (text: string) => void; onError: (error: Error) => void }) { this.callbacks = callbacks; this.chunker = new PhraseChunker({ onPartial: callbacks.onPartial, onPhrase: text => callbacks.onPhrase?.(text) }, callbacks.chunking); }
  connect(): Promise<void> {
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open() {
    const keywords = this.callbacks.getKeywords?.().slice(0, 100) ?? [];
    this.socket = await openVoiceSocket({ endpoint: 'asr', signal: this.abort.signal,
      setup: { model_name: 'default', input_format: 'pcm', json_config: { language: 'en', delay_in_frames: this.callbacks.delayInFrames ?? 10, ...(keywords.length ? { keywords: { words: keywords, boost: 3 } } : {}) } },
      onMessage: message => {
        if (message.type === 'text' && !this.discarding && !this.muted) { this.callbacks.onText?.(message.text, message.start_s); this.detector.addText(message.text); this.chunker.addText(message.text); }
        if (message.type === 'end_text' && !this.discarding && !this.muted) this.chunker.endSegment();
        if (message.type === 'step' && !this.muted && !this.discarding) {
          const probability = message.vad.at(-1)?.inactivity_prob;
          if (probability === undefined) return;
          const decision = this.detector.step(probability);
          const medium = message.vad[Math.floor(message.vad.length / 2)]?.inactivity_prob;
          if (medium !== undefined && medium > 0.65) this.chunker.pause();
          if (decision.endTurn && this.flushing === undefined) {
            this.flushing = ++this.flushId;
            this.socket?.send(JSON.stringify({ type: 'flush', flush_id: this.flushing }));
            this.flushTimer = setTimeout(() => { this.callbacks.onError(new Error('Transcription flush timed out')); this.stop(); }, 5000);
          }
        }
        if (message.type === 'flushed' && message.flush_id === this.flushing) {
          clearTimeout(this.flushTimer); this.flushing = undefined; this.discarding = false;
          const text = this.detector.take(); this.chunker.endTurn(); if (text && !this.muted) this.callbacks.onTurn(text);
        }
      },
      onError: error => { if (!this.abort.signal.aborted) this.callbacks.onError(error); },
      onClose: () => {
        this.socket = undefined; clearTimeout(this.flushTimer); this.flushing = undefined; this.discarding = false;
        this.chunker.endTurn(); this.detector.reset(); this.callbacks.onTurn('');
        if (!this.abort.signal.aborted) {
          if (Date.now() - this.connectedAt >= 30_000) this.reconnects = 0;
          if (++this.reconnects > 3) { this.callbacks.onError(new Error('Voice disconnected. Start the microphone again.')); this.stop(); return; }
          this.reconnectTimer = setTimeout(() => { void this.connect().catch(error => { if (!this.abort.signal.aborted) this.callbacks.onError(error instanceof Error ? error : new Error('Reconnect failed')); }); }, this.muted ? 0 : 500 * this.reconnects);
        }
      },
    });
    this.connectedAt = Date.now();
  }
  send(frame: Uint8Array) {
    if (!this.muted && this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 24000 * 2) {
      this.socket.send(JSON.stringify({ type: 'audio', audio: toBase64(frame) }));
      // Only replenish the budget after a ready connection carries stable audio.
      if (Date.now() - this.connectedAt >= 30_000) this.reconnects = 0;
    }
  }
  setMuted(muted: boolean) {
    if (muted === this.muted) return;
    this.muted = muted;
    if (muted) { this.chunker.mute(); this.resetPhrases(); }
    else if (!this.socket && !this.abort.signal.aborted) {
      clearTimeout(this.reconnectTimer);
      void this.connect().catch(error => this.callbacks.onError(error instanceof Error ? error : new Error('Reconnect failed')));
    }
  }
  flushPhrases() { this.chunker.pause(); }
  resetPhrases() {
    this.chunker.reset(); this.detector.reset();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.discarding = true; this.flushing = ++this.flushId;
      this.socket.send(JSON.stringify({ type: 'flush', flush_id: this.flushing }));
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => { this.callbacks.onError(new Error('Transcription flush timed out')); this.stop(); }, 5000);
    }
  }
  stop() {
    clearTimeout(this.reconnectTimer); clearTimeout(this.flushTimer);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'end_of_stream' }));
    this.abort.abort(); this.socket?.close(); this.socket = undefined; this.detector.reset(); this.chunker.reset();
  }
}
