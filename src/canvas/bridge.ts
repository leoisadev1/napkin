// BoardBridge over an Excalidraw scene. The scene is the source of truth: every agent element carries its
// NodeId in customData (see meta.ts), so user moves, edits, undo and redo never desync the agent's view.
import { CaptureUpdateAction, convertToExcalidrawElements, getVisibleSceneBounds, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardItem, BoardOp, BoardSummary, Placement } from "../../shared/board";
import { NodeId } from "../../shared/board";
import type { BoardBridge } from "../conversation/types";
import type { Animator } from "./animator";
import { createAnimator } from "./animator";
import type { Built, IdFactory } from "./builders";
import { arrowGeometry, buildArrow, buildFrame, buildImage, buildMockup, buildPending, buildShape, wrap } from "./builders";
import type { Outline, Point, Rect } from "./geometry";
import { boundsOf } from "./bounds";
import { bendAround, center, contains, edgePoint, inflate, overlaps, union } from "./geometry";
import { mimeOf, readImageSize } from "./imageSize";
import { dedupeNodeIds } from "./identity";
import type { Block } from "./layout";
import { besideSpot, fitFrame, isFree, nearestFree, overlappingPairs, placeAuto, placeInside, placeNear, settleBlocks } from "./layout";
import type { NodeKind, NodeMeta } from "./meta";
import { nodeIdOf, readMeta } from "./meta";
import { SWATCHES } from "./palette";

export const DEFAULT_TITLE = "Untitled board";

type Insets = { top: number; bottom: number; left: number; right: number };

/**
 * Screen-space insets covered by the app's floating chrome, so "in view" means actually visible. The bottom covers
 * the dock plus a two-line caption. Phones (the 730px breakpoint in ui.css) stack Excalidraw's toolbar and the title
 * row on top and keep a lock column on the right.
 */
export function chromeInsets(viewportWidth: number): Insets {
  return viewportWidth <= 730 ? { top: 116, bottom: 300, left: 16, right: 52 } : { top: 80, bottom: 272, left: 32, right: 32 };
}

const ROW_GAP = 96;
const EDGE_GAP = 8;
/** Frame names render above the frame's top edge; keep that strip clear too. */
const FRAME_TITLE_ROOM = 32;
/** Below this zoom hand-drawn labels stop being legible. */
const MIN_READABLE_ZOOM = 0.45;

export interface CanvasBridge extends BoardBridge {
  getTitle(): string;
  setTitle(title: string): void;
  /** Fires when the title changes, from either the agent or the user. */
  subscribeTitle(listener: (title: string) => void): () => void;
  dispose(): void;
}

type NodeEntry = {
  id: NodeId;
  kind: NodeKind;
  root: ExcalidrawElement;
  /** Every element that belongs to the node. Frames list only themselves, not their children. */
  elements: ExcalidrawElement[];
  meta: NodeMeta | null;
};

function isDataURL(value: string): value is DataURL {
  return value.startsWith("data:");
}
function isFileId(value: string): value is FileId {
  return value.length > 0;
}

/** Stable NodeId for an element the user drew, derived from its Excalidraw id. */
export function userNodeId(elementId: string): NodeId | null {
  const parsed = NodeId.safeParse(`u-${elementId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}`);
  return parsed.success ? parsed.data : null;
}

function isLive(el: ExcalidrawElement): boolean {
  return !el.isDeleted;
}

function containerIdOf(el: ExcalidrawElement): string | null {
  return el.type === "text" ? el.containerId : null;
}

function outlineOf(el: ExcalidrawElement): Outline {
  if (el.type === "ellipse") return "ellipse";
  if (el.type === "diamond") return "diamond";
  return "rect";
}

/** Groups live scene elements into nodes: agent nodes by customData, user elements by derived id. */
function indexNodes(elements: readonly ExcalidrawElement[]): Map<NodeId, NodeEntry> {
  const nodes = new Map<NodeId, NodeEntry>();
  const live = elements.filter(isLive);
  const byId = new Map(live.map((el) => [el.id, el]));
  const roots: NodeEntry[] = [];
  const parts = new Map<NodeId, ExcalidrawElement[]>();

  for (const el of live) {
    const meta = readMeta(el);
    const nodeId = nodeIdOf(meta);
    if (meta !== null && meta.kind !== "pending" && nodeId !== null) {
      if (meta.role === "root") roots.push({ id: nodeId, kind: meta.kind, root: el, elements: [], meta });
      const list = parts.get(nodeId) ?? [];
      list.push(el);
      parts.set(nodeId, list);
      continue;
    }
    if (meta !== null) continue;
    // User-drawn element. Bound text belongs to its container.
    if (containerIdOf(el) !== null && byId.has(containerIdOf(el) ?? "")) continue;
    const id = userNodeId(el.id);
    if (id === null) continue;
    const kind: NodeKind | null =
      el.type === "frame" || el.type === "magicframe"
        ? "frame"
        : el.type === "image"
          ? "image"
          : el.type === "arrow"
            ? "edge"
            : el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond" || el.type === "text"
              ? "shape"
              : null;
    if (kind === null) continue;
    const bound = (el.boundElements ?? []).flatMap((b) => {
      const child = b.type === "text" ? byId.get(b.id) : undefined;
      return child === undefined ? [] : [child];
    });
    roots.push({ id, kind, root: el, elements: [el, ...bound], meta: null });
  }

  for (const entry of roots) {
    if (entry.meta !== null) entry.elements = parts.get(entry.id) ?? [entry.root];
    nodes.set(entry.id, entry);
  }
  return nodes;
}

function labelOf(entry: NodeEntry, byId: ReadonlyMap<string, ExcalidrawElement>): string {
  const textOf = (el: ExcalidrawElement | undefined): string => (el !== undefined && el.type === "text" ? el.originalText || el.text : "");
  const root = entry.root;
  if (root.type === "frame" || root.type === "magicframe") return root.name ?? "";
  if (root.type === "text") return textOf(root);
  const bound = (root.boundElements ?? []).find((b) => b.type === "text");
  if (bound !== undefined) return textOf(byId.get(bound.id));
  // Mockup title, image caption: the first standalone text part.
  const text = entry.elements.find((el) => el.type === "text" && el.containerId === null && el.id !== root.id);
  return textOf(text);
}

