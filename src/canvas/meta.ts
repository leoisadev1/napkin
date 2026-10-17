// Agent metadata stored in each element's customData, so node identity survives user edits, undo and redo.
// customData is untyped scene data (users can paste anything), so it is parsed with zod on every read.
import { z } from "zod";
import { Color, NodeId, ShapeKind } from "../../shared/board";

const Role = z.enum(["root", "part"]);

export const NodeMeta = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shape"), nodeId: NodeId, role: Role, shape: ShapeKind, color: Color }),
  z.object({ kind: z.literal("frame"), nodeId: NodeId, role: Role }),
  z.object({ kind: z.literal("mockup"), nodeId: NodeId, role: Role }),
  z.object({ kind: z.literal("image"), nodeId: NodeId, role: Role }),
  z.object({ kind: z.literal("edge"), nodeId: NodeId, role: Role, from: NodeId, to: NodeId }),
  /** Placeholder card for long-running work. Its id is the engine's pending id, not a NodeId. */
  z.object({ kind: z.literal("pending"), pendingId: z.string(), role: Role }),
]);
export type NodeMeta = z.infer<typeof NodeMeta>;
export type NodeKind = Exclude<NodeMeta["kind"], "pending">;

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
  if (meta === null || meta.kind === "pending") return null;
  return meta.nodeId;
}
