import { openVoiceSocket } from './socket';
import { toBase64 } from './pcm';
import { PhraseChunker } from './phrase-chunker';
import { TurnDetector } from './turn-detector';
import { diagnostic, debugControl } from './diagnostics';
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
  private lastAudioDiagnostic = 0;
  private removeDebug: (() => void) | undefined;
  private callbacks;
  private chunker: PhraseChunker;
  constructor(callbacks: { chunking?: { minWords: number; quietMs: number }; onText?: (text: string, startSeconds: number | undefined) => void; delayInFrames?: number; getKeywords?: () => string[]; onPartial: (text: string) => void; onTurn: (text: string) => void; onBargeIn?: () => void; onPhrase?: (text: string) => void; onConnection?: (state: 'connecting' | 'listening') => void; onError: (error: Error) => void }) { this.callbacks = callbacks; this.chunker = new PhraseChunker({ onPartial: callbacks.onPartial, onPhrase: text => callbacks.onPhrase?.(text) }, callbacks.chunking); }
  connect(): Promise<void> {
    this.connecting ??= this.recover().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async recover() {
    this.callbacks.onConnection?.('connecting');
    while (!this.abort.signal.aborted) {
      try { await this.open(); return; }
      catch (error) {
        this.abort.signal.throwIfAborted();
        diagnostic('stt.connect_failed');
        if (++this.reconnects > 6) throw error;
        await this.delay();
      }
    }
    this.abort.signal.throwIfAborted();
  }
  private delay() {
    const ms = Math.min(8000, 500 * 2 ** Math.max(0, this.reconnects - 1));
    diagnostic('stt.reconnect', { attempt: this.reconnects, delayMs: ms });
    return new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(this.reconnectTimer); reject(this.abort.signal.reason); };
      this.abort.signal.addEventListener('abort', abort, { once: true });
      this.reconnectTimer = setTimeout(() => { this.abort.signal.removeEventListener('abort', abort); resolve(); }, ms);
    });
  }
  private async open() {
    const keywords = this.callbacks.getKeywords?.().slice(0, 100) ?? [];
    let ready = false;
    this.socket = await openVoiceSocket({ endpoint: 'asr', signal: this.abort.signal,
      setup: { model_name: 'default', input_format: 'pcm', json_config: { language: 'en', delay_in_frames: this.callbacks.delayInFrames ?? 10, ...(keywords.length ? { keywords: { words: keywords, boost: 3 } } : {}) } },
      onMessage: message => {
        if (message.type === 'text' && !this.discarding && !this.muted) { diagnostic('stt.text', { characters: message.text.length }); this.callbacks.onText?.(message.text, message.start_s); this.detector.addText(message.text); this.chunker.addText(message.text); }
        if (message.type === 'end_text' && !this.discarding && !this.muted) this.chunker.endSegment();
        if (message.type === 'step' && !this.muted && !this.discarding) {
          const probability = message.vad.at(-1)?.inactivity_prob;
          if (probability === undefined) return;
          const decision = this.detector.step(probability);
          const medium = message.vad[Math.floor(message.vad.length / 2)]?.inactivity_prob;
          if (medium !== undefined && medium > 0.65) this.chunker.pause();
          if (decision.endTurn && this.flushing === undefined) this.flush();
        }
        if (message.type === 'flushed' && message.flush_id === this.flushing) {
          clearTimeout(this.flushTimer); this.flushing = undefined; this.discarding = false;
          const text = this.detector.take(); this.chunker.endTurn(); if (text && !this.muted) this.callbacks.onTurn(text);
        }
      },
      onError: () => { diagnostic('stt.socket_error'); },
      onClose: () => {
        if (!ready || this.abort.signal.aborted) return;
        this.socket = undefined; clearTimeout(this.flushTimer); this.flushing = undefined; this.discarding = false;
        this.chunker.endTurn(); this.detector.reset(); this.callbacks.onTurn('');
        if (Date.now() - this.connectedAt >= 30_000) this.reconnects = 0;
        this.callbacks.onConnection?.('connecting');
        if (++this.reconnects > 6) { this.fail(new Error('Voice disconnected. Start the microphone again.')); return; }
        void this.delay().then(() => this.connect()).catch(error => this.fail(error));
      },
    });
    ready = true; this.connectedAt = Date.now();
    this.removeDebug?.(); this.removeDebug = debugControl('disconnect', () => this.socket?.close(4000, 'Recovery test'));
    diagnostic('stt.listening'); this.callbacks.onConnection?.('listening');
  }
  private fail(error: unknown) {
    if (this.abort.signal.aborted) return;
    this.stop(); this.callbacks.onError(error instanceof Error ? error : new Error('Voice reconnect failed'));
  }
  private flush() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.flushing = ++this.flushId;
    this.socket.send(JSON.stringify({ type: 'flush', flush_id: this.flushing }));
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { diagnostic('stt.flush_timeout'); this.socket?.close(4000, 'Flush timeout'); }, 5000);
  }
  send(frame: Uint8Array) {
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 24000 * 2) {
      // Valid, real-time PCM silence keeps muted sessions alive without sending mic content.
      this.socket.send(JSON.stringify({ type: 'audio', audio: toBase64(this.muted ? new Uint8Array(frame.length) : frame) }));
      if (Date.now() - this.lastAudioDiagnostic >= 30_000) { this.lastAudioDiagnostic = Date.now(); diagnostic('stt.audio', { muted: this.muted, bufferedBytes: this.socket.bufferedAmount }); }
      if (Date.now() - this.connectedAt >= 30_000) this.reconnects = 0;
    }
  }
  setMuted(muted: boolean) {
    if (muted === this.muted) return;
    diagnostic('stt.muted', { muted });
    this.muted = muted;
    if (muted) { this.chunker.mute(); this.resetPhrases(); }
  }
  flushPhrases() { this.chunker.endTurn(); }
  resetPhrases() {
    this.chunker.reset(); this.detector.reset();
    if (this.socket?.readyState === WebSocket.OPEN) { this.discarding = true; this.flush(); }
  }
  stop() {
    this.removeDebug?.();
    this.abort.abort(); clearTimeout(this.reconnectTimer); clearTimeout(this.flushTimer);
    this.socket?.close(); this.socket = undefined; this.detector.reset(); this.chunker.reset();
  }
}
