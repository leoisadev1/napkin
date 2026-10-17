// Auto-layout: turn a semantic Placement into a top-left position that does not collide with the board.
import type { Direction } from "../../shared/board";
import type { Point, Rect } from "./geometry";
import { center, contains, inflate, overlaps, union } from "./geometry";

/** Room between neighbors; wide enough that a labeled arrow between them stays readable. */
const GAP = 120;
const GAP_VERTICAL = 96;
const MARGIN = 36;
/** Past this size (either side) a block lines up by its edges rather than its center. */
const BIG = 200;
/** Edges this close to a neighbour's snap to it. */
export const ALIGN_SNAP = 40;
export const FRAME_PAD = 36;
const FRAME_GAP = 88;
const FRAME_MAX_WIDTH = 1000;

type Size = { w: number; h: number };

function collides(rect: Rect, obstacles: readonly Rect[], margin: number): boolean {
  const padded = inflate(rect, margin);
  return obstacles.some((o) => overlaps(padded, o));
}

/**
 * Nearest free spot to `preferred` (a top-left corner), searching outward in square rings.
 * Within a ring, candidates are tried in order of true distance so the result stays close.
 */
export function nearestFree(args: { size: Size; preferred: Point; obstacles: readonly Rect[] }): Point {
  const { size, preferred, obstacles } = args;
  const margin = MARGIN;
  const at = (p: Point): Rect => ({ x: p.x, y: p.y, w: size.w, h: size.h });
  if (!collides(at(preferred), obstacles, margin)) return preferred;
  const step = 32;
  for (let ring = 1; ring <= 160; ring++) {
    const candidates: Point[] = [];
    for (let i = -ring; i <= ring; i++) {
      candidates.push(
        { x: preferred.x + i * step, y: preferred.y - ring * step },
        { x: preferred.x + i * step, y: preferred.y + ring * step },
      );
      if (i !== -ring && i !== ring) {
        candidates.push(
          { x: preferred.x - ring * step, y: preferred.y + i * step },
          { x: preferred.x + ring * step, y: preferred.y + i * step },
        );
      }
    }
    candidates.sort((a, b) => Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y));
    const hit = candidates.find((p) => !collides(at(p), obstacles, margin));
    if (hit !== undefined) return hit;
  }
  return preferred;
}

/** Free space near recent activity: to the right of the last placed item, or the viewport center on an empty board. */
export function placeAuto(args: { size: Size; anchor: Rect | null; viewportCenter: Point; obstacles: readonly Rect[] }): Point {
  const { size, anchor, viewportCenter, obstacles } = args;
  const preferred =
    anchor === null
      ? { x: viewportCenter.x - size.w / 2, y: viewportCenter.y - size.h / 2 }
      : {
          x: anchor.x + anchor.w + GAP,
          // Big blocks (frames, mockups) line up along the top; small shapes line up on their centers.
          y: Math.max(anchor.h, size.h) > 200 ? anchor.y : anchor.y + anchor.h / 2 - size.h / 2,
        };
  return nearestFree({ size, preferred, obstacles });
}

