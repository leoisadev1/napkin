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
  /** Free space near what the user is looking at (pointer, selection, visible area), beside related items. */
  z.object({ kind: z.literal("auto") }),
  /** Where the user's mouse is ("here", "this spot"). Falls back to auto when there is no pointer. */
  z.object({ kind: z.literal("at_pointer") }),
  /** Take the exact spot of an existing item, e.g. replacing a user's rough sketch with a clean shape. */
  z.object({ kind: z.literal("at"), target: NodeId }),
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

export const DiagramKind = z.enum([
  /** Left-to-right process; links optional (defaults to node order). Diamonds read as decisions. */
  "flow",
  /** Closed loop: nodes on a circle, arrows around it in order. */
  "cycle",
  /** Top-down hierarchy using `parent`. */
  "tree",
  /** Radial: the node with parent null is the center, others branch out via `parent`. */
  "mindmap",
  /** Horizontal line with nodes as milestones in order. */
  "timeline",
  /** Stacked narrowing stages, widest first. */
  "funnel",
  /** 2x2 grid: first four nodes are the quadrants (top-left, top-right, bottom-left, bottom-right); `axes` labels x and y. */
  "quadrant",
]);
export type DiagramKind = z.infer<typeof DiagramKind>;

export const DiagramNode = z.object({
  id: NodeId,
  label: z.string().max(120),
  color: Color,
  shape: z.enum(["box", "ellipse", "diamond", "sticky"]),
  /** Parent node id for tree and mindmap; null for the root and for other kinds. */
  parent: NodeId.nullable(),
});
export type DiagramNode = z.infer<typeof DiagramNode>;

export const DiagramLink = z.object({ from: NodeId, to: NodeId, label: z.string().max(60) });
export type DiagramLink = z.infer<typeof DiagramLink>;

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
    /** A laid-out diagram. Re-adding an existing id replaces it in place. Node ids are addressable like shapes. */
    op: z.literal("add_diagram"),
    id: NodeId,
    kind: DiagramKind,
    title: z.string().max(80),
    nodes: z.array(DiagramNode).min(2).max(14),
    /** Extra or explicit links. For flow, empty means sequential. Ignored for cycle/timeline/funnel/quadrant ordering. */
    links: z.array(DiagramLink).max(24),
    /** Axis labels for quadrant: [x, y]. Empty otherwise. */
    axes: z.array(z.string().max(40)).max(2),
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
export const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Rect = z.infer<typeof Rect>;

export const BoardItem = z.object({
  id: NodeId,
  /** "sketch" = something the user drew that isn't a labelled shape: freehand strokes, bare lines, unlabelled boxes. */
  kind: z.enum(["shape", "edge", "frame", "mockup", "image", "diagram", "sketch"]),
  /** Who made it. The agent may edit user items when asked ("label this", "clean up my sketch"). */
  origin: z.enum(["agent", "user"]),
  /** Rounded scene bounds, so "the box on the left" and "below this" can be resolved. */
  bounds: Rect,
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
  /** Mouse position in scene coordinates and the item under or nearest it (within ~160px), or null if off-canvas. */
  pointer: z.object({ x: z.number(), y: z.number(), over: NodeId.nullable() }).nullable(),
  /** Visible scene area. */
  viewport: Rect,
});
export type BoardSummary = z.infer<typeof BoardSummary>;
