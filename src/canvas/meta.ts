// Agent metadata stored in each element's customData, so node identity survives user edits, undo and redo.
// customData is untyped scene data (users can paste anything), so it is parsed with zod on every read.
import { z } from "zod";
import { Color, DiagramKind, DiagramLink, DiagramNode, NodeId, ShapeKind } from "../../shared/board";

const Role = z.enum(["root", "part"]);

/** What a diagram was asked to show; kept on its title so a later op can re-lay it out. */
export const DiagramSpecMeta = z.object({
  kind: DiagramKind,
  title: z.string(),
  nodes: z.array(DiagramNode),
  links: z.array(DiagramLink),
  axes: z.array(z.string()),
});

export const NodeMeta = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shape"), nodeId: NodeId, role: Role, shape: ShapeKind, color: Color }),
  /** `title` keeps the frame's name while it is dormant (empty, invisible, name cleared); see bridge.ts. */
  z.object({ kind: z.literal("frame"), nodeId: NodeId, role: Role, title: z.string().optional() }),
  z.object({ kind: z.literal("mockup"), nodeId: NodeId, role: Role }),
  z.object({ kind: z.literal("image"), nodeId: NodeId, role: Role }),
  z.object({ kind: z.literal("edge"), nodeId: NodeId, role: Role, from: NodeId, to: NodeId }),
  /**
   * A laid-out diagram. The root is its title and carries the spec; parts are connectors and decoration. `stamp` keeps
   * element ids stable across re-layouts, so connectors that survive morph instead of redrawing.
   */
  z.object({ kind: z.literal("diagram"), nodeId: NodeId, role: Role, stamp: z.string(), spec: DiagramSpecMeta.optional() }),
  /**
   * One node of a diagram, addressable like a shape. `label` is the full label the agent gave; `shown` is the text the
   * canvas rendered for it (timelines move dates out of the card), so a user edit is detectable.
   */
  z.object({
    kind: z.literal("member"),
    nodeId: NodeId,
    role: Role,
    diagram: NodeId,
    shape: z.enum(["box", "ellipse", "diamond", "sticky", "band", "cell"]),
    color: Color,
    label: z.string(),
    shown: z.string(),
  }),
  /** A fading copy of something just deleted. Never part of the board model. */
  z.object({ kind: z.literal("ghost"), role: Role, source: z.string() }),
  /** Placeholder card for long-running work. Its id is the engine's pending id, not a NodeId. */
  z.object({ kind: z.literal("pending"), pendingId: z.string(), role: Role }),
]);
export type NodeMeta = z.infer<typeof NodeMeta>;
export type NodeKind = Exclude<NodeMeta["kind"], "pending" | "ghost">;

const Envelope = z.object({ rtw: NodeMeta });

// Excalidraw replaces element objects on every change, so caching by object identity is safe.
const cache = new WeakMap<object, NodeMeta | null>();

export function readMeta(element: { readonly customData?: unknown }): NodeMeta | null {
  const hit = cache.get(element);
  if (hit !== undefined) return hit;
  const parsed = Envelope.safeParse(element.customData);
  const meta = parsed.success ? parsed.data.rtw : null;
  cache.set(element, meta);
  return meta;
}

export function metaData(meta: NodeMeta): { rtw: NodeMeta } {
  return { rtw: meta };
}

export function nodeIdOf(meta: NodeMeta | null): NodeId | null {
  if (meta === null || meta.kind === "pending" || meta.kind === "ghost") return null;
  return meta.nodeId;
}
