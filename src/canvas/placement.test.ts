/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Rect } from "./geometry";
import { contains, inflate, overlaps } from "./geometry";
import { nearestFreeWithin, placeAtPoint, placeInView, placeOver } from "./layout";

const size = { w: 200, h: 80 };
const view: Rect = { x: 0, y: 0, w: 1200, h: 700 };
const rectAt = (p: { x: number; y: number }): Rect => ({ ...p, ...size });
const clear = (r: Rect, obstacles: readonly Rect[]) => obstacles.every((o) => !overlaps(r, o));

describe("placeAtPoint", () => {
  test("centers on the pointer when the spot is free", () => {
    const at = placeAtPoint({ size, point: { x: 500, y: 300 }, obstacles: [] });
    expect(at).toEqual({ x: 400, y: 260 });
  });

  test("nudges off whatever is under the pointer, staying close", () => {
    const blocker: Rect = { x: 420, y: 250, w: 160, h: 100 };
    const at = placeAtPoint({ size, point: { x: 500, y: 300 }, obstacles: [blocker] });
    expect(clear(rectAt(at), [inflate(blocker, 30)])).toBe(true);
    expect(Math.hypot(at.x + 100 - 500, at.y + 40 - 300)).toBeLessThan(260);
  });
});

describe("placeOver", () => {
  test("centers the replacement on the target, so a clean shape takes a sketch's spot", () => {
    const sketch: Rect = { x: 100, y: 100, w: 300, h: 120 };
    expect(placeOver({ size, target: sketch })).toEqual({ x: 150, y: 120 });
  });
});

describe("nearestFreeWithin", () => {
  test("never returns a spot outside the view", () => {
    const at = nearestFreeWithin({ size, preferred: { x: 1150, y: 680 }, view, obstacles: [] });
    expect(at).not.toBeNull();
    if (at !== null) expect(contains(view, rectAt(at))).toBe(true);
  });

  test("is null when the view is full", () => {
    expect(nearestFreeWithin({ size, preferred: { x: 100, y: 100 }, view, obstacles: [view] })).toBeNull();
  });

  test("is null when the item is bigger than the view", () => {
    expect(nearestFreeWithin({ size: { w: 2000, h: 80 }, preferred: { x: 0, y: 0 }, view, obstacles: [] })).toBeNull();
  });
});

describe("placeInView", () => {
  test("lands near the focus when nothing anchors it", () => {
    const at = placeInView({ size, view, focus: { x: 900, y: 500 }, anchor: null, obstacles: [] });
    expect(at).toEqual({ x: 800, y: 460 });
  });

  test("goes beside the anchor, to its right first", () => {
    const anchor: Rect = { x: 200, y: 200, w: 200, h: 80 };
    const at = placeInView({ size, view, focus: { x: 300, y: 240 }, anchor, obstacles: [anchor] });
    expect(at).not.toBeNull();
    if (at === null) return;
    expect(at.x).toBeGreaterThan(anchor.x + anchor.w);
    expect(Math.abs(at.y + size.h / 2 - (anchor.y + anchor.h / 2))).toBeLessThan(1);
  });

  test("goes below the anchor when its right side is off-screen", () => {
    const anchor: Rect = { x: 950, y: 100, w: 200, h: 80 };
    const at = placeInView({ size, view, focus: { x: 1050, y: 140 }, anchor, obstacles: [anchor] });
    expect(at).not.toBeNull();
    if (at === null) return;
    expect(contains(view, rectAt(at))).toBe(true);
    expect(at.y).toBeGreaterThan(anchor.y + anchor.h);
  });

  test("ignores an anchor that scrolled out of view and uses the focus", () => {
    const anchor: Rect = { x: 3000, y: 3000, w: 200, h: 80 };
    const at = placeInView({ size, view, focus: { x: 600, y: 350 }, anchor, obstacles: [anchor] });
    expect(at).toEqual({ x: 500, y: 310 });
  });

  test("stays inside the view and clear of everything on a busy board", () => {
    const obstacles: Rect[] = [];
    for (let x = 0; x < 1200; x += 300) obstacles.push({ x, y: 0, w: 220, h: 300 });
    const at = placeInView({ size, view, focus: { x: 100, y: 100 }, anchor: null, obstacles });
    expect(at).not.toBeNull();
    if (at === null) return;
    expect(contains(view, rectAt(at))).toBe(true);
    expect(clear(rectAt(at), obstacles)).toBe(true);
  });

  test("returns null when the view has no room, so the caller can grow the board", () => {
    expect(placeInView({ size, view, focus: { x: 600, y: 350 }, anchor: null, obstacles: [view] })).toBeNull();
  });
});
