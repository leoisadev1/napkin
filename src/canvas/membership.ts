// What happens when an op re-uses the id of a node that belongs to a diagram. A diagram moves, settles and re-lays
// out as one rigid block, so none of its nodes may turn into a loose item that stays behind while the rest moves.
import type { BoardOp, NodeId } from "../../shared/board";

export type ReAdd =
  /** Not a diagram node: the usual replace-in-place. */
  | { kind: "plain" }
  /** Same kind of thing (a shape): edit the node inside its diagram, which re-lays out where it stands. */
  | { kind: "edit-member"; diagram: NodeId }
  /** A different kind of item takes the id: the node leaves its diagram first (closing ranks), then the item lands fresh. */
  | { kind: "leave-diagram"; diagram: NodeId };

export function reAddPlan(args: { op: BoardOp["op"]; id: NodeId; owner: NodeId | null }): ReAdd {
  const { op, id, owner } = args;
  if (owner === null || owner === id) return { kind: "plain" };
  return op === "add_shape" ? { kind: "edit-member", diagram: owner } : { kind: "leave-diagram", diagram: owner };
}