export function createBoardBridge(api: ExcalidrawImperativeAPI, options: { onError?: (error: unknown) => void } = {}): CanvasBridge {
  const animator: Animator = createAnimator(api);
  const titleListeners = new Set<(title: string) => void>();
  let title = DEFAULT_TITLE;
  let seq = 0;
  let lastPlaced: NodeId | null = null;
  let followTimer: number | null = null;
  const pendingFollow = new Set<string>();

  const ids = (nodeId: string): IdFactory => {
    const stamp = `${Date.now().toString(36)}${(seq++).toString(36)}`;
    return (part) => `${nodeId}~${stamp}~${part}`;
  };

  // ---- Scene transaction ------------------------------------------------------------------------

  /** `overlapsBefore` holds block pairs that already overlapped, so settling only fixes clashes this change made. */
  type Tx = { elements: ExcalidrawElement[]; overlapsBefore: Set<string> };

  function begin(): Tx {
    const elements = [...dedupeNodeIds(api.getSceneElementsIncludingDeleted())];
    return { elements, overlapsBefore: overlappingPairs(blocksOf(elements).map((b) => b.block)) };
  }

  function replace(tx: Tx, next: ExcalidrawElement) {
    const i = tx.elements.findIndex((el) => el.id === next.id);
    if (i >= 0) tx.elements[i] = next;
    else tx.elements.push(next);
  }

  function patch(tx: Tx, id: string, update: (el: ExcalidrawElement) => ExcalidrawElement) {
    const i = tx.elements.findIndex((el) => el.id === id);
    const current = tx.elements[i];
    if (current !== undefined) tx.elements[i] = update(current);
  }

  /** Inserts new elements; frame children go right before their frame so stacking stays sensible. */
  function insert(tx: Tx, elements: readonly ExcalidrawElement[], frameId: string | null) {
    const at = frameId === null ? -1 : tx.elements.findIndex((el) => el.id === frameId);
    if (at < 0) tx.elements.push(...elements);
    else tx.elements.splice(at, 0, ...elements);
  }

  function remove(tx: Tx, elementIds: ReadonlySet<string>) {
    tx.elements = tx.elements.map((el) => (elementIds.has(el.id) && !el.isDeleted ? newElementWith(el, { isDeleted: true }) : el));
  }

  /** Rebuilds every bindable element's arrow list from the arrows' own bindings. */
  function syncBindings(tx: Tx) {
    const arrowsByTarget = new Map<string, string[]>();
    for (const el of tx.elements) {
      if (el.isDeleted || el.type !== "arrow") continue;
      for (const binding of [el.startBinding, el.endBinding]) {
        if (binding === null) continue;
        const list = arrowsByTarget.get(binding.elementId) ?? [];
        if (!list.includes(el.id)) list.push(el.id);
        arrowsByTarget.set(binding.elementId, list);
      }
    }
    tx.elements = tx.elements.map((el) => {
      if (el.isDeleted || el.type === "arrow" || el.type === "line" || el.type === "freedraw") return el;
      const current = el.boundElements ?? [];
      const texts = current.filter((b) => b.type === "text");
      const arrows = (arrowsByTarget.get(el.id) ?? []).map((id) => ({ id, type: "arrow" as const }));
      const next = [...texts, ...arrows];
      const same = next.length === current.length && next.every((b, i) => current[i]?.id === b.id && current[i]?.type === b.type);
      if (same) return el;
      return newElementWith(el, { boundElements: next.length === 0 ? null : next });
    });
  }

  function commit(tx: Tx, capture: "undoable" | "silent" = "undoable") {
    settle(tx);
    rerouteAgentEdges(tx);
    liftHiddenLabels(tx);
    syncBindings(tx);
    api.updateScene({
      elements: tx.elements,
      captureUpdate: capture === "undoable" ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER,
    });
  }

  // ---- Geometry helpers -------------------------------------------------------------------------

  function nodeRect(entry: NodeEntry): Rect | null {
    return boundsOf(entry.kind === "frame" ? [entry.root] : entry.elements);
  }

  function obstacles(tx: Tx, exclude: ReadonlySet<string>): Rect[] {
    const rects: Rect[] = [];
    for (const el of tx.elements) {
      if (el.isDeleted || exclude.has(el.id) || el.frameId !== null || el.type === "arrow") continue;
      if (containerIdOf(el) !== null) continue;
      const r = boundsOf([el]);
      if (r !== null) rects.push(el.type === "frame" || el.type === "magicframe" ? withTitle(r) : r);
    }
    return rects;
  }

  function withTitle(r: Rect): Rect {
    return { x: r.x, y: r.y - FRAME_TITLE_ROOM, w: r.w, h: r.h + FRAME_TITLE_ROOM };
  }

  /** The frame's nodes in creation order, one rect per node. */
  function frameItems(tx: Tx, frameElementId: string, exclude: ReadonlySet<string>): Rect[] {
    const order = new Map(tx.elements.map((el, i) => [el.id, i]));
    const items: { index: number; rect: Rect }[] = [];
    for (const entry of indexNodes(tx.elements).values()) {
      if (entry.kind === "edge" || entry.root.frameId !== frameElementId || exclude.has(entry.root.id)) continue;
      const rect = nodeRect(entry);
      if (rect !== null) items.push({ index: order.get(entry.root.id) ?? 0, rect });
    }
    return items.sort((a, b) => a.index - b.index).map((item) => item.rect);
  }

  function frameChildren(tx: Tx, frameElementId: string, exclude: ReadonlySet<string>): Rect[] {
    const rects: Rect[] = [];
    for (const el of tx.elements) {
      if (el.isDeleted || el.frameId !== frameElementId || exclude.has(el.id) || el.type === "arrow" || containerIdOf(el) !== null) continue;
      const r = boundsOf([el]);
      if (r !== null) rects.push(r);
    }
    return rects;
  }

  /** Where the first item on an empty board goes: upper left of the visible area, so the board grows into space. */
  function startPoint(size: { w: number; h: number }): Point {
    const state = api.getAppState();
    const insets = chromeInsets(state.width);
    const [minX, minY, maxX, maxY] = getVisibleSceneBounds(state);
    const zoom = state.zoom.value;
    const top = minY + insets.top / zoom;
    const bottom = maxY - insets.bottom / zoom;
    const width = maxX - minX;
    const cx = (minX + maxX) / 2 - Math.min(width * 0.22, 320 / zoom);
    const y = top + Math.max(0, (bottom - top) * 0.12);
    // placeAuto centers on this point, so convert the desired top-left into a center.
    return { x: Math.max(minX + 48 / zoom + size.w / 2, cx), y: y + size.h / 2 };
  }

  /** Zoom at which `rect` fills the area between the app's floating chrome. */
  function fitZoom(rect: Rect): number {
    const state = api.getAppState();
    const insets = chromeInsets(state.width);
    const w = state.width - insets.left - insets.right;
    const h = state.height - insets.top - insets.bottom;
    return Math.min(w / Math.max(rect.w, 1), h / Math.max(rect.h, 1));
  }

  type Resolved = { at: Point; frame: { element: ExcalidrawElement } | null };

  /** Picks a top-left position for a node of `size`; `exclude` holds the node's own elements when moving. */
  function resolve(tx: Tx, placement: Placement, size: { w: number; h: number }, exclude: ReadonlySet<string>): Resolved {
    const nodes = indexNodes(tx.elements);
    switch (placement.kind) {
      case "inside": {
        const frame = nodes.get(placement.frame);
        if (frame !== undefined && frame.kind === "frame") {
          const rect = boundsOf([frame.root]);
          if (rect !== null) {
            const at = placeInside({ size, frame: rect, items: frameItems(tx, frame.root.id, exclude) });
            return { at, frame: { element: frame.root } };
          }
        }
        return resolve(tx, { kind: "auto" }, size, exclude);
      }
      case "near": {
        const target = nodes.get(placement.target);
        const rect = target === undefined ? null : nodeRect(target);
        if (target === undefined || rect === null) return resolve(tx, { kind: "auto" }, size, exclude);
        // Next to something inside a frame: stay in that frame, which grows to fit.
        const frameEl = target.root.frameId === null ? undefined : tx.elements.find((el) => el.id === target.root.frameId && !el.isDeleted);
        if (frameEl !== undefined) {
          const frameRect = boundsOf([frameEl]);
          if (frameRect !== null) {
            // Right beside the target when that spot is open; otherwise the frame's next grid slot, which keeps the
            // frame tidy instead of wandering off to whatever gap the nudging finds.
            const items = frameItems(tx, frameEl.id, exclude);
            const beside = besideSpot({ size, target: rect, direction: placement.direction });
            const at = isFree({ size, at: beside, obstacles: items }) ? beside : placeInside({ size, frame: frameRect, items });
            return { at, frame: { element: frameEl } };
          }
        }
        return { at: placeNear({ size, target: rect, direction: placement.direction, obstacles: obstacles(tx, exclude) }), frame: null };
      }
      case "auto": {
        const anchorEntry = lastPlaced === null ? undefined : nodes.get(lastPlaced);
        // Something placed inside a frame anchors by its frame, so new blocks go beside the frame, not into it.
        const anchorFrame =
          anchorEntry === undefined || anchorEntry.root.frameId === null
            ? undefined
            : tx.elements.find((el) => el.id === anchorEntry.root.frameId && !el.isDeleted);
        const anchorRect = anchorFrame !== undefined ? boundsOf([anchorFrame]) : anchorEntry === undefined ? null : nodeRect(anchorEntry);
        const blocked = obstacles(tx, exclude);
        const content = union(blocked);
        if (anchorRect === null || content === null) {
          return { at: placeAuto({ size, anchor: null, viewportCenter: startPoint(size), obstacles: blocked }), frame: null };
        }
        // Beside the last thing, or a new row under everything: whichever keeps the whole board larger on screen.
        const beside = placeAuto({ size, anchor: anchorRect, viewportCenter: startPoint(size), obstacles: blocked });
        const row = nearestFree({ size, preferred: { x: content.x, y: content.y + content.h + ROW_GAP }, obstacles: blocked });
        const zoomWith = (at: Point) => fitZoom(union([content, { ...at, ...size }]) ?? content);
        return { at: zoomWith(row) > zoomWith(beside) * 1.05 ? row : beside, frame: null };
      }
      default: {
        const _exhaustive: never = placement;
        return _exhaustive;
      }
    }
  }

  function translate(el: ExcalidrawElement, dx: number, dy: number): ExcalidrawElement {
    return newElementWith(el, { x: el.x + dx, y: el.y + dy });
  }

  /** Places freshly built elements (built at the origin) and inserts them. Returns the placed elements. */
  function place(tx: Tx, built: Built, placement: Placement): ExcalidrawElement[] {
    const bounds = boundsOf(built.elements) ?? { x: 0, y: 0, w: 0, h: 0 };
    const { at, frame } = resolve(tx, placement, { w: bounds.w, h: bounds.h }, new Set());
    const dx = at.x - bounds.x;
    const dy = at.y - bounds.y;
    const placed = built.elements.map((el) => {
      const moved = { ...el, x: el.x + dx, y: el.y + dy };
      return frame === null ? moved : { ...moved, frameId: frame.element.id };
    });
    insert(tx, placed, frame?.element.id ?? null);
    if (frame !== null) refitFrame(tx, frame.element.id);
    return placed;
  }

  /** Re-wraps a frame around its children after something was placed, moved or removed inside it. */
  function refitFrame(tx: Tx, frameElementId: string) {
    const frame = tx.elements.find((el) => el.id === frameElementId && !el.isDeleted);
    const rect = frame === undefined ? null : boundsOf([frame]);
    if (frame === undefined || rect === null) return;
    const next = fitFrame(rect, frameChildren(tx, frameElementId, new Set()));
    if (next.x === rect.x && next.y === rect.y && next.w === rect.w && next.h === rect.h) return;
    patch(tx, frameElementId, (el) => newElementWith(el, { x: next.x, y: next.y, width: next.w, height: next.h }));
  }

  // ---- Settling ------------------------------------------------------------------------------

  /** Agent blocks in the order they were placed this session; older ones sort first by scene order. */
  const placedOrder = new Map<string, number>();
  let placedSeq = 0;
  const markPlaced = (key: string) => placedOrder.set(key, placedSeq++);

  type BlockInfo = { block: Block; elementIds: string[]; nodeIds: NodeId[] };

  /** Top-level blocks: frames with everything inside them, loose nodes, and pending cards. */
  function blocksOf(elements: readonly ExcalidrawElement[]): BlockInfo[] {
    const nodes = indexNodes(elements);
    const index = new Map(elements.map((el, i) => [el.id, i]));
    const live = elements.filter(isLive);
    const order = (key: string, rootId: string) => placedOrder.get(key) ?? (index.get(rootId) ?? 0) - 1e6;
    const out: BlockInfo[] = [];
    for (const entry of nodes.values()) {
      if (entry.kind === "edge" || entry.root.frameId !== null) continue;
      const movable = entry.meta !== null;
      if (entry.kind === "frame") {
        const inside = live.filter((el) => el.frameId === entry.root.id);
        const frameRect = boundsOf([entry.root]);
        if (frameRect === null) continue;
        const rect = boundsOf([entry.root, ...inside]) ?? frameRect;
        const nodeIds = [entry.id, ...[...nodes.values()].filter((n) => n.root.frameId === entry.root.id).map((n) => n.id)];
        out.push({
          block: { key: entry.id, rect: withTitle(rect), movable, order: order(entry.id, entry.root.id) },
          elementIds: [entry.root.id, ...inside.map((el) => el.id)],
          nodeIds,
        });
        continue;
      }
      const rect = nodeRect(entry);
      if (rect === null) continue;
      out.push({ block: { key: entry.id, rect, movable, order: order(entry.id, entry.root.id) }, elementIds: entry.elements.map((el) => el.id), nodeIds: [entry.id] });
    }
    for (const card of pendingCards({ elements: [...elements], overlapsBefore: new Set() })) {
      const key = `pending:${card.pendingId}`;
      out.push({ block: { key, rect: card.rect, movable: true, order: placedOrder.get(key) ?? Number.MAX_SAFE_INTEGER }, elementIds: card.elementIds, nodeIds: [] });
    }
    return out;
  }

  /** Moves top-level blocks apart after a change, carrying frame contents along and re-aiming their arrows. */
  function settle(tx: Tx) {
    const blocks = blocksOf(tx.elements);
    const moves = settleBlocks({ blocks: blocks.map((b) => b.block), ignore: tx.overlapsBefore });
    if (moves.size === 0) return;
    const touched = new Set<NodeId>();
    for (const info of blocks) {
      const delta = moves.get(info.block.key);
      if (delta === undefined) continue;
      for (const id of info.elementIds) patch(tx, id, (el) => translate(el, delta.x, delta.y));
      for (const id of info.nodeIds) touched.add(id);
    }
    reroute(tx, touched);
  }

  /**
   * Arrows sit under shapes so crossings stay tidy, but a label that lands on a shape would be hidden.
   * Those arrows move to the top of the stack.
   */
  function liftHiddenLabels(tx: Tx) {
    const nodes = indexNodes(tx.elements);
    const solids: { rect: Rect }[] = [];
    for (const entry of nodes.values()) {
      if (entry.kind === "edge" || entry.kind === "frame") continue;
      const rect = nodeRect(entry);
      if (rect !== null) solids.push({ rect });
    }
    const lift: string[] = [];
    for (const entry of nodes.values()) {
      const arrow = entry.root;
      if (entry.kind !== "edge" || arrow.type !== "arrow") continue;
      const label = entry.elements.find((el) => el.type === "text");
      const last = arrow.points.at(-1);
      if (label === undefined || last === undefined) continue;
      // Excalidraw centers a label on the middle point of a bent arrow, or halfway along a straight one.
      const middle = arrow.points.length === 3 ? arrow.points[1] : undefined;
      const mid = middle === undefined ? { x: arrow.x + last[0] / 2, y: arrow.y + last[1] / 2 } : { x: arrow.x + middle[0], y: arrow.y + middle[1] };
      const box = { x: mid.x - label.width / 2, y: mid.y - label.height / 2, w: label.width, h: label.height };
      if (solids.some((s) => overlaps(s.rect, box))) lift.push(...entry.elements.map((el) => el.id));
    }
    if (lift.length === 0) return;
    const set = new Set(lift);
    tx.elements = [...tx.elements.filter((el) => !set.has(el.id)), ...tx.elements.filter((el) => set.has(el.id))];
  }

  // ---- Edges --------------------------------------------------------------------------------

  type Size = { w: number; h: number };

  /** Rough size of an arrow label as buildArrow wraps it. */
  function labelSize(label: string): Size {
    if (label.trim().length === 0) return { w: 0, h: 0 };
    const lines = wrap(label.trim(), 18).split("\n");
    return { w: Math.max(...lines.map((l) => l.length)) * 17 * 0.56, h: lines.length * 22 };
  }

  type Route = { start: Point; end: Point; bend: Point | null };

  /** Edge-to-edge line between two nodes, bent around any other node that sits in the way. */
  function edgeRoute(args: { nodes: ReadonlyMap<NodeId, NodeEntry>; self: NodeId; from: NodeEntry; to: NodeEntry; label: Size }): Route | null {
    const { nodes, self, from, to, label } = args;
    const a = nodeRect(from.kind === "mockup" || from.kind === "image" ? { ...from, elements: [from.root] } : from);
    const b = nodeRect(to.kind === "mockup" || to.kind === "image" ? { ...to, elements: [to.root] } : to);
    if (a === null || b === null) return null;
    const straight = {
      start: edgePoint({ rect: a, outline: outlineOf(from.root), toward: center(b), gap: EDGE_GAP }),
      end: edgePoint({ rect: b, outline: outlineOf(to.root), toward: center(a), gap: EDGE_GAP }),
    };
    const obstacles: Rect[] = [];
    for (const entry of nodes.values()) {
      if (entry.kind === "edge" || entry.kind === "frame" || entry.id === from.id || entry.id === to.id) continue;
      const rect = nodeRect(entry);
      if (rect !== null) obstacles.push(inflate(rect, 12));
    }
    // A second edge between the same pair (often the reply direction) bows out so the two labels don't stack.
    const twin = [...nodes.values()].some((n) => {
      const m = n.meta;
      return n.id !== self && m !== null && m.kind === "edge" && ((m.from === from.id && m.to === to.id) || (m.from === to.id && m.to === from.id));
    });
    const bend = bendAround({ ...straight, obstacles }) ?? (twin ? bow(straight, label) : null);
    if (bend === null) return { ...straight, bend: null };
    return {
      start: edgePoint({ rect: a, outline: outlineOf(from.root), toward: bend, gap: EDGE_GAP }),
      end: edgePoint({ rect: b, outline: outlineOf(to.root), toward: bend, gap: EDGE_GAP }),
      bend,
    };
  }

  /**
   * A point beside the middle of a line, far enough out that the edge's own label clears the line.
   * A->B and B->A bow to opposite sides, so twin edges and their labels split apart.
   */
  function bow(line: { start: Point; end: Point }, label: Size): Point {
    const { start: a, end: b } = line;
    const len = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1);
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const offset = Math.max(28, (Math.abs(nx) * label.w + Math.abs(ny) * label.h) / 2 + 10);
    return { x: (a.x + b.x) / 2 + nx * offset, y: (a.y + b.y) / 2 + ny * offset };
  }

  function routeGeometry(route: Route) {
    const { start, end, bend } = route;
    return arrowGeometry({ x: start.x, y: start.y, dx: end.x - start.x, dy: end.y - start.y, bend: bend === null ? null : { x: bend.x - start.x, y: bend.y - start.y } });
  }

  function addEdge(tx: Tx, op: Extract<BoardOp, { op: "add_edge" }>): ExcalidrawElement[] {
    const nodes = indexNodes(tx.elements);
    const from = nodes.get(op.from);
    const to = nodes.get(op.to);
    if (from === undefined || to === undefined || op.from === op.to) return [];
    const ends = edgeRoute({ nodes, self: op.id, from, to, label: labelSize(op.label) });
    if (ends === null) return [];
    const geometry = routeGeometry(ends);
    const built = buildArrow({
      nodeId: op.id,
      id: ids(op.id),
      from: op.from,
      to: op.to,
      label: op.label,
      x: ends.start.x,
      y: ends.start.y,
      dx: ends.end.x - ends.start.x,
      dy: ends.end.y - ends.start.y,
    });
    const elements = built.elements.map((el) =>
      el.id === built.rootId && el.type === "arrow"
        ? {
            ...el,
            ...geometry,
            startBinding: { elementId: from.root.id, focus: 0, gap: EDGE_GAP },
            endBinding: { elementId: to.root.id, focus: 0, gap: EDGE_GAP },
          }
        : el,
    );
    // Arrows sit under shapes, so labels on the shapes stay readable where lines cross.
    tx.elements.unshift(...elements);
    return elements;
  }

  /** Re-aims every arrow touching `nodeIds` after those nodes moved or changed size. */
  function reroute(tx: Tx, nodeIds: ReadonlySet<NodeId>, options: { agentOnly: boolean } = { agentOnly: false }) {
    const nodes = indexNodes(tx.elements);
    for (const entry of nodes.values()) {
      if (entry.kind !== "edge" || entry.root.type !== "arrow") continue;
      const arrow = entry.root;
      const meta = entry.meta;
      if (options.agentOnly && meta === null) continue;
      const fromId = meta !== null && meta.kind === "edge" ? meta.from : nodeIdForElement(nodes, arrow.startBinding?.elementId ?? null);
      const toId = meta !== null && meta.kind === "edge" ? meta.to : nodeIdForElement(nodes, arrow.endBinding?.elementId ?? null);
      if (fromId === null || toId === null || (!nodeIds.has(fromId) && !nodeIds.has(toId))) continue;
      const from = nodes.get(fromId);
      const to = nodes.get(toId);
      if (from === undefined || to === undefined) continue;
      const text = entry.elements.find((el) => el.type === "text");
      const ends = edgeRoute({ nodes, self: entry.id, from, to, label: text === undefined ? { w: 0, h: 0 } : { w: text.width, h: text.height } });
      if (ends === null) continue;
      const geometry = routeGeometry(ends);
      patch(tx, arrow.id, (el) =>
        el.type === "arrow"
          ? newElementWith(el, {
              ...geometry,
              startBinding: { elementId: from.root.id, focus: 0, gap: EDGE_GAP },
              endBinding: { elementId: to.root.id, focus: 0, gap: EDGE_GAP },
            })
          : el,
      );
      // Arrow labels are positioned by Excalidraw relative to the arrow midpoint on render.
    }
  }

  /** Re-aims every agent arrow, so lines bend around whatever landed on them. User-drawn arrows keep their shape. */
  function rerouteAgentEdges(tx: Tx) {
    const ids = new Set<NodeId>();
    for (const entry of indexNodes(tx.elements).values()) {
      const meta = entry.meta;
      if (meta !== null && meta.kind === "edge") {
        ids.add(meta.from);
        ids.add(meta.to);
      }
    }
    reroute(tx, ids, { agentOnly: true });
  }

  function nodeIdForElement(nodes: ReadonlyMap<NodeId, NodeEntry>, elementId: string | null): NodeId | null {
    if (elementId === null) return null;
    for (const entry of nodes.values()) if (entry.elements.some((el) => el.id === elementId)) return entry.id;
    return null;
  }

  // ---- Feedback: fade in, partner cursor, follow --------------------------------------------

  /** Where the partner's cursor rests on an item: lower right, clear of centered labels. */
  function restingPoint(rect: Rect): Point {
    return { x: rect.x + rect.w * 0.78, y: rect.y + rect.h * 0.82 };
  }

  function announce(placed: readonly ExcalidrawElement[], stagger: "together" | "sequence") {
    if (placed.length === 0) return;
    const groups = stagger === "sequence" ? placed.map((el) => [el]) : [placed];
    animator.fadeIn(groups, stagger === "sequence" ? Math.max(8, Math.min(45, 900 / placed.length)) : 0);
    const rect = boundsOf(placed);
    if (rect !== null) animator.pointAt(restingPoint(rect), placed.filter((el) => containerIdOf(el) === null).map((el) => el.id));
    for (const el of placed) pendingFollow.add(el.id);
    if (followTimer !== null) window.clearTimeout(followTimer);
    followTimer = window.setTimeout(follow, 140);
  }

  /** Smoothly brings new items into view, fitting the whole board when they land off screen. */
  function follow() {
    followTimer = null;
    const live = api.getSceneElements();
    const fresh = live.filter((el) => pendingFollow.has(el.id));
    pendingFollow.clear();
    const rect = boundsOf(fresh);
    if (rect === null) return;
    const state = api.getAppState();
    const insets = chromeInsets(state.width);
    const zoom = state.zoom.value;
    const [minX, minY, maxX, maxY] = getVisibleSceneBounds(state);
    const visible = {
      x: minX + insets.left / zoom,
      y: minY + insets.top / zoom,
      w: maxX - minX - (insets.left + insets.right) / zoom,
      h: maxY - minY - (insets.top + insets.bottom) / zoom,
    };
    // Recenter a little before items touch the edge, not after.
    const margin = 48 / zoom;
    if (contains({ x: visible.x + margin, y: visible.y + margin, w: visible.w - margin * 2, h: visible.h - margin * 2 }, rect)) return;
    // Fit the whole board while it stays readable; past that (small screens, big boards) frame the new items.
    const all = boundsOf(live);
    const screenW = state.width - insets.left - insets.right;
    const screenH = state.height - insets.top - insets.bottom;
    const fitZoom = all === null ? 1 : Math.min(screenW / Math.max(all.w, 1), screenH / Math.max(all.h, 1)) * 0.92;
    const target = fitZoom >= MIN_READABLE_ZOOM ? live : fresh;
    api.scrollToContent(target, {
      fitToViewport: true,
      viewportZoomFactor: 0.92,
      animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      duration: 650,
      maxZoom: 1,
      minZoom: target === live ? 0.1 : MIN_READABLE_ZOOM,
      canvasOffsets: insets,
    });
  }

  // ---- Ops ----------------------------------------------------------------------------------

  function liveEntry(tx: Tx, id: NodeId): NodeEntry | undefined {
    return indexNodes(tx.elements).get(id);
  }

  /** Element ids that `delete` removes for a node: its own, a frame's contents, and attached edges. */
  function deletionSet(tx: Tx, rootIds: readonly NodeId[]): Set<string> {
    const nodes = indexNodes(tx.elements);
    const out = new Set<string>();
    const doomed = new Set<NodeId>();
    const visit = (id: NodeId) => {
      const entry = nodes.get(id);
      if (entry === undefined || doomed.has(id)) return;
      doomed.add(id);
      for (const el of entry.elements) out.add(el.id);
      if (entry.kind === "frame") {
        for (const el of tx.elements) {
          if (el.frameId !== entry.root.id || el.isDeleted) continue;
          out.add(el.id);
          const childNode = nodeIdForElement(nodes, el.id);
          if (childNode !== null) visit(childNode);
        }
      }
    };
    for (const id of rootIds) visit(id);
    // Edges touching anything removed go too.
    for (const entry of nodes.values()) {
      if (entry.kind !== "edge" || entry.root.type !== "arrow") continue;
      const meta = entry.meta;
      const ends =
        meta !== null && meta.kind === "edge"
          ? [meta.from, meta.to]
          : [nodeIdForElement(nodes, entry.root.startBinding?.elementId ?? null), nodeIdForElement(nodes, entry.root.endBinding?.elementId ?? null)];
      if (ends.some((id) => id !== null && doomed.has(id))) for (const el of entry.elements) out.add(el.id);
    }
    return out;
  }

  function retext(el: ExcalidrawElement, text: string): ExcalidrawElement {
    if (el.type !== "text") return el;
    const [fresh] = convertToExcalidrawElements([
      { type: "text", x: el.x, y: el.y, text, fontSize: el.fontSize, fontFamily: el.fontFamily, textAlign: el.textAlign },
    ]);
    if (fresh === undefined || fresh.type !== "text") return el;
    return newElementWith(el, { text: fresh.text, originalText: fresh.originalText, width: fresh.width, height: fresh.height });
  }

  function addNode(op: Extract<BoardOp, { op: "add_shape" | "add_frame" | "add_mockup" | "add_image" }>) {
    const tx = begin();
    const existing = liveEntry(tx, op.id);
    if (existing !== undefined && existing.kind === "frame" && op.op === "add_frame") {
      // Re-declaring a frame renames it; replacing it would strand its children.
      const root = existing.root;
      patch(tx, root.id, (el) => (el.type === "frame" || el.type === "magicframe" ? newElementWith(el, { name: op.title }) : el));
      commit(tx);
      lastPlaced = op.id;
      return;
    }
    if (existing !== undefined) {
      // Re-adding an id replaces the node in place; edges re-attach below.
      remove(tx, new Set(existing.elements.map((el) => el.id)));
      if (existing.kind === "frame") releaseChildren(tx, existing.root.id);
    }
    const id = ids(op.id);
    let built: Built;
    let placement: Placement = op.placement;
    switch (op.op) {
      case "add_shape":
        built = buildShape({ nodeId: op.id, id, shape: op.shape, label: op.label, color: op.color });
        break;
      case "add_frame":
        built = buildFrame({ nodeId: op.id, id, title: op.title });
        break;
      case "add_mockup":
        built = buildMockup({ nodeId: op.id, id, title: op.title, device: op.device, components: op.components });
        break;
      case "add_image": {
        const mime = mimeOf(op.dataUrl);
        const fileId = `${op.id}-${Date.now().toString(36)}`;
        if (mime === null || !isDataURL(op.dataUrl) || !isFileId(fileId)) return;
        const natural = readImageSize(op.dataUrl) ?? { width: 1024, height: 1024 };
        const scale = 320 / Math.max(natural.width, natural.height);
        const file: BinaryFileData = { id: fileId, dataURL: op.dataUrl, mimeType: mime, created: Date.now() };
        api.addFiles([file]);
        built = buildImage({
          nodeId: op.id,
          id,
          fileId,
          caption: op.caption,
          width: Math.round(natural.width * scale),
          height: Math.round(natural.height * scale),
        });
        // Land where the "Generating image…" card was, if one is showing.
        const pending = pendingCards(tx);
        const slot = pending.find((p) => p.pendingId === op.id) ?? pending[0];
        if (slot !== undefined && op.placement.kind === "auto") {
          remove(tx, new Set(slot.elementIds));
          animator.stopPulse(slot.elementIds);
          const bounds = boundsOf(built.elements);
          if (bounds !== null) {
            built = {
              ...built,
              elements: built.elements.map((el) => ({
                ...el,
                x: el.x + slot.rect.x + (slot.rect.w - bounds.w) / 2 - bounds.x,
                y: el.y + slot.rect.y - bounds.y,
              })),
            };
          }
          tx.elements.push(...built.elements);
          finishAdd(tx, op.id, built.elements, existing !== undefined);
          return;
        }
        break;
      }
      default: {
        const _exhaustive: never = op;
        return _exhaustive;
      }
    }
    if (placement.kind === "near" && placement.target === op.id) placement = { kind: "auto" };
    const placed = place(tx, built, placement);
    finishAdd(tx, op.id, placed, existing !== undefined);
  }

  /** Children of a frame that is going away become loose items where they stand. */
  function releaseChildren(tx: Tx, frameElementId: string) {
    tx.elements = tx.elements.map((el) => (el.frameId === frameElementId && !el.isDeleted ? newElementWith(el, { frameId: null }) : el));
  }

  function finishAdd(tx: Tx, nodeId: NodeId, placed: readonly ExcalidrawElement[], replaced: boolean) {
    if (replaced) reroute(tx, new Set([nodeId]));
    markPlaced(nodeId);
    commit(tx);
    lastPlaced = nodeId;
    const isMockup = placed.some((el) => readMeta(el)?.kind === "mockup");
    announce(placed, isMockup ? "sequence" : "together");
  }

  type PendingCard = { pendingId: string; elementIds: string[]; rect: Rect };

  function pendingCards(tx: Tx): PendingCard[] {
    const cards = new Map<string, ExcalidrawElement[]>();
    for (const el of tx.elements) {
      if (el.isDeleted) continue;
      const meta = readMeta(el);
      if (meta === null || meta.kind !== "pending") continue;
      cards.set(meta.pendingId, [...(cards.get(meta.pendingId) ?? []), el]);
    }
    return [...cards.entries()].flatMap(([pendingId, els]) => {
      const rect = boundsOf(els);
      return rect === null ? [] : [{ pendingId, elementIds: els.map((el) => el.id), rect }];
    });
  }

  function update(op: Extract<BoardOp, { op: "update" }>) {
    const tx = begin();
    const entry = liveEntry(tx, op.id);
    if (entry === undefined) return;
    const meta = entry.meta;
    const byId = new Map(tx.elements.map((el) => [el.id, el]));

    if (meta !== null && meta.kind === "shape") {
      // Rebuild at the same spot, keeping the root id so edges stay bound.
      const label = op.label ?? labelOf(entry, byId);
      const color = op.color ?? meta.color;
      const fresh = ids(op.id);
      const built = buildShape({ nodeId: op.id, id: (part) => (part === "root" ? entry.root.id : fresh(part)), shape: meta.shape, label, color });
      const bounds = boundsOf(built.elements);
      if (bounds === null) return;
      const old = boundsOf(entry.elements) ?? bounds;
      const dx = old.x + old.w / 2 - (bounds.x + bounds.w / 2);
      const dy = old.y + old.h / 2 - (bounds.y + bounds.h / 2);
      remove(tx, new Set(entry.elements.filter((el) => el.id !== entry.root.id).map((el) => el.id)));
      for (const el of built.elements) {
        const moved = { ...el, x: el.x + dx, y: el.y + dy, frameId: entry.root.frameId, groupIds: entry.root.groupIds };
        if (el.id === entry.root.id) replace(tx, { ...moved, version: entry.root.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) });
        else insert(tx, [moved], null);
      }
      if (entry.root.frameId !== null) refitFrame(tx, entry.root.frameId);
      reroute(tx, new Set([op.id]));
      commit(tx);
      return;
    }

    if (op.color !== undefined) {
      const swatch = SWATCHES[op.color];
      if (entry.kind === "edge") patch(tx, entry.root.id, (el) => newElementWith(el, { strokeColor: swatch.stroke }));
      else if (entry.kind === "shape") patch(tx, entry.root.id, (el) => newElementWith(el, { strokeColor: swatch.stroke, backgroundColor: swatch.fill }));
    }

    if (op.label !== undefined && entry.kind === "edge" && meta !== null && meta.kind === "edge") {
      // Rebuild agent edges so the new label is wrapped, measured and routed like a fresh one.
      const stroke = op.color !== undefined ? SWATCHES[op.color].stroke : entry.root.strokeColor;
      remove(tx, new Set(entry.elements.map((el) => el.id)));
      for (const el of addEdge(tx, { op: "add_edge", id: op.id, from: meta.from, to: meta.to, label: op.label })) {
        if (el.type === "arrow") patch(tx, el.id, (current) => newElementWith(current, { strokeColor: stroke }));
      }
    } else if (op.label !== undefined) {
      const label = op.label;
      const root = entry.root;
      if (root.type === "frame" || root.type === "magicframe") {
        patch(tx, root.id, (el) => (el.type === "frame" || el.type === "magicframe" ? newElementWith(el, { name: label }) : el));
      } else if (root.type === "text") {
        patch(tx, root.id, (el) => retext(el, label));
      } else {
        const bound = (root.boundElements ?? []).find((b) => b.type === "text");
        const target = bound?.id ?? entry.elements.find((el) => el.type === "text" && el.containerId === null)?.id;
        if (target !== undefined) {
          patch(tx, target, (el) => (el.type === "text" && el.containerId !== null ? newElementWith(el, { text: label, originalText: label }) : retext(el, label)));
        }
      }
    }
    commit(tx);
  }

  function move(op: Extract<BoardOp, { op: "move" }>) {
    const tx = begin();
    const entry = liveEntry(tx, op.id);
    if (entry === undefined || entry.kind === "edge") return;
    if (op.placement.kind === "inside" && op.placement.frame === op.id) return;
    if (op.placement.kind === "near" && op.placement.target === op.id) return;
    const children = entry.kind === "frame" ? tx.elements.filter((el) => el.frameId === entry.root.id && !el.isDeleted) : [];
    const moving = [...entry.elements, ...children];
    const own = new Set(moving.map((el) => el.id));
    const rect = nodeRect(entry);
    if (rect === null) return;
    const { at, frame } = resolve(tx, op.placement, { w: rect.w, h: rect.h }, own);
    const dx = at.x - rect.x;
    const dy = at.y - rect.y;
    const nextFrameId = entry.kind === "frame" ? null : (frame?.element.id ?? null);
    for (const el of moving) {
      patch(tx, el.id, (current) => {
        const moved = translate(current, dx, dy);
        return entry.elements.includes(el) && entry.kind !== "frame" ? newElementWith(moved, { frameId: nextFrameId }) : moved;
      });
    }
    if (frame !== null) refitFrame(tx, frame.element.id);
    if (entry.root.frameId !== null && entry.root.frameId !== nextFrameId) refitFrame(tx, entry.root.frameId);
    const touched = new Set<NodeId>([op.id]);
    const nodes = indexNodes(tx.elements);
    for (const child of children) {
      const id = nodeIdForElement(nodes, child.id);
      if (id !== null) touched.add(id);
    }
    reroute(tx, touched);
    // A moved block counts as the newest, so it is the one that steps aside if it lands on something.
    markPlaced(op.id);
    commit(tx);
    lastPlaced = op.id;
    const placed = tx.elements.filter((el) => own.has(el.id));
    const bounds = boundsOf(placed);
    if (bounds !== null) animator.pointAt(restingPoint(bounds), []);
    for (const el of placed) pendingFollow.add(el.id);
    if (followTimer !== null) window.clearTimeout(followTimer);
    followTimer = window.setTimeout(follow, 140);
  }

  function apply(op: BoardOp) {
    switch (op.op) {
      case "add_shape":
      case "add_frame":
      case "add_mockup":
      case "add_image":
        addNode(op);
        return;
      case "add_edge": {
        const tx = begin();
        const existing = liveEntry(tx, op.id);
        if (existing !== undefined) remove(tx, new Set(existing.elements.map((el) => el.id)));
        const placed = addEdge(tx, op);
        if (placed.length === 0) return;
        commit(tx);
        announce(placed, "together");
        return;
      }
      case "update":
        update(op);
        return;
      case "move":
        move(op);
        return;
      case "delete": {
        const tx = begin();
        const doomed = deletionSet(tx, op.ids);
        if (doomed.size === 0) return;
        remove(tx, doomed);
        commit(tx);
        if (lastPlaced !== null && op.ids.includes(lastPlaced)) lastPlaced = null;
        return;
      }
      case "set_title":
        setTitle(op.title);
        return;
      case "clear": {
        const tx = begin();
        remove(tx, new Set(tx.elements.map((el) => el.id)));
        commit(tx);
        lastPlaced = null;
        return;
      }
      default: {
        const _exhaustive: never = op;
        return _exhaustive;
      }
    }
  }

  // ---- Summary ------------------------------------------------------------------------------

  function getSummary(): BoardSummary {
    const elements = dedupeNodeIds(api.getSceneElementsIncludingDeleted());
    const nodes = indexNodes(elements);
    const byId = new Map(elements.map((el) => [el.id, el]));
    const nodeOfElement = new Map<string, NodeId>();
    for (const entry of nodes.values()) for (const el of entry.elements) nodeOfElement.set(el.id, entry.id);

    const items: BoardItem[] = [];
    for (const entry of nodes.values()) {
      const label = labelOf(entry, byId).trim();
      const frame = entry.root.frameId === null ? null : (nodeOfElement.get(entry.root.frameId) ?? null);
      if (entry.kind === "edge") {
        const meta = entry.meta;
        const arrow = entry.root;
        const from = meta !== null && meta.kind === "edge" ? meta.from : arrow.type === "arrow" ? (nodeOfElement.get(arrow.startBinding?.elementId ?? "") ?? null) : null;
        const to = meta !== null && meta.kind === "edge" ? meta.to : arrow.type === "arrow" ? (nodeOfElement.get(arrow.endBinding?.elementId ?? "") ?? null) : null;
        if (from === null || to === null || !nodes.has(from) || !nodes.has(to)) continue;
        items.push({ id: entry.id, kind: "edge", label, frame, link: `${from} -> ${to}` });
        continue;
      }
      // User shapes only matter to the agent when they say something.
      if (entry.meta === null && entry.kind === "shape" && label.length === 0) continue;
      items.push({ id: entry.id, kind: entry.kind, label, frame, link: "" });
    }

    const selected = new Set<NodeId>();
    for (const elementId of Object.keys(api.getAppState().selectedElementIds)) {
      const id = nodeOfElement.get(elementId);
      if (id !== undefined) selected.add(id);
    }
    return { title, items: items.slice(0, 400), selection: [...selected] };
  }

  // ---- Pending ------------------------------------------------------------------------------

  function showPending(args: { id: string; label: string }) {
    const tx = begin();
    if (pendingCards(tx).some((p) => p.pendingId === args.id)) return;
    const built = buildPending({ pendingId: args.id, id: ids("pending"), label: args.label });
    markPlaced(`pending:${args.id}`);
    const placed = place(tx, built, { kind: "auto" });
    commit(tx, "silent");
    animator.fadeIn([placed], 0);
    animator.pulse(placed.map((el) => el.id));
    const rect = boundsOf(placed);
    if (rect !== null) animator.pointAt(restingPoint(rect), []);
    for (const el of placed) pendingFollow.add(el.id);
    if (followTimer !== null) window.clearTimeout(followTimer);
    followTimer = window.setTimeout(follow, 140);
  }

  function clearPending(id: string) {
    const tx = begin();
    const card = pendingCards(tx).find((p) => p.pendingId === id);
    if (card === undefined) return;
    animator.stopPulse(card.elementIds);
    remove(tx, new Set(card.elementIds));
    commit(tx, "silent");
  }

  // ---- Title --------------------------------------------------------------------------------

  function setTitle(next: string) {
    const clean = next.trim().slice(0, 80) || DEFAULT_TITLE;
    if (clean === title) return;
    title = clean;
    api.updateScene({ appState: { name: clean }, captureUpdate: CaptureUpdateAction.NEVER });
    for (const listener of titleListeners) listener(clean);
  }

  const guard =
    <A extends unknown[], R>(fn: (...args: A) => R, fallback: R) =>
    (...args: A): R => {
      try {
        return fn(...args);
      } catch (error) {
        options.onError?.(error);
        return fallback;
      }
    };

  return {
    apply: guard(apply, undefined),
    getSummary: guard(getSummary, { title: DEFAULT_TITLE, items: [], selection: [] }),
    showPending: guard(showPending, undefined),
    clearPending: guard(clearPending, undefined),
    getTitle: () => title,
    setTitle: guard(setTitle, undefined),
    subscribeTitle(listener) {
      titleListeners.add(listener);
      return () => titleListeners.delete(listener);
    },
    dispose() {
      animator.dispose();
      if (followTimer !== null) window.clearTimeout(followTimer);
      titleListeners.clear();
    },
  };
}
