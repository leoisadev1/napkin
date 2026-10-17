/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Rect } from "./geometry";
import { bendAround, inflate, overlaps, segmentHitsRect } from "./geometry";
import type { Block } from "./layout";
import { BLOCK_GAP, fitFrame, overlappingPairs, placeInside, settleBlocks } from "./layout";

const box = { w: 240, h: 76 };

/** Places `count` boxes into a frame one by one, refitting it like the bridge does. */
function fill(count: number, size = box): { frame: Rect; items: Rect[] } {
  let frame: Rect = { x: 0, y: 0, w: 440, h: 260 };
  const items: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const at = placeInside({ size, frame, items });
    items.push({ ...at, ...size });
    frame = fitFrame(frame, items);
  }
  return { frame, items };
}

describe("placeInside", () => {
  test("snakes through two columns, so a four-step loop forms a square", () => {
    const { items } = fill(4);
    const [a, b, c, d] = items;
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error("missing items");
    expect(b.y).toBe(a.y);
    expect(b.x).toBeGreaterThan(a.x + a.w);
    expect(c.x).toBe(b.x);
    expect(c.y).toBeGreaterThan(b.y + b.h);
    expect(d.x).toBe(a.x);
    expect(d.y).toBe(c.y);
  });

  test("never overlaps siblings and stays inside the refit frame", () => {
    const { frame, items } = fill(7);
    for (const [i, a] of items.entries()) {
      for (const b of items.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
      expect(a.x).toBeGreaterThanOrEqual(frame.x);
      expect(a.y + a.h).toBeLessThanOrEqual(frame.y + frame.h);
    }
  });

  test("items beside a tall mockup fill the short column first", () => {
    const frame = { x: 0, y: 0, w: 440, h: 260 };
    const mockup = { x: 36, y: 36, w: 300, h: 650 };
    const first = placeInside({ size: box, frame, items: [mockup] });
    const second = placeInside({ size: box, frame, items: [mockup, { ...first, ...box }] });
    expect(first.x).toBeGreaterThan(mockup.x + mockup.w);
    expect(second.x).toBe(first.x);
    expect(second.y).toBeGreaterThan(first.y);
  });
});

describe("settleBlocks", () => {
  const block = (key: string, rect: Rect, order: number, movable = true): Block => ({ key, rect, movable, order });

  test("a frame that grew into its neighbour pushes the later neighbour away, not itself", () => {
    const grown = block("core", { x: 0, y: 0, w: 900, h: 600 }, 0);
    const social = block("social", { x: 640, y: 0, w: 440, h: 260 }, 1);
    const moves = settleBlocks({ blocks: [grown, social], ignore: new Set() });
    expect(moves.has("core")).toBe(false);
    const delta = moves.get("social");
    if (delta === undefined) throw new Error("social should move");
    const moved = { ...social.rect, x: social.rect.x + delta.x, y: social.rect.y + delta.y };
    expect(overlaps(inflate(grown.rect, BLOCK_GAP - 1), moved)).toBe(false);
    // The nearest clear spot is to the right, not below.
    expect(delta.y).toBe(0);
  });

  test("a block beside a frame that grew under it keeps its row instead of dropping below", () => {
    // The left frame grew wide and only a bit taller; sliding down would be shorter, but the block sat to its right.
    const grown = block("core", { x: 0, y: 0, w: 820, h: 330 }, 0);
    const beside = block("screen", { x: 560, y: 0, w: 370, h: 700 }, 1);
    const delta = settleBlocks({ blocks: [grown, beside], ignore: new Set() }).get("screen");
    expect(delta).toEqual({ x: 820 + BLOCK_GAP - 560, y: 0 });
  });

  test("cascades: a pushed block pushes the one after it", () => {
    const blocks = [
      block("a", { x: 0, y: 0, w: 800, h: 300 }, 0),
      block("b", { x: 700, y: 0, w: 300, h: 300 }, 1),
      block("c", { x: 1100, y: 0, w: 300, h: 300 }, 2),
    ];
    const moves = settleBlocks({ blocks, ignore: new Set() });
    const placed = blocks.map((b) => {
      const d = moves.get(b.key) ?? { x: 0, y: 0 };
      return { ...b, rect: { ...b.rect, x: b.rect.x + d.x, y: b.rect.y + d.y } };
    });
    expect(overlappingPairs(placed).size).toBe(0);
  });

  test("user blocks never move and overlaps that already existed are left alone", () => {
    const user = block("u", { x: 0, y: 0, w: 300, h: 300 }, -1, false);
    const agent = block("a", { x: 100, y: 100, w: 300, h: 300 }, 0);
    expect(settleBlocks({ blocks: [user, agent], ignore: overlappingPairs([user, agent]) }).size).toBe(0);
    const moves = settleBlocks({ blocks: [agent, user], ignore: new Set() });
    expect(moves.has("u")).toBe(false);
    expect(moves.has("a")).toBe(true);
  });
});

describe("edge routing", () => {
  test("bends around a node sitting on the straight line", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 0, y: 600 };
    const middle = { x: -120, y: 250, w: 240, h: 100 };
    expect(segmentHitsRect(start, end, middle)).toBe(true);
    const bend = bendAround({ start, end, obstacles: [middle] });
    if (bend === null) throw new Error("expected a bend");
    expect(segmentHitsRect(start, bend, middle)).toBe(false);
    expect(segmentHitsRect(bend, end, middle)).toBe(false);
  });

  test("keeps clear lines straight", () => {
    expect(bendAround({ start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, obstacles: [{ x: 0, y: 100, w: 50, h: 50 }] })).toBeNull();
  });
});
