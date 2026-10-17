// Auto-layout: turn a semantic Placement into a top-left position that does not collide with the board.
import type { Direction } from "../../shared/board";
import type { Point, Rect } from "./geometry";
import { center, contains, inflate, overlaps, union } from "./geometry";

/** Room between neighbors; wide enough that a labeled arrow between them stays readable. */
const GAP = 120;
const GAP_VERTICAL = 96;
const MARGIN = 36;
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
  const at = (p: Point): Rect => ({ x: p.x, y: p.y, w: size.w, h: size.h });
  if (!collides(at(preferred), obstacles, MARGIN)) return preferred;
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
    const hit = candidates.find((p) => !collides(at(p), obstacles, MARGIN));
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
      : { x: anchor.x + anchor.w + GAP, y: anchor.y + anchor.h / 2 - size.h / 2 };
  return nearestFree({ size, preferred, obstacles });
}

/** Beside a target in a direction, nudged sideways (then outward) until it fits. */
export function placeNear(args: { size: Size; target: Rect; direction: Direction; obstacles: readonly Rect[] }): Point {
  const { size, target, direction, obstacles } = args;
  const c = center(target);
  const horizontal = direction === "left" || direction === "right";
  const base: Point = (() => {
    switch (direction) {
      case "right":
        return { x: target.x + target.w + GAP, y: c.y - size.h / 2 };
      case "left":
        return { x: target.x - GAP - size.w, y: c.y - size.h / 2 };
      case "below":
        return { x: c.x - size.w / 2, y: target.y + target.h + GAP_VERTICAL };
      case "above":
        return { x: c.x - size.w / 2, y: target.y - GAP_VERTICAL - size.h };
      default: {
        const _exhaustive: never = direction;
        return _exhaustive;
      }
    }
  })();
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

/**
 * Reading-order first fit inside a frame. Returns the position and the frame rect grown to contain it.
 * Rows may extend past the frame up to FRAME_MAX_WIDTH, which makes frames grow sideways before downward.
 */
export function placeInside(args: { size: Size; frame: Rect; children: readonly Rect[] }): { at: Point; frame: Rect } {
  const { size, frame, children } = args;
  const left = frame.x + FRAME_PAD;
  const top = frame.y + FRAME_PAD;
  const rowLimit = frame.x + Math.max(frame.w, Math.min(FRAME_MAX_WIDTH, frame.w + size.w + FRAME_GAP)) - FRAME_PAD;
  const occupied = union(children);
  const bottomLimit = Math.max(frame.y + frame.h - FRAME_PAD, occupied === null ? top : occupied.y + occupied.h);
  const step = 16;
  let at: Point | null = null;
  for (let y = top; y + size.h <= bottomLimit + step && at === null; y += step) {
    for (let x = left; x + size.w <= rowLimit; x += step) {
      const r = { x, y, w: size.w, h: size.h };
      if (!collides(r, children, FRAME_GAP - 1)) {
        at = { x, y };
        break;
      }
    }
  }
  if (at === null) at = { x: left, y: occupied === null ? top : occupied.y + occupied.h + FRAME_GAP };
  const placed = { x: at.x, y: at.y, w: size.w, h: size.h };
  const needed = union([...children, placed]) ?? placed;
  const grown = {
    x: frame.x,
    y: frame.y,
    w: Math.max(frame.w, needed.x + needed.w + FRAME_PAD - frame.x),
    h: Math.max(frame.h, needed.y + needed.h + FRAME_PAD - frame.y),
  };
  return { at, frame: contains(frame, placed) ? frame : grown };
}