/** Like nearestFree, but only accepts spots fully inside `view`. Null when the view has no room. */
export function nearestFreeWithin(args: { size: Size; preferred: Point; view: Rect; obstacles: readonly Rect[] }): Point | null {
  const { size, view, obstacles } = args;
  if (size.w > view.w || size.h > view.h) return null;
  const clampX = (x: number) => Math.min(Math.max(x, view.x), view.x + view.w - size.w);
  const clampY = (y: number) => Math.min(Math.max(y, view.y), view.y + view.h - size.h);
  const preferred = { x: clampX(args.preferred.x), y: clampY(args.preferred.y) };
  const fits = (p: Point) => !collides({ x: p.x, y: p.y, w: size.w, h: size.h }, obstacles, MARGIN);
  if (fits(preferred)) return preferred;
  const step = 24;
  const rings = Math.ceil(Math.max(view.w, view.h) / step);
  for (let ring = 1; ring <= rings; ring++) {
    const candidates: Point[] = [];
    for (let i = -ring; i <= ring; i++) {
      candidates.push({ x: preferred.x + i * step, y: preferred.y - ring * step }, { x: preferred.x + i * step, y: preferred.y + ring * step });
      if (i !== -ring && i !== ring) {
        candidates.push({ x: preferred.x - ring * step, y: preferred.y + i * step }, { x: preferred.x + ring * step, y: preferred.y + i * step });
      }
    }
    const inside = candidates.filter((p) => p.x >= view.x && p.y >= view.y && p.x + size.w <= view.x + view.w && p.y + size.h <= view.y + view.h);
    inside.sort((a, b) => Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y));
    const hit = inside.find(fits);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** Centered on a point (the user's mouse), nudged to the nearest free space. */
export function placeAtPoint(args: { size: Size; point: Point; obstacles: readonly Rect[] }): Point {
  const { size, point, obstacles } = args;
  return nearestFree({ size, preferred: { x: point.x - size.w / 2, y: point.y - size.h / 2 }, obstacles });
}

/** Top-left that centers `size` on `target`: a clean shape taking the place of the sketch it replaces. */
export function placeOver(args: { size: Size; target: Rect }): Point {
  const c = center(args.target);
  return { x: c.x - args.size.w / 2, y: c.y - args.size.h / 2 };
}

/**
 * Free space where the user is looking. With an `anchor` (the item the conversation is on, still in view) the new
 * item goes beside it, right then below then left then above, as long as that spot is in view. Otherwise the free
 * spot nearest `focus` (the mouse, the selection, or the middle of the screen). Null when the view is full.
 */
export function placeInView(args: { size: Size; view: Rect; focus: Point; anchor: Rect | null; obstacles: readonly Rect[] }): Point | null {
  const { size, view, focus, anchor, obstacles } = args;
  const inView = (p: Point) => contains(view, { x: p.x, y: p.y, w: size.w, h: size.h });
  if (anchor !== null && overlaps(anchor, view)) {
    for (const direction of ["right", "below", "left", "above"] as const) {
      const p = placeNear({ size, target: anchor, direction, obstacles });
      // Beside means beside: a spot the nudging pushed far away is no better than one near the focus.
      const far = Math.hypot(center({ ...p, ...size }).x - center(anchor).x, center({ ...p, ...size }).y - center(anchor).y);
      if (inView(p) && far < Math.max(anchor.w, anchor.h, size.w, size.h) * 2 + GAP * 2) return p;
    }
  }
  return nearestFreeWithin({ size, preferred: { x: focus.x - size.w / 2, y: focus.y - size.h / 2 }, view, obstacles });
}

/**
 * A free spot inside `view` that lines up with a block already there: right of it sharing its top edge, or below it
 * sharing its left edge. The one nearest `prefer` wins. Null when no such spot is open.
 */
export function alignedSpot(args: { size: Size; view: Rect; blocks: readonly Rect[]; prefer: Point; obstacles: readonly Rect[] }): Point | null {
  const { size, view, blocks, prefer, obstacles } = args;
  const candidates = blocks
    .filter((b) => overlaps(b, view))
    .flatMap((b) => [
      { x: b.x + b.w + GAP, y: b.y },
      { x: b.x, y: b.y + b.h + GAP_VERTICAL },
    ])
    .filter((p) => contains(view, { x: p.x, y: p.y, w: size.w, h: size.h }) && isFree({ size, at: p, obstacles }));
  candidates.sort((a, b) => Math.hypot(a.x - prefer.x, a.y - prefer.y) - Math.hypot(b.x - prefer.x, b.y - prefer.y));
  return candidates[0] ?? null;
}

/** Whether a rect at `at` already shares a top or left edge (within ALIGN_SNAP) with one of `blocks`. */
export function isAligned(args: { at: Point; blocks: readonly Rect[] }): boolean {
  return args.blocks.some((b) => Math.abs(b.y - args.at.y) <= 1 || Math.abs(b.x - args.at.x) <= 1);
}

/** The spot directly beside a target, before any collision handling. */
export function besideSpot(args: { size: Size; target: Rect; direction: Direction }): Point {
  const { size, target, direction } = args;
  const c = center(target);
  return (() => {
    // Big blocks side by side share a top edge, and stacked ones a left edge, so the board reads in rows and columns.
    const rowY = Math.max(target.h, size.h) > BIG ? target.y : c.y - size.h / 2;
    const colX = Math.max(target.w, size.w) > BIG ? target.x : c.x - size.w / 2;
    switch (direction) {
      case "right":
        return { x: target.x + target.w + GAP, y: rowY };
      case "left":
        return { x: target.x - GAP - size.w, y: rowY };
      case "below":
        return { x: colX, y: target.y + target.h + GAP_VERTICAL };
      case "above":
        return { x: colX, y: target.y - GAP_VERTICAL - size.h };
      default: {
        const _exhaustive: never = direction;
        return _exhaustive;
      }
    }
  })();
}

/** Whether a rect of `size` at `at` keeps clear of every obstacle. */
export function isFree(args: { size: Size; at: Point; obstacles: readonly Rect[] }): boolean {
  return !collides({ x: args.at.x, y: args.at.y, w: args.size.w, h: args.size.h }, args.obstacles, MARGIN);
}

/**
 * Nudges a spot so its top edge lines up with a neighbour's top, or its left edge with a neighbour's left, when one
 * is within ALIGN_SNAP. Only snaps that keep clear of every obstacle (by `margin`) are taken; the smallest wins.
 */
export function snapAlign(args: { size: Size; at: Point; neighbours: readonly Rect[]; obstacles: readonly Rect[]; margin?: number }): Point {
  const { size, at, neighbours, obstacles } = args;
  const margin = args.margin ?? MARGIN;
  const candidates: Point[] = [];
  for (const n of neighbours) {
    const dy = n.y - at.y;
    const dx = n.x - at.x;
    if (dy !== 0 && Math.abs(dy) <= ALIGN_SNAP) candidates.push({ x: at.x, y: n.y });
    if (dx !== 0 && Math.abs(dx) <= ALIGN_SNAP) candidates.push({ x: n.x, y: at.y });
  }
  candidates.sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y));
  const free = (p: Point) => !collides({ x: p.x, y: p.y, w: size.w, h: size.h }, obstacles, margin);
  // A top snap and a left snap can both apply; try them together first.
  const top = candidates.find((p) => p.y !== at.y);
  const left = candidates.find((p) => p.x !== at.x);
  if (top !== undefined && left !== undefined && free({ x: left.x, y: top.y })) return { x: left.x, y: top.y };
  return candidates.find(free) ?? at;
}

