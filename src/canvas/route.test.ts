import { describe, expect, test } from "bun:test";
import type { EdgeSurroundings, Point, Rect } from "./geometry";
import { boxAround, center, edgePoint, inflate, labelPointOf, overlaps, routeEdge, routeOf, routePoints, segmentHitsRect, segmentsOf } from "./geometry";

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const LABEL = { w: 140, h: 22 };

function endsBetween(a: Rect, b: Rect) {
  return (bend: Point | null) => ({
    start: edgePoint({ rect: a, outline: "rect", toward: bend ?? center(b), gap: 8 }),
    end: edgePoint({ rect: b, outline: "rect", toward: bend ?? center(a), gap: 8 }),
  });
}

const none: EdgeSurroundings = { solids: [], ends: [], labels: [], lines: [] };

describe("routePoints", () => {
  test("puts Excalidraw's label spot wherever the route says, without changing the line", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 400, y: 0 };
    const bend = { x: 200, y: 200 };
    for (const label of [{ x: 200, y: 0 }, { x: 100, y: 0 }, bend, { x: 40, y: 40 }, { x: 330, y: 70 }]) {
      const onStraight = label.y === 0;
      const route = { start, end, bend: onStraight ? null : bend, label };
      const points = routePoints(route);
      expect(labelPointOf(points)).toEqual(label);
      const back = routeOf(points);
      expect(back?.bend ?? null).toEqual(route.bend);
      expect(back?.label).toEqual(label);
    }
  });
});

describe("routeEdge", () => {
  test("keeps a clear straight line straight", () => {
    const a = rect(0, 0, 200, 80);
    const b = rect(500, 0, 200, 80);
    const route = routeEdge({ ends: endsBetween(a, b), around: none, label: LABEL, current: null });
    expect(route.bend).toBeNull();
  });

  test("slides its label off another edge's label instead of stacking on it", () => {
    const a = rect(0, 0, 200, 80);
    const b = rect(700, 0, 200, 80);
    const straight = endsBetween(a, b)(null);
    const middle = { x: (straight.start.x + straight.end.x) / 2, y: 40 };
    // Another edge crosses this one vertically and its label sits right on our midpoint.
    const other = inflate(boxAround({ x: middle.x, y: middle.y }, { w: 80, h: 22 }), 4);
    const around: EdgeSurroundings = { ...none, labels: [other], lines: [{ a: { x: middle.x, y: -300 }, b: { x: middle.x, y: 300 } }] };
    const route = routeEdge({ ends: endsBetween(a, b), around, label: LABEL, current: null });
    const box = boxAround(route.label, LABEL);
    expect(overlaps(box, other)).toBe(false);
    for (const seg of segmentsOf(routePoints(route))) expect(segmentHitsRect(seg.a, seg.b, other)).toBe(false);
  });

  test("bends around a node in the way and keeps the label off every node", () => {
    const a = rect(0, 0, 200, 80);
    const b = rect(700, 0, 200, 80);
    const blocker = rect(350, -20, 200, 120);
    const around: EdgeSurroundings = { ...none, solids: [inflate(blocker, 12)], ends: [a, b] };
    const route = routeEdge({ ends: endsBetween(a, b), around, label: LABEL, current: null });
    expect(route.bend).not.toBeNull();
    for (const seg of segmentsOf(routePoints(route))) expect(segmentHitsRect(seg.a, seg.b, inflate(blocker, 12))).toBe(false);
    const box = boxAround(route.label, LABEL);
    for (const r of [blocker, a, b]) expect(overlaps(box, r)).toBe(false);
  });

  test("keeps the current route while it stays clean", () => {
    const a = rect(0, 0, 200, 80);
    const b = rect(700, 0, 200, 80);
    const ends = endsBetween(a, b);
    const bend = { x: 450, y: -160 };
    const current = { ...ends(bend), bend, label: bend };
    expect(routeEdge({ ends, around: none, label: LABEL, current })).toEqual(current);
  });

  test("carries a kept bend along when both ends move", () => {
    const a = rect(0, 0, 200, 80);
    const b = rect(700, 0, 200, 80);
    const bend = { x: 450, y: -160 };
    const current = { ...endsBetween(a, b)(bend), bend, label: bend };
    const moved = endsBetween(rect(100, 50, 200, 80), rect(800, 50, 200, 80));
    const route = routeEdge({ ends: moved, around: none, label: LABEL, current });
    expect(route.bend?.x).toBeCloseTo(550, 0);
    expect(route.bend?.y).toBeCloseTo(-110, 0);
    expect(Math.hypot(route.label.x - (route.bend?.x ?? 0), route.label.y - (route.bend?.y ?? 0))).toBeLessThan(0.01);
  });
});
