/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { NodeMeta } from "./meta";
import { metaData, readMeta } from "./meta";
import type { IdentityElement } from "./identity";
import { dedupeNodeIds } from "./identity";

function el(args: { id: string; type?: string; meta: NodeMeta; groupIds?: string[]; containerId?: string; start?: string; end?: string }): IdentityElement {
  return {
    id: args.id,
    type: args.type ?? "rectangle",
    isDeleted: false,
    groupIds: args.groupIds ?? [],
    customData: metaData(args.meta),
    version: 1,
    versionNonce: 1,
    containerId: args.containerId ?? null,
    startBinding: args.start === undefined ? null : { elementId: args.start },
    endBinding: args.end === undefined ? null : { elementId: args.end },
  };
}

const shape = (nodeId: string, role: "root" | "part"): NodeMeta => ({ kind: "shape", nodeId, role, shape: "box", color: "blue" });

describe("dedupeNodeIds", () => {
  test("leaves a scene without copies untouched", () => {
    const scene = [el({ id: "a", meta: shape("api", "root") }), el({ id: "a-label", type: "text", containerId: "a", meta: shape("api", "part") })];
    expect(dedupeNodeIds(scene)).toBe(scene);
  });

  test("a duplicated shape and its label get a fresh id; the original keeps its own", () => {
    const scene = [
      el({ id: "a", meta: shape("api", "root") }),
      el({ id: "a-label", type: "text", containerId: "a", meta: shape("api", "part") }),
      el({ id: "b", meta: shape("api", "root") }),
      el({ id: "b-label", type: "text", containerId: "b", meta: shape("api", "part") }),
    ];
    const out = new Map(dedupeNodeIds(scene).map((e) => [e.id, readMeta(e)]));
    expect(out.get("a")).toMatchObject({ nodeId: "api" });
    expect(out.get("a-label")).toMatchObject({ nodeId: "api" });
    expect(out.get("b")).toMatchObject({ nodeId: "api-2" });
    expect(out.get("b-label")).toMatchObject({ nodeId: "api-2" });
  });

  test("a copied edge between copied shapes links the copies", () => {
    const edge = (role: "root" | "part"): NodeMeta => ({ kind: "edge", nodeId: "calls", role, from: "web", to: "api" });
    const scene = [
      el({ id: "w", meta: shape("web", "root") }),
      el({ id: "a", meta: shape("api", "root") }),
      el({ id: "e", type: "arrow", meta: edge("root"), start: "w", end: "a" }),
      el({ id: "w2", meta: shape("web", "root") }),
      el({ id: "a2", meta: shape("api", "root") }),
      el({ id: "e2", type: "arrow", meta: edge("root"), start: "w2", end: "a2" }),
      el({ id: "e2-label", type: "text", containerId: "e2", meta: edge("part") }),
    ];
    const out = new Map(dedupeNodeIds(scene).map((e) => [e.id, readMeta(e)]));
    expect(out.get("e")).toMatchObject({ nodeId: "calls", from: "web", to: "api" });
    expect(out.get("e2")).toMatchObject({ nodeId: "calls-2", from: "web-2", to: "api-2" });
    expect(out.get("e2-label")).toMatchObject({ nodeId: "calls-2", from: "web-2", to: "api-2" });
  });

  test("mockup parts follow the copy that shares their group", () => {
    const mock = (role: "root" | "part"): NodeMeta => ({ kind: "mockup", nodeId: "home", role });
    const scene = [
      el({ id: "m", meta: mock("root"), groupIds: ["g1"] }),
      el({ id: "m-title", type: "text", meta: mock("part"), groupIds: ["g1"] }),
      el({ id: "m2", meta: mock("root"), groupIds: ["g2"] }),
      el({ id: "m2-title", type: "text", meta: mock("part"), groupIds: ["g2"] }),
    ];
    const out = new Map(dedupeNodeIds(scene).map((e) => [e.id, readMeta(e)]));
    expect(out.get("m-title")).toMatchObject({ nodeId: "home" });
    expect(out.get("m2-title")).toMatchObject({ nodeId: "home-2" });
  });
});