/** Beside a target in a direction, nudged sideways (then outward) until it fits. */
export function placeNear(args: { size: Size; target: Rect; direction: Direction; obstacles: readonly Rect[] }): Point {
  const { size, direction, obstacles } = args;
  const horizontal = direction === "left" || direction === "right";
  const base = besideSpot(args);
  const outward = { x: direction === "right" ? 1 : direction === "left" ? -1 : 0, y: direction === "below" ? 1 : direction === "above" ? -1 : 0 };
  const sideStep = (horizontal ? size.h : size.w) / 2 + MARGIN;
  for (let push = 0; push < 6; push++) {
    for (let k = 0; k <= 8; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const side = sign * k * sideStep;
        const p = {
          x: base.x + outward.x * push * GAP + (horizontal ? 0 : side),
          y: base.y + outward.y * push * GAP + (horizontal ? side : 0),
        };
        if (!collides({ x: p.x, y: p.y, w: size.w, h: size.h }, obstacles, MARGIN)) return p;
      }
    }
  }
  return nearestFree({ size, preferred: base, obstacles });
}

const FRAME_MIN = { w: 320, h: 200 };

/** Frame rect that wraps its children with padding: grows on any side, shrinks only right and bottom. */
export function fitFrame(frame: Rect, children: readonly Rect[]): Rect {
  const content = union(children);
  if (content === null) return frame;
  const x = Math.min(frame.x, content.x - FRAME_PAD);
  const y = Math.min(frame.y, content.y - FRAME_PAD);
  const right = Math.max(x + FRAME_MIN.w, content.x + content.w + FRAME_PAD);
  const bottom = Math.max(y + FRAME_MIN.h, content.y + content.h + FRAME_PAD);
  return { x, y, w: right - x, h: bottom - y };
}

