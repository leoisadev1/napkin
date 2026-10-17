/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { reAddPlan } from "./membership";

// Regression: an add_shape that re-used a mindmap node's id replaced the node with a loose box. Settling then slid
// the rest of the diagram away from it, leaving the box stranded with a connector stub pointing at nothing.
describe("reAddPlan", () => {
  test("re-adding a diagram node as a shape edits it inside its diagram", () => {
    expect(reAddPlan({ op: "add_shape", id: "painful-task", owner: "angle-map" })).toEqual({ kind: "edit-member", diagram: "angle-map" });
  });

  test("another kind of item under a node's id takes the node out of its diagram first", () => {
    for (const op of ["add_frame", "add_mockup", "add_image", "add_diagram"] as const) {
      expect(reAddPlan({ op, id: "painful-task", owner: "angle-map" })).toEqual({ kind: "leave-diagram", diagram: "angle-map" });
    }
  });

  test("loose nodes and the diagram itself replace in place as before", () => {
    expect(reAddPlan({ op: "add_shape", id: "loose", owner: null })).toEqual({ kind: "plain" });
    expect(reAddPlan({ op: "add_diagram", id: "angle-map", owner: "angle-map" })).toEqual({ kind: "plain" });
  });
});
