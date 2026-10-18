// Text sizing that needs no DOM: a greedy word wrap and the sticky-note size that fits a label.

/** Rough advance per character of the board font (Inter 500) as a fraction of font size; good enough to size containers. */
export const CHAR_WIDTH = 0.57;

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

const STICKY_MIN_W = 220;
const STICKY_MAX_W = 400;
/** Room between the note's edge and its words, on each side. */
const STICKY_PAD = 22;
const STICKY_FONT = 18;
const STICKY_LINE = 1.25;
const TWO_LINE_W = 300;

/** A "Pick: ..." answer reads as a callout docked under its diagram: a wide strip of at most two lines. */
export function isPick(label: string): boolean {
  return /^pick\b/i.test(label.trim());
}

/**
 * The note's words, pre-wrapped to the padded width. Excalidraw wraps bound text to the container's full width minus
 * 5px, which would run words into the card's edge; breaking lines here keeps a real margin.
 */
export function stickyText(label: string, size: { w: number; fontSize: number }): string {
  const chars = Math.max(8, Math.floor((size.w - STICKY_PAD * 2) / (size.fontSize * CHAR_WIDTH)));
  return wrap(label.trim(), chars);
}

/**
 * A sticky note that fits `label` as a landscape card: the narrowest width (in 20px steps) that keeps it to two
 * lines, then three for longer notes; a Pick always stays within two. One font size for every note, so a board of notes reads as one set. Short notes keep a
 * card's proportions instead of collapsing to a strip.
 */
export function stickySize(label: string): { w: number; h: number; fontSize: number } {
  const text = label.trim();
  const pick = isPick(text);
  const fontSize = STICKY_FONT;
  const maxLines = pick ? 2 : 3;
  const maxW = pick ? 440 : STICKY_MAX_W;
  const minAspect = pick ? 0.3 : 0.56;
  const sized = (w: number) => {
    const chars = Math.max(8, Math.floor((w - STICKY_PAD * 2) / (fontSize * CHAR_WIDTH)));
    const lines = wrap(text, chars).split("\n").length;
    return { w, lines, h: Math.max(Math.round(w * minAspect), Math.ceil(lines * fontSize * STICKY_LINE + STICKY_PAD * 2)) };
  };
  // Two lines are worth some width (up to TWO_LINE_W); past that a third line beats a strip.
  const budgets = pick ? [{ lines: maxLines, upTo: maxW }] : [{ lines: 2, upTo: TWO_LINE_W }, { lines: maxLines, upTo: maxW }];
  for (const budget of budgets) {
    for (let w = STICKY_MIN_W; w <= budget.upTo; w += 20) {
      const s = sized(w);
      if (s.lines <= budget.lines) return { w: s.w, h: s.h, fontSize };
    }
  }
  const s = sized(maxW);
  return { w: s.w, h: s.h, fontSize };
}
