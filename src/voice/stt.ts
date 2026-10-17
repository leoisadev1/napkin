import { openVoiceSocket } from './socket';
import { toBase64 } from './pcm';
import { TurnDetector } from './turn-detector';
export class SpeechToText {
  private socket: WebSocket | undefined;
  private readonly abort = new AbortController();
  private readonly detector = new TurnDetector();
  private flushId = 0;
  private flushing: number | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnects = 0;
  private connectedAt = 0;
  private callbacks;
  constructor(callbacks: { onPartial: (text: string) => void; onTurn: (text: string) => void; onBargeIn: () => void; onError: (error: Error) => void }) { this.callbacks = callbacks; }
  async connect() {
    this.socket = await openVoiceSocket({ endpoint: 'asr', signal: this.abort.signal,
      setup: { model_name: 'default', input_format: 'pcm', json_config: { language: 'en', delay_in_frames: 8 } },
      onMessage: message => {
        if (message.type === 'text') { this.detector.addText(message.text); this.callbacks.onPartial(this.detector.text); }
        if (message.type === 'step') {
          const probability = message.vad.at(-1)?.inactivity_prob;
          if (probability === undefined) return;
          const decision = this.detector.step(probability);
          if (decision.bargeIn) this.callbacks.onBargeIn();
          if (decision.endTurn && this.flushing === undefined) {
            this.flushing = ++this.flushId;
            this.socket?.send(JSON.stringify({ type: 'flush', flush_id: this.flushing }));
            this.flushTimer = setTimeout(() => { this.callbacks.onError(new Error('Transcription flush timed out')); this.stop(); }, 5000);
          }
        }
        if (message.type === 'flushed' && message.flush_id === this.flushing) {
          clearTimeout(this.flushTimer); this.flushing = undefined;
          const text = this.detector.take(); this.callbacks.onPartial(''); if (text) this.callbacks.onTurn(text);
        }
      },
      onError: error => { if (!this.abort.signal.aborted) this.callbacks.onError(error); },
      onClose: () => {
        this.socket = undefined; clearTimeout(this.flushTimer); this.flushing = undefined;
        this.detector.reset(); this.callbacks.onPartial('');
        if (!this.abort.signal.aborted) {
          if (++this.reconnects > 3) { this.callbacks.onError(new Error('Voice disconnected. Start the microphone again.')); this.stop(); return; }
          this.reconnectTimer = setTimeout(() => { void this.connect().catch(error => { if (!this.abort.signal.aborted) this.callbacks.onError(error instanceof Error ? error : new Error('Reconnect failed')); }); }, 500 * this.reconnects);
        }
      },
    });
    this.connectedAt = Date.now();
  }
  send(frame: Uint8Array) {
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 24000 * 2) {
      this.socket.send(JSON.stringify({ type: 'audio', audio: toBase64(frame) }));
      // Only replenish the budget after a ready connection carries stable audio.
      if (Date.now() - this.connectedAt >= 30_000) this.reconnects = 0;
    }
  }
  stop() {
    clearTimeout(this.reconnectTimer); clearTimeout(this.flushTimer);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'end_of_stream' }));
    this.abort.abort(); this.socket?.close(); this.socket = undefined; this.detector.reset();
  }
}
