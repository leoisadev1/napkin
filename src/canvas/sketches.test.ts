/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { NodeId } from "../../shared/board";
import type { SketchPart } from "./sketches";
import { groupSketches, sketchIdOf, withSketchId } from "./sketches";

function ids(prefix = "sketch") {
  let n = 0;
  return (): NodeId => `${prefix}-${++n}`;
}

const stroke = (id: string, x: number, y: number, updated: number, sketch: NodeId | null = null): SketchPart => ({
  id,
  kind: "stroke",
  rect: { x, y, w: 100, h: 60 },
  updated,
  sketch,
});

describe("groupSketches", () => {
  test("strokes that touch are one sketch, whenever they were drawn", () => {
    const groups = groupSketches({ parts: [stroke("a", 0, 0, 0), stroke("b", 90, 10, 600_000)], makeId: ids() });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.strokes.sort()).toEqual(["a", "b"]);
  });

  test("strokes near each other join only when drawn close in time", () => {
    const together = groupSketches({ parts: [stroke("a", 0, 0, 0), stroke("b", 150, 0, 4_000)], makeId: ids() });
    expect(together).toHaveLength(1);
    const apart = groupSketches({ parts: [stroke("a", 0, 0, 0), stroke("b", 150, 0, 120_000)], makeId: ids() });
    expect(apart).toHaveLength(2);
  });

  test("far-apart strokes are separate sketches", () => {
    const groups = groupSketches({ parts: [stroke("a", 0, 0, 0), stroke("b", 900, 0, 10)], makeId: ids() });
    expect(groups).toHaveLength(2);
  });

  test("text on or right under a sketch labels it; text elsewhere stays out", () => {
    const parts: SketchPart[] = [
      stroke("a", 0, 0, 0),
      { id: "label", kind: "text", rect: { x: 20, y: 66, w: 60, h: 24 }, updated: 0, sketch: null },
      { id: "far", kind: "text", rect: { x: 600, y: 600, w: 60, h: 24 }, updated: 0, sketch: null },
    ];
    const [group, ...rest] = groupSketches({ parts, makeId: ids() });
    expect(rest).toHaveLength(0);
    expect(group?.texts).toEqual(["label"]);
    expect(group?.members).not.toContain("far");
  });

  test("keeps the id its strokes already carry, and a new stroke joins under it", () => {
    const groups = groupSketches({ parts: [stroke("a", 0, 0, 0, "sketch-7"), stroke("b", 50, 20, 1_000)], makeId: ids() });
    expect(groups.map((g) => g.id)).toEqual(["sketch-7"]);
  });

  test("when a sketch splits, the bigger half keeps the id", () => {
    const parts = [stroke("a", 0, 0, 0, "sketch-1"), stroke("b", 50, 0, 0, "sketch-1"), stroke("c", 2000, 0, 0, "sketch-1")];
    const groups = groupSketches({ parts, makeId: ids("fresh") });
    const big = groups.find((g) => g.strokes.length === 2);
    const small = groups.find((g) => g.strokes.length === 1);
    expect(big?.id).toBe("sketch-1");
    expect(small?.id).toBe("fresh-1");
  });
});

describe("sketch ids in customData", () => {
  test("round-trips and keeps other keys", () => {
    const data = withSketchId({ other: 1 }, "sketch-3");
    expect(sketchIdOf({ customData: data })).toBe("sketch-3");
    expect(withSketchId(data, null)).toEqual({ other: 1 });
  });

  test("ignores junk", () => {
    expect(sketchIdOf({ customData: { rtwSketch: "Not An Id" } })).toBeNull();
    expect(sketchIdOf({ customData: undefined })).toBeNull();
  });
});