/** Horizontal room between columns inside a frame: enough for a wrapped arrow label. */
const COL_GAP = 150;
/** Vertical room between rows inside a frame. */
const ROW_GAP = 104;
/** Columns closer than this in height count as level, so rows stay aligned. */
const LEVEL = 48;

/**
 * Two-column snake layout inside a frame. Items fill left, right, then the next row right to left, so a chain of
 * items always lands next to its predecessor and a four-step loop forms a square instead of crossing diagonals.
 * A tall item (a phone mockup) makes its column long; following items fill the short column first.
 * `items` are the frame's existing nodes in creation order. Falls back to first fit when the slot is taken.
 */
export function placeInside(args: { size: Size; frame: Rect; items: readonly Rect[] }): Point {
  const { size, frame, items } = args;
  const left = frame.x + FRAME_PAD;
  const top = frame.y + FRAME_PAD;
  const first = items[0];
  if (first === undefined) return { x: left, y: top };

  // Column 0 is everything that shares horizontal span with the leftmost item; the rest is column 1.
  const minX = Math.min(...items.map((r) => r.x));
  const leftmost = items.find((r) => r.x === minX) ?? first;
  const inCol0 = (r: Rect) => r.x < leftmost.x + leftmost.w;
  const col0 = items.filter(inCol0);
  const col1 = items.filter((r) => !inCol0(r));
  const bottomOf = (col: readonly Rect[]) => (col.length === 0 ? null : Math.max(...col.map((r) => r.y + r.h)));
  const b0 = bottomOf(col0);
  const b1 = bottomOf(col1);

  const n = items.length;
  const row = Math.floor(n / 2);
  const snake = row % 2 === 0 ? n % 2 : 1 - (n % 2);
  let col: 0 | 1;
  if (b1 === null) col = 1;
  else if (b0 === null) col = 0;
  else if (Math.abs(b0 - b1) < LEVEL) col = snake === 0 ? 0 : 1;
  else col = b0 < b1 ? 0 : 1;

  const col0Right = Math.max(...col0.map((r) => r.x + r.w), left);
  const col1Left = col0Right + COL_GAP;
  const anchor = (col === 0 ? col0 : col1)[0];
  const x =
    anchor === undefined
      ? col === 0
        ? left
        : col1Left
      : Math.max(col === 0 ? minX : col1Left, anchor.x + anchor.w / 2 - size.w / 2);
  // Level columns share a row line so the grid reads as rows.
  const below = (col === 0 ? b0 : b1) ?? top - ROW_GAP;
  const level = b0 !== null && b1 !== null && Math.abs(b0 - b1) < LEVEL;
  const y = (level ? Math.max(b0, b1) : below) + ROW_GAP;
  const slot = { x, y: col === 1 && b1 === null ? first.y : y, w: size.w, h: size.h };
  if (!collides(slot, items, FRAME_PAD)) return { x: slot.x, y: slot.y };
  return firstFit({ size, frame, items });
}

/** Reading-order first fit; rows may extend past the frame up to FRAME_MAX_WIDTH. */
function firstFit(args: { size: Size; frame: Rect; items: readonly Rect[] }): Point {
  const { size, frame, items } = args;
  const left = frame.x + FRAME_PAD;
  const top = frame.y + FRAME_PAD;
  const rowLimit = frame.x + Math.max(frame.w, Math.min(FRAME_MAX_WIDTH, frame.w + size.w + FRAME_GAP)) - FRAME_PAD;
  const occupied = union(items);
  const bottomLimit = Math.max(frame.y + frame.h - FRAME_PAD, occupied === null ? top : occupied.y + occupied.h);
  const step = 16;
  for (let y = top; y + size.h <= bottomLimit + step; y += step) {
    for (let x = left; x + size.w <= rowLimit; x += step) {
      if (!collides({ x, y, w: size.w, h: size.h }, items, FRAME_GAP - 1)) return { x, y };
    }
  }
  return { x: left, y: occupied === null ? top : occupied.y + occupied.h + FRAME_GAP };
}

