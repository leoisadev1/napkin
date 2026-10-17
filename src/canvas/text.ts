// Text sizing that needs no DOM: a greedy word wrap and the sticky-note size that fits a label.

/** Rough Excalifont advance per character as a fraction of font size; good enough to size containers. */
export const CHAR_WIDTH = 0.56;

/** Greedy word wrap for free text, which Excalidraw does not wrap on its own. */
export function wrap(text: string, maxChars: number): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= maxChars) line = `${line} ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

const STICKY_MIN_W = 200;
const STICKY_MAX_W = 360;
/** Room between the note's edge and its words, on each side. */
const STICKY_PAD = 22;
/** A note is never taller than this share of its width while it can still grow wider. */
const STICKY_MAX_ASPECT = 0.85;

/**
 * A sticky note that fits `label`: wider before taller, so a long note reads as a card instead of a narrow wall.
 * Longer text gets a slightly smaller font. Short notes keep a near-square shape.
 */
export function stickySize(label: string): { w: number; h: number; fontSize: number } {
  const len = label.trim().length;
  const fontSize = len > 140 ? 17 : len > 70 ? 18 : 20;
  const lineH = fontSize * 1.25;
  const sized = (w: number) => {
    const chars = Math.max(8, Math.floor((w - STICKY_PAD * 2) / (fontSize * CHAR_WIDTH)));
    const lines = wrap(label.trim(), chars).split("\n").length;
    return { w, h: Math.max(Math.round(w * 0.8), Math.ceil(lines * lineH + STICKY_PAD * 2)), fontSize };
  };
  for (let w = STICKY_MIN_W; w < STICKY_MAX_W; w += 20) {
    const s = sized(w);
    if (s.h <= w * STICKY_MAX_ASPECT) return s;
  }
  return sized(STICKY_MAX_W);
}
