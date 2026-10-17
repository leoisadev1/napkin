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

export type Segment = { a: Point; b: Point };

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** True when two segments properly cross. Shared endpoints (edges meeting at a node) don't count. */
export function segmentsCross(p: Segment, q: Segment): boolean {
  const d1 = cross(q.a, q.b, p.a);
  const d2 = cross(q.a, q.b, p.b);
  const d3 = cross(p.a, p.b, q.a);
  const d4 = cross(p.a, p.b, q.b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** A bend expressed relative to a line: `t` along it from start, `n` out along its left-hand normal. */
export type BendSpot = { t: number; n: number };

export function bendSpotOf(line: { start: Point; end: Point }, bend: Point): BendSpot {
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const len2 = Math.max(dx * dx + dy * dy, 1);
  const len = Math.sqrt(len2);
  const rx = bend.x - line.start.x;
  const ry = bend.y - line.start.y;
  return { t: (rx * dx + ry * dy) / len2, n: (rx * -dy + ry * dx) / len };
}

export function bendAt(line: { start: Point; end: Point }, spot: BendSpot): Point {
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const len = Math.max(Math.hypot(dx, dy), 1);
  return { x: line.start.x + dx * spot.t + (-dy / len) * spot.n, y: line.start.y + dy * spot.t + (dx / len) * spot.n };
}

/** An arrow's path: straight or through one bend, with its label somewhere along the middle of the path. */
export type EdgeRoute = { start: Point; end: Point; bend: Point | null; label: Point };

const lerpPoint = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const near = (a: Point, b: Point, tolerance = 0.5) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

/**
 * The arrow's points. Excalidraw puts a label on the middle point of an odd-length arrow, so extra points on the
 * path (which leave the line's shape alone) make the label spot the middle point wherever it sits along the path.
 */
export function routePoints(route: EdgeRoute): Point[] {
  const { start: s, end: e, bend: b, label: l } = route;
  if (b === null) return near(l, lerpPoint(s, e, 0.5)) ? [s, e] : [s, l, e];
  if (near(l, b)) return [s, b, e];
  return onLeg(l, s, b) ? [s, lerpPoint(s, l, 0.5), l, b, e] : [s, b, l, lerpPoint(l, e, 0.5), e];
}

/** Where Excalidraw draws the label of an arrow with these points. */
export function labelPointOf(points: readonly Point[]): Point | null {
  if (points.length < 2) return null;
  if (points.length % 2 === 1) return points[Math.floor(points.length / 2)] ?? null;
  const a = points[points.length / 2 - 1];
  const b = points[points.length / 2];
  return a === undefined || b === undefined ? null : lerpPoint(a, b, 0.5);
}

/** Whether `p` lies on the segment from `a` to `b`. */
function onLeg(p: Point, a: Point, b: Point): boolean {
  const spot = bendSpotOf({ start: a, end: b }, p);
  return spot.t >= -0.01 && spot.t <= 1.01 && Math.abs(spot.n) < 1;
}

function offLine(p: Point, a: Point, b: Point): number {
  return Math.abs(bendSpotOf({ start: a, end: b }, p).n);
}

/** Reads a route back from arrow points written by routePoints (or drawn by hand). */
export function routeOf(points: readonly Point[]): EdgeRoute | null {
  const s = points[0];
  const e = points.at(-1);
  const label = labelPointOf(points);
  if (s === undefined || e === undefined || label === null) return null;
  const corners = points.slice(1, -1).filter((p, i) => {
    const prev = points[i];
    const next = points[i + 2];
    return prev !== undefined && next !== undefined && offLine(p, prev, next) > 2;
  });
  return { start: s, end: e, bend: corners.length === 1 ? (corners[0] ?? null) : null, label };
}

export function segmentsOf(points: readonly Point[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a !== undefined && b !== undefined) out.push({ a, b });
  }
  return out;
}

export function boxAround(c: Point, size: { w: number; h: number }): Rect {
  return { x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h };
}

/** What a labeled edge has to keep clear of. */
export type EdgeSurroundings = {
  /** Other nodes, already inflated: neither the line nor the label may cross them. */
  solids: readonly Rect[];
  /** The edge's own end nodes: the label may not sit on them, the line obviously touches them. */
  ends: readonly Rect[];
  /** Other edges' labels: the line and the label must both stay off them. */
  labels: readonly Rect[];
  /** Other edges' lines and frame borders: crossing one costs a little, putting the label on one is not allowed. */
  lines: readonly Segment[];
};

const LABEL_PAD = 6;
const HARD = 10_000;

type Ends = (bend: Point | null) => { start: Point; end: Point };

/**
 * Routes a labeled edge. Tries the straight line and one-bend paths on a grid around the two ends; for each, the
 * label slides along the middle of the path to the first clean spot. Hard problems weigh far more than soft ones:
 * a label on a node or another label is worst, then a line through a node or a label, then a label on another line.
 * Soft costs are crossing other lines, extra length, and leaving the current route. When `current` is still clean
 * it is kept as is, so edges don't twitch while the board grows around them.
 */
export function routeEdge(args: { ends: Ends; around: EdgeSurroundings; label: { w: number; h: number }; current: EdgeRoute | null }): EdgeRoute {
  const { around, label } = args;
  const straight = args.ends(null);
  const hasLabel = label.w > 0 && label.h > 0;
  const padded = { w: label.w + LABEL_PAD * 2, h: label.h + LABEL_PAD * 2 };
  const len = Math.max(Math.hypot(straight.end.x - straight.start.x, straight.end.y - straight.start.y), 1);

  const lineCost = (route: EdgeRoute): number => {
    let cost = 0;
    let path = 0;
    for (const seg of segmentsOf(route.bend === null ? [route.start, route.end] : [route.start, route.bend, route.end])) {
      if (around.solids.some((r) => segmentHitsRect(seg.a, seg.b, r))) cost += 2 * HARD;
      if (around.labels.some((r) => segmentHitsRect(seg.a, seg.b, r))) cost += 2 * HARD;
      cost += around.lines.filter((l) => segmentsCross(seg, l)).length * 140;
      path += Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
    }
    return cost + (path - len);
  };
  const labelCost = (at: Point): number => {
    if (!hasLabel) return 0;
    const box = boxAround(at, padded);
    let cost = 0;
    if (around.solids.some((r) => overlaps(r, box)) || around.ends.some((r) => overlaps(r, box)) || around.labels.some((r) => overlaps(r, box))) cost += 3 * HARD;
    if (around.lines.some((l) => segmentHitsRect(l.a, l.b, box))) cost += HARD;
    return cost;
  };
  /** Label spots along the middle of the path, nearest the middle first, each with its small bias. */
  const labelSpots = (bend: Point | null, start: Point, end: Point): { at: Point; bias: number }[] => {
    if (!hasLabel) return [{ at: bend ?? lerpPoint(start, end, 0.5), bias: 0 }];
    if (bend === null) return [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.2, 0.8].map((t) => ({ at: lerpPoint(start, end, t), bias: Math.abs(t - 0.5) * 80 }));
    // Anywhere along either leg, clear of the arrowhead and the start; nearest the middle of the path first.
    const first = Math.hypot(bend.x - start.x, bend.y - start.y);
    const second = Math.hypot(end.x - bend.x, end.y - bend.y);
    const half = (first + second) / 2;
    const spots = [
      { at: bend, along: first },
      ...[0.2, 0.35, 0.5, 0.65, 0.8].map((t) => ({ at: lerpPoint(start, bend, t), along: first * t })),
      ...[0.2, 0.35, 0.5, 0.65, 0.8].map((t) => ({ at: lerpPoint(bend, end, t), along: first + second * t })),
    ];
    return spots.map((p) => ({ at: p.at, bias: (Math.abs(p.along - half) / Math.max(half, 1)) * 60 })).sort((a, b) => a.bias - b.bias);
  };
  const best = (bend: Point | null, bias: number): { route: EdgeRoute; cost: number } => {
    const { start, end } = args.ends(bend);
    const base = lineCost({ start, end, bend, label: start }) + bias;
    let pick = { route: { start, end, bend, label: bend ?? lerpPoint(start, end, 0.5) }, cost: Infinity };
    for (const spot of labelSpots(bend, start, end)) {
      const cost = base + labelCost(spot.at) + spot.bias;
      if (cost < pick.cost) pick = { route: { start, end, bend, label: spot.at }, cost };
      // Spots come nearest the middle first, so the first clean one is the one to use.
      if (cost < base + HARD) break;
    }
    return pick;
  };

  // Keep the current route, carried along with its ends, while it stays clean.
  if (args.current !== null) {
    const cur = args.current;
    // The bend rides along with its two ends, by however far they moved since it was drawn. The ends depend on the
    // bend, so a few rounds settle it; when both nodes moved by the same amount this lands on exactly that shift.
    let bend = cur.bend;
    for (let round = 0; round < 4 && cur.bend !== null; round++) {
      const moved = args.ends(bend);
      const shift = { x: (moved.start.x - cur.start.x + moved.end.x - cur.end.x) / 2, y: (moved.start.y - cur.start.y + moved.end.y - cur.end.y) / 2 };
      bend = { x: cur.bend.x + shift.x, y: cur.bend.y + shift.y };
    }
    const { start, end } = args.ends(bend);
    const labelAt = (() => {
      if (cur.bend === null || bend === null) return bendAt({ start, end }, bendSpotOf(cur, cur.label));
      if (onLeg(cur.label, cur.start, cur.bend)) return lerpPoint(start, bend, bendSpotOf({ start: cur.start, end: cur.bend }, cur.label).t);
      return lerpPoint(bend, end, bendSpotOf({ start: cur.bend, end: cur.end }, cur.label).t);
    })();
    const route = { start, end, bend, label: labelAt };
    if (lineCost(route) + labelCost(labelAt) < HARD) return route;
  }

  let winner = best(null, 0);
  if (winner.cost < 1) return winner.route;
  const minX = Math.min(straight.start.x, straight.end.x) - 240;
  const maxX = Math.max(straight.start.x, straight.end.x) + 240;
  const minY = Math.min(straight.start.y, straight.end.y) - 240;
  const maxY = Math.max(straight.start.y, straight.end.y) + 240;
  const step = Math.max(28, Math.max(maxX - minX, maxY - minY) / 36);
  for (let x = minX; x <= maxX; x += step) {
    for (let y = minY; y <= maxY; y += step) {
      const bend = { x, y };
      const spot = bendSpotOf(straight, bend);
      if (Math.abs(spot.n) < 20) continue;
      const candidate = best(bend, 20);
      if (candidate.cost < winner.cost) winner = candidate;
    }
  }
  return winner.route;
}
