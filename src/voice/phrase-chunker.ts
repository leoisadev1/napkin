/** Consumes Gradium word groups; independent of audio/browser so the real pipeline can be replayed. */
export class PhraseChunker {
  private words = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private callbacks;
  constructor(callbacks: { onPhrase: (text: string) => void; onPartial: (text: string) => void }) { this.callbacks = callbacks; }
  get partial() { return this.words; }
  addText(text: string) {
    if (!text.trim()) return;
    clearTimeout(this.timer);
    this.words = `${this.words} ${text}`.trim();
    this.callbacks.onPartial(this.words);
    if (this.words.length >= 3500) this.commit();
    else if (this.words.split(/\s+/).length >= 6) this.timer = setTimeout(() => this.commit(), 350);
  }
  endSegment() { if (/[,.?!;:]$/.test(this.words)) this.commit(); }
  pause() { this.commit(); }
  endTurn() { this.commit(); }
  reset() { clearTimeout(this.timer); this.words = ''; this.callbacks.onPartial(''); }
  private commit() {
    clearTimeout(this.timer);
    const text = this.words; this.words = '';
    this.callbacks.onPartial('');
    if (text) this.callbacks.onPhrase(text);
  }
}