// ---- Settling top-level blocks ------------------------------------------------------------------

/** A top-level thing on the board: a frame with its contents, or a loose node. */
export type Block = {
  key: string;
  rect: Rect;
  /** User-drawn blocks never move; agent blocks yield to them. */
  movable: boolean;
  /** Creation order: earlier blocks keep their spot, later ones step aside. */
  order: number;
};

/** Room kept between top-level blocks, wide enough for a labeled arrow to cross. */
export const BLOCK_GAP = 96;

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Pairs of blocks that overlap (with the gap) right now. */
export function overlappingPairs(blocks: readonly Block[], gap: number = BLOCK_GAP): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];
      if (a !== undefined && b !== undefined && overlaps(inflate(a.rect, gap - 1), b.rect)) out.add(pairKey(a.key, b.key));
    }
  }
  return out;
}

/**
 * Slides a rect right or down until it clears every obstacle. Only forward in reading order, so a block never jumps
 * above or before the things that came before it. A block that sits beside what it hit keeps going sideways and one
 * that sits below keeps going down, so rows stay rows; otherwise the shorter slide wins.
 */
function stepAside(rect: Rect, obstacles: readonly Rect[], gap: number): Point {
  const slide = (axis: "x" | "y"): Point => {
    const r = { ...rect };
    for (let i = 0; i <= obstacles.length; i++) {
      const hits = obstacles.filter((o) => overlaps(inflate(r, gap - 1), o));
      if (hits.length === 0) break;
      if (axis === "x") r.x = Math.max(...hits.map((o) => o.x + o.w)) + gap;
      else r.y = Math.max(...hits.map((o) => o.y + o.h)) + gap;
    }
    return { x: r.x, y: r.y };
  };
  const right = slide("x");
  const down = slide("y");
  const hit = obstacles.find((o) => overlaps(inflate(rect, gap - 1), o));
  if (hit !== undefined) {
    const c = center(rect);
    const o = center(hit);
    // Offsets relative to the combined size, so a wide frame beside a tall one still reads as "beside".
    const across = (c.x - o.x) / (rect.w + hit.w);
    const along = (c.y - o.y) / (rect.h + hit.h);
    if (across > 0 && across >= along) return right;
    if (along > 0 && along > across) return down;
  }
  return right.x - rect.x <= down.y - rect.y ? right : down;
}

/**
 * Resolves overlaps between top-level blocks by sliding the later block of each clash right or down.
 * Pairs in `ignore` (overlaps that existed before this change, usually the user's doing) are left alone.
 * Returns the offset for every block that moved.
 */
export function settleBlocks(args: { blocks: readonly Block[]; ignore: ReadonlySet<string>; gap?: number }): Map<string, Point> {
  const gap = args.gap ?? BLOCK_GAP;
  const ordered = [...args.blocks].sort((a, b) => (a.movable === b.movable ? a.order - b.order : a.movable ? 1 : -1));
  const settled: Block[] = [];
  const moves = new Map<string, Point>();
  for (const block of ordered) {
    const obstacles = settled.filter((s) => !args.ignore.has(pairKey(s.key, block.key))).map((s) => s.rect);
    if (!block.movable || !collides(block.rect, obstacles, gap - 1)) {
      settled.push(block);
      continue;
    }
    const stepped = stepAside(block.rect, obstacles, gap);
    // Line up with what it now sits beside, when that is a small nudge and keeps everything clear.
    const at = snapAlign({ size: { w: block.rect.w, h: block.rect.h }, at: stepped, neighbours: obstacles, obstacles, margin: gap - 1 });
    moves.set(block.key, { x: at.x - block.rect.x, y: at.y - block.rect.y });
    settled.push({ ...block, rect: { ...block.rect, x: at.x, y: at.y } });
  }
  return moves;
}
