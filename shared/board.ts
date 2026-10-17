// Board operations: the contract between the AI agent (server) and the canvas (client).
// The agent emits semantic operations; the canvas decides exact geometry and styling.
// Frozen contract: change only with the orchestrator's agreement, since both sides depend on it.
import { z } from "zod";

/** Stable, agent-chosen id such as "auth-service". Lowercase kebab-case. */
export const NodeId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "kebab-case id, max 48 chars");
export type NodeId = z.infer<typeof NodeId>;

export const Color = z.enum(["gray", "blue", "green", "yellow", "orange", "red", "purple", "pink", "teal"]);
export type Color = z.infer<typeof Color>;

export const Direction = z.enum(["right", "left", "below", "above"]);
export type Direction = z.infer<typeof Direction>;

/** Where to put a new or moved item. "auto" lets the canvas find free space. */
export const Placement = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  z.object({ kind: z.literal("near"), target: NodeId, direction: Direction }),
  z.object({ kind: z.literal("inside"), frame: NodeId }),
]);
export type Placement = z.infer<typeof Placement>;

export const ShapeKind = z.enum(["box", "ellipse", "diamond", "sticky", "text"]);
export type ShapeKind = z.infer<typeof ShapeKind>;

export const MockupComponent = z.object({
  kind: z.enum(["header", "text", "button", "input", "image", "card", "list", "tabbar", "toggle", "avatar", "chart"]),
  label: z.string().max(80),
});
export type MockupComponent = z.infer<typeof MockupComponent>;

export const BoardOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_shape"),
    id: NodeId,
    shape: ShapeKind,
    label: z.string().max(200),
    color: Color,
    placement: Placement,
  }),
  z.object({
    op: z.literal("add_edge"),
    id: NodeId,
    from: NodeId,
    to: NodeId,
    label: z.string().max(60),
  }),
  z.object({
    op: z.literal("add_frame"),
    id: NodeId,
    title: z.string().max(80),
    placement: Placement,
  }),
  z.object({
    op: z.literal("add_mockup"),
    id: NodeId,
    title: z.string().max(80),
    device: z.enum(["phone", "desktop"]),
    components: z.array(MockupComponent).min(1).max(12),
    placement: Placement,
  }),
  z.object({
    op: z.literal("add_image"),
    id: NodeId,
    /** Short caption shown under the image. */
    caption: z.string().max(80),
    /** Data URL (image/png or image/jpeg) produced server-side. */
    dataUrl: z.string().startsWith("data:image/"),
    placement: Placement,
  }),
  z.object({
    op: z.literal("update"),
    id: NodeId,
    label: z.string().max(200).optional(),
    color: Color.optional(),
  }),
  z.object({ op: z.literal("move"), id: NodeId, placement: Placement }),
  z.object({ op: z.literal("delete"), ids: z.array(NodeId).min(1) }),
  z.object({ op: z.literal("set_title"), title: z.string().max(80) }),
  z.object({ op: z.literal("clear") }),
]);
export type BoardOp = z.infer<typeof BoardOp>;

/** Compact view of the board that the client sends with every turn so the agent can reference items. */
export const BoardItem = z.object({
  id: NodeId,
  kind: z.enum(["shape", "edge", "frame", "mockup", "image"]),
  label: z.string(),
  /** Frame id when the item sits inside a frame. */
  frame: NodeId.nullable(),
  /** For edges: "from -> to". Empty for other kinds. */
  link: z.string(),
});
export type BoardItem = z.infer<typeof BoardItem>;

export const BoardSummary = z.object({
  title: z.string(),
  items: z.array(BoardItem).max(400),
  /** Ids the user currently has selected on the canvas, so "this" and "that" resolve. */
  selection: z.array(NodeId),
});
export type BoardSummary = z.infer<typeof BoardSummary>;
