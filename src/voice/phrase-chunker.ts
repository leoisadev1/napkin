/** Consumes Gradium word groups; independent of audio/browser so the real pipeline can be replayed. */
export class PhraseChunker {
  private words = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private callbacks;
  private options;
  constructor(callbacks: { onPhrase: (text: string) => void; onPartial: (text: string) => void }, options = { minWords: 4, quietMs: 250 }) { this.callbacks = callbacks; this.options = options; }
  get partial() { return this.words; }
  addText(text: string) {
    if (!text.trim()) return;
    clearTimeout(this.timer);
    this.deadline ??= setTimeout(() => { this.deadline = undefined; if (this.words.split(/\s+/).length >= this.options.minWords) this.commit(); }, 1600);
    this.words = `${this.words} ${text}`.trim();
    this.callbacks.onPartial(this.words);
    if (this.words.length >= 3500) this.commit();
    else if (this.words.split(/\s+/).length >= this.options.minWords) this.timer = setTimeout(() => this.commit(), this.options.quietMs);
  }
  endSegment() { if (/[.?!]$/.test(this.words) || (/[,:;]$/.test(this.words) && this.words.split(/\s+/).length >= this.options.minWords)) this.commit(); }
  pause() { if (this.words.split(/\s+/).length >= this.options.minWords || /[.?!]$/.test(this.words)) this.commit(); }
  endTurn() { this.pause(); }
  mute() { if (this.words.trim().split(/\s+/).length >= 5) this.commit(); this.reset(); }
  reset() { clearTimeout(this.timer); clearTimeout(this.deadline); this.deadline = undefined; this.words = ''; this.callbacks.onPartial(''); }
  private commit() {
    clearTimeout(this.timer); clearTimeout(this.deadline); this.deadline = undefined;
    const text = this.words; this.words = '';
    this.callbacks.onPartial('');
    if (text) this.callbacks.onPhrase(text);
  }
}
