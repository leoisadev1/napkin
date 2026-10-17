// Plain-rectangle geometry for layout and edge routing. Scene coordinates throughout.
// Pure: no Excalidraw imports, so layout stays unit-testable outside a browser.

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

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

/** True when the segment from `a` to `b` passes through `r` (Liang-Barsky clipping). */
export function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, r.x + r.w - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.h - a.y],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * A point to bend an arrow through so it clears `obstacles`, or null when the straight line is already clear.
 * Tries offsets perpendicular to the line at its midpoint, nearest first.
 */
export function bendAround(args: { start: Point; end: Point; obstacles: readonly Rect[] }): Point | null {
  const { start, end, obstacles } = args;
  const blocked = (a: Point, b: Point) => obstacles.some((r) => segmentHitsRect(a, b, r));
  if (!blocked(start, end)) return null;
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  if (len < 1) return null;
  const nx = -(end.y - start.y) / len;
  const ny = (end.x - start.x) / len;
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  for (let offset = 48; offset <= 640; offset += 32) {
    for (const sign of [1, -1]) {
      const bend = { x: mid.x + nx * offset * sign, y: mid.y + ny * offset * sign };
      if (!blocked(start, bend) && !blocked(bend, end)) return bend;
    }
  }
  return null;
}
