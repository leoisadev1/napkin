export class TurnDetector {
  private transcript = '';
  private silentFrames = 0;
  private activeFrames = 0;
  private hasNewText = false;
  addText(text: string) { this.transcript = `${this.transcript} ${text}`.trim(); this.hasNewText = true; }
  get text() { return this.transcript; }
  step(inactivity: number): { endTurn: boolean; bargeIn: boolean } {
    this.silentFrames = inactivity > 0.65 ? this.silentFrames + 1 : 0;
    this.activeFrames = inactivity < 0.35 ? this.activeFrames + 1 : 0;
    return { endTurn: Boolean(this.transcript) && this.silentFrames >= 3,
      bargeIn: this.hasNewText && this.activeFrames >= 4 };
  }
  take() { const text = this.transcript; this.reset(); return text; }
  reset() { this.transcript = ''; this.silentFrames = 0; this.activeFrames = 0; this.hasNewText = false; }
}
