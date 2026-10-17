// Plain-rectangle geometry for layout and edge routing. Scene coordinates throughout.
import { getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

export function boundsOf(elements: readonly ExcalidrawElement[]): Rect | null {
  if (elements.length === 0) return null;
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function union(rects: readonly Rect[]): Rect | null {
  const [first, ...rest] = rects;
  if (first === undefined) return null;
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.w;
  let maxY = first.y + first.h;
  for (const r of rest) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function center(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export type Outline = "rect" | "ellipse" | "diamond";

/**
 * Point where the ray from the shape's center towards `toward` leaves the outline, pushed out by `gap`.
 * Used to draw arrows that start and end at shape edges rather than centers.
 */
export function edgePoint(args: { rect: Rect; outline: Outline; toward: Point; gap: number }): Point {
  const { rect, outline, toward, gap } = args;
  const c = center(rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return c;
  const ux = dx / len;
  const uy = dy / len;
  const a = Math.max(rect.w / 2, 1);
  const b = Math.max(rect.h / 2, 1);
  let t: number;
  switch (outline) {
    case "rect":
      t = Math.min(Math.abs(ux) > 1e-9 ? a / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? b / Math.abs(uy) : Infinity);
      break;
    case "ellipse":
      t = 1 / Math.sqrt((ux * ux) / (a * a) + (uy * uy) / (b * b));
      break;
    case "diamond":
      t = 1 / (Math.abs(ux) / a + Math.abs(uy) / b);
      break;
    default: {
      const _exhaustive: never = outline;
      return _exhaustive;
    }
  }
  return { x: c.x + ux * (t + gap), y: c.y + uy * (t + gap) };
}
