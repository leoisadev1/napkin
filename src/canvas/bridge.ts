// BoardBridge over an Excalidraw scene. The scene is the source of truth: every agent element carries its
// NodeId in customData (see meta.ts), so user moves, edits, undo and redo never desync the agent's view.
import { CaptureUpdateAction, convertToExcalidrawElements, getVisibleSceneBounds, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { BoardItem, BoardOp, BoardSummary, Placement } from "../../shared/board";
import { NodeId } from "../../shared/board";
import type { BoardBridge } from "../conversation/types";
import type { Animator } from "./animator";
import { createAnimator } from "./animator";
import type { Built, IdFactory } from "./builders";
import { arrowGeometry, buildArrow, buildFrame, DORMANT_FRAME_NAME, buildImage, buildMockup, buildPending, buildShape, wrap } from "./builders";
import type { EdgeRoute, Outline, Point, Rect, Segment } from "./geometry";
import { boundsOf } from "./bounds";
import { boxAround, center, contains, edgePoint, inflate, labelPointOf, overlaps, routeEdge, routeOf, routePoints, segmentsOf, union } from "./geometry";
import { mimeOf, readImageSize } from "./imageSize";
import { dedupeNodeIds } from "./identity";
import type { Block } from "./layout";
import { besideSpot, fitFrame, isFree, nearestFree, overlappingPairs, placeAuto, placeInside, placeNear, settleBlocks } from "./layout";
import type { NodeKind, NodeMeta } from "./meta";
import { metaData, nodeIdOf, readMeta } from "./meta";
import { SWATCHES } from "./palette";

export const DEFAULT_TITLE = "Untitled board";

type Insets = { top: number; bottom: number; left: number; right: number };

/**
 * Screen-space insets covered by the app's floating chrome, so "in view" means actually visible. The bottom covers
 * the dock: the bar, the live line and a row of suggestion chips. Phones (the 730px breakpoint in ui.css) stack Excalidraw's toolbar and the title
 * row on top and keep a lock column on the right.
 */
export function chromeInsets(viewportWidth: number): Insets {
  return viewportWidth <= 730 ? { top: 116, bottom: 210, left: 16, right: 52 } : { top: 80, bottom: 160, left: 32, right: 32 };
}

const ROW_GAP = 96;
const EDGE_GAP = 8;
/** Frame names render above the frame's top edge; keep that strip clear too. */
const FRAME_TITLE_ROOM = 32;
/**
 * Camera follow: settle between `min` and `max`; go down to `floor` only when the new item needs it. `margin` is the
 * screen gap kept between a followed item and the edge of the usable area. Phones trade zoom for context.
 */
function followZoom(viewportWidth: number) {
  return viewportWidth <= 730 ? { min: 0.55, max: 1, floor: 0.4, margin: 20 } : { min: 0.7, max: 1, floor: 0.5, margin: 56 };
}
const GLIDE_MS = 620;

/** Excalidraw clamps zoom to this range; anything inside it is a valid NormalizedZoomValue. */
function isNormalizedZoom(value: number): value is NormalizedZoomValue {
  return Number.isFinite(value) && value >= 0.1 && value <= 30;
}

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

/** An agent frame with nothing in it yet: invisible, locked and nameless, its title parked in customData. */
function isDormantFrame(el: ExcalidrawElement): boolean {
  const meta = readMeta(el);
  return el.type === "frame" && meta !== null && meta.kind === "frame" && el.locked && el.name === DORMANT_FRAME_NAME;
}

function frameTitle(el: ExcalidrawElement): string {
  const meta = readMeta(el);
  const parked = meta !== null && meta.kind === "frame" ? (meta.title ?? "") : "";
  if (el.type !== "frame" && el.type !== "magicframe") return "";
  return el.name === null || el.name === "" || el.name === DORMANT_FRAME_NAME ? parked : el.name;
}

/** Renames a frame. A dormant frame keeps the name parked until it wakes. */
function renamedFrame(el: ExcalidrawElement, title: string): ExcalidrawElement {
  if (el.type !== "frame" && el.type !== "magicframe") return el;
  const meta = readMeta(el);
  const customData = meta !== null && meta.kind === "frame" ? metaData({ ...meta, title }) : el.customData;
  return newElementWith(el, isDormantFrame(el) ? { customData } : { name: title, customData });
}

function labelOf(entry: NodeEntry, byId: ReadonlyMap<string, ExcalidrawElement>): string {
  const textOf = (el: ExcalidrawElement | undefined): string => (el !== undefined && el.type === "text" ? el.originalText || el.text : "");
  const root = entry.root;
  if (root.type === "frame" || root.type === "magicframe") return frameTitle(root);
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
  /** Elements the camera should show after the next follow: the new item, and nearby context when it fits. */
  const pendingFollow = { core: new Set<string>(), context: new Set<string>() };
  /** Dormant frames that got their first child in the current transaction; they fade in after commit. */
  const woken = new Set<string>();

  const ids = (nodeId: string): IdFactory => {
    const stamp = `${Date.now().toString(36)}${(seq++).toString(36)}`;
    return (part) => `${nodeId}~${stamp}~${part}`;
  };

  // ---- Scene transaction ------------------------------------------------------------------------

  /** `overlapsBefore` holds block pairs that already overlapped, so settling only fixes clashes this change made. */
  type Tx = { elements: ExcalidrawElement[]; overlapsBefore: Set<string> };

  function begin(): Tx {
    // Anything still gliding jumps to where it is headed, so the transaction reads final positions.
    animator.finishMotion();
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
    const before = api.getSceneElementsIncludingDeleted();
    api.updateScene({
      elements: tx.elements,
      captureUpdate: capture === "undoable" ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER,
    });
    // Things this change pushed aside, frames that grew and re-aimed arrows glide to their new spot.
    animator.glideFrom(before);
    if (woken.size > 0) {
      const frames = api.getSceneElements().filter((el) => woken.has(el.id));
      woken.clear();
      animator.fadeIn([frames], 0);
    }
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

  /** Puts freshly built elements at a fixed top-left, inside `frameId` when given. Used to replace a node in place. */
  function placeAt(tx: Tx, built: Built, keep: { at: Point; frameId: string | null }): ExcalidrawElement[] {
    const bounds = boundsOf(built.elements) ?? { x: 0, y: 0, w: 0, h: 0 };
    const frameId = keep.frameId !== null && tx.elements.some((el) => el.id === keep.frameId && !el.isDeleted) ? keep.frameId : null;
    const placed = built.elements.map((el) => ({ ...el, x: el.x + keep.at.x - bounds.x, y: el.y + keep.at.y - bounds.y, frameId }));
    insert(tx, placed, frameId);
    if (frameId !== null) refitFrame(tx, frameId);
    return placed;
  }

  /**
   * After a node inside a frame changed size in place, its siblings step aside (right or down) instead of the node
   * itself moving, and the frame re-wraps everything.
   */
  function settleInside(tx: Tx, frameElementId: string, fixed: NodeId) {
    const nodes = indexNodes(tx.elements);
    const order = new Map(tx.elements.map((el, i) => [el.id, i]));
    const members = [...nodes.values()].filter((n) => n.kind !== "edge" && n.root.frameId === frameElementId);
    const blocks = members.flatMap((n) => {
      const rect = nodeRect(n);
      return rect === null ? [] : [{ key: n.id, rect, movable: n.id !== fixed && n.meta !== null, order: order.get(n.root.id) ?? 0 }];
    });
    const moves = settleBlocks({ blocks, ignore: new Set(), gap: 56 });
    if (moves.size === 0) return;
    const touched = new Set<NodeId>();
    for (const n of members) {
      const delta = moves.get(n.id);
      if (delta === undefined) continue;
      for (const el of n.elements) patch(tx, el.id, (current) => translate(current, delta.x, delta.y));
      touched.add(n.id);
    }
    refitFrame(tx, frameElementId);
    reroute(tx, touched);
  }

  /** Re-wraps a frame around its children after something was placed, moved or removed inside it. */
  function refitFrame(tx: Tx, frameElementId: string) {
    const frame = tx.elements.find((el) => el.id === frameElementId && !el.isDeleted);
    const rect = frame === undefined ? null : boundsOf([frame]);
    if (frame === undefined || rect === null) return;
    const children = frameChildren(tx, frameElementId, new Set());
    if (children.length > 0 && isDormantFrame(frame)) {
      patch(tx, frameElementId, (el) => (el.type === "frame" ? newElementWith(el, { name: frameTitle(el), opacity: 100, locked: false }) : el));
      woken.add(frameElementId);
    }
    const next = fitFrame(rect, children);
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
      const mid = labelPointOf(arrowPoints(arrow));
      if (label === undefined || mid === null) continue;
      const box = boxAround(mid, { w: label.width, h: label.height });
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

  type Route = EdgeRoute;

  function arrowPoints(arrow: ExcalidrawElement): Point[] {
    return arrow.type === "arrow" ? arrow.points.map((p) => ({ x: arrow.x + p[0], y: arrow.y + p[1] })) : [];
  }

  /** Labels and lines of every edge except `self`, plus frame borders, for routing `self` around them. */
  function surroundings(nodes: ReadonlyMap<NodeId, NodeEntry>, self: NodeId): { labels: Rect[]; lines: Segment[] } {
    const labels: Rect[] = [];
    const lines: Segment[] = [];
    for (const entry of nodes.values()) {
      if (entry.kind === "frame") {
        const r = boundsOf([entry.root]);
        if (r !== null) {
          const corners = [
            { x: r.x, y: r.y },
            { x: r.x + r.w, y: r.y },
            { x: r.x + r.w, y: r.y + r.h },
            { x: r.x, y: r.y + r.h },
          ];
          lines.push(...segmentsOf([...corners, { x: r.x, y: r.y }]));
        }
        continue;
      }
      if (entry.kind !== "edge" || entry.id === self) continue;
      const points = arrowPoints(entry.root);
      lines.push(...segmentsOf(points));
      const text = entry.elements.find((el) => el.type === "text");
      const at = labelPointOf(points);
      if (text !== undefined && at !== null) labels.push(inflate(boxAround(at, { w: text.width, h: text.height }), 4));
    }
    return { labels, lines };
  }

  /** Edge-to-edge line between two nodes, routed around other nodes and around other edges' labels and lines. */
  function edgeRoute(args: { nodes: ReadonlyMap<NodeId, NodeEntry>; self: NodeId; from: NodeEntry; to: NodeEntry; label: Size; drawn: Route | null }): Route | null {
    const { nodes, self, from, to, label } = args;
    const a = nodeRect(from.kind === "mockup" || from.kind === "image" ? { ...from, elements: [from.root] } : from);
    const b = nodeRect(to.kind === "mockup" || to.kind === "image" ? { ...to, elements: [to.root] } : to);
    if (a === null || b === null) return null;
    const ends = (bend: Point | null) => ({
      start: edgePoint({ rect: a, outline: outlineOf(from.root), toward: bend ?? center(b), gap: EDGE_GAP }),
      end: edgePoint({ rect: b, outline: outlineOf(to.root), toward: bend ?? center(a), gap: EDGE_GAP }),
    });
    const solids: Rect[] = [];
    for (const entry of nodes.values()) {
      if (entry.kind === "edge" || entry.kind === "frame" || entry.id === from.id || entry.id === to.id) continue;
      const rect = nodeRect(entry);
      if (rect !== null) solids.push(inflate(rect, 12));
    }
    // Mockup and image titles sit outside the root; the label stays off them too.
    const endRects = [from, to].flatMap((n) => {
      const r = nodeRect(n);
      return r === null ? [] : [r];
    });
    const { labels, lines } = surroundings(nodes, self);
    const route = routeEdge({ ends, around: { solids, ends: endRects, labels, lines }, label, current: args.drawn });
    // A second edge between the same pair (often the reply direction) bows out so the two don't overlap.
    const twin = [...nodes.values()].some((n) => {
      const m = n.meta;
      return n.id !== self && m !== null && m.kind === "edge" && ((m.from === from.id && m.to === to.id) || (m.from === to.id && m.to === from.id));
    });
    if (route.bend === null && twin && args.drawn === null) {
      const bend = bow(ends(null), label);
      return { ...ends(bend), bend, label: bend };
    }
    return route;
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
    const [first, ...rest] = routePoints(route);
    const end = rest.at(-1) ?? route.end;
    const start = first ?? route.start;
    const via = rest.slice(0, -1).map((p) => ({ x: p.x - start.x, y: p.y - start.y }));
    return arrowGeometry({ x: start.x, y: start.y, dx: end.x - start.x, dy: end.y - start.y, via });
  }

  function addEdge(tx: Tx, op: Extract<BoardOp, { op: "add_edge" }>): ExcalidrawElement[] {
    const nodes = indexNodes(tx.elements);
    const from = nodes.get(op.from);
    const to = nodes.get(op.to);
    if (from === undefined || to === undefined || op.from === op.to) return [];
    const ends = edgeRoute({ nodes, self: op.id, from, to, label: labelSize(op.label), drawn: null });
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
      const ends = edgeRoute({
        nodes,
        self: entry.id,
        from,
        to,
        label: text === undefined ? { w: 0, h: 0 } : { w: text.width, h: text.height },
        drawn: routeOf(arrowPoints(arrow)),
      });
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

  /** Elements of the nodes an edge connects, so following an edge shows both ends when they fit. */
  function edgeContext(from: NodeId, to: NodeId): string[] {
    const nodes = indexNodes(api.getSceneElements());
    return [from, to].flatMap((id) => nodes.get(id)?.elements.map((el) => el.id) ?? []);
  }

  function scheduleFollow(core: readonly ExcalidrawElement[], context: readonly string[] = []) {
    for (const el of core) pendingFollow.core.add(el.id);
    for (const id of context) pendingFollow.context.add(id);
    if (followTimer !== null) window.clearTimeout(followTimer);
    followTimer = window.setTimeout(follow, 140);
  }

  function announce(placed: readonly ExcalidrawElement[], stagger: "together" | "sequence", context: readonly string[] = []) {
    if (placed.length === 0) return;
    const groups = stagger === "sequence" ? placed.map((el) => [el]) : [placed];
    animator.fadeIn(groups, stagger === "sequence" ? Math.max(8, Math.min(45, 900 / placed.length)) : 0);
    const roots = placed.filter((el) => readMeta(el)?.role === "root");
    const isEdge = roots.some((el) => el.type === "arrow");
    // An edge's own label is where the eye goes; its bounding box would outline half the board, so edges get no outline.
    // The label's stored x/y are stale (Excalidraw places arrow labels at draw time), so aim at the label spot itself.
    const placedArrow = roots.find((el) => el.type === "arrow");
    const arrow = placedArrow === undefined ? undefined : (api.getSceneElements().find((el) => el.id === placedArrow.id) ?? placedArrow);
    const spot = arrow === undefined ? null : labelPointOf(arrowPoints(arrow));
    const rect = spot !== null ? { x: spot.x - 30, y: spot.y - 12, w: 60, h: 24 } : boundsOf(placed);
    // Outline only each node's root element: one tight outline per item, not one per mockup part.
    if (rect !== null) animator.pointAt(restingPoint(rect), isEdge ? [] : roots.map((el) => el.id));
    scheduleFollow(placed, context);
  }

  type Camera = { cx: number; cy: number; z: number };
  let cameraFrame: number | null = null;
  let cameraTarget: Camera | null = null;

  /**
   * Keeps the newest item fully inside the safe area (between the toolbar and the dock) the way a person would: pan
   * the shortest distance at a readable zoom. Context (an edge's two ends, the frame around a new item with its
   * title) comes along when it fits at a comfortable zoom. The zoom only drops toward the floor when the item itself
   * needs it, such as a phone mockup taller than the screen.
   */
  function follow() {
    followTimer = null;
    // Frames may still be growing; judge against where everything is headed.
    const scene = animator.finalGeometry(api.getSceneElements());
    const core = scene.filter((el) => pendingFollow.core.has(el.id));
    const context = scene.filter((el) => pendingFollow.context.has(el.id));
    pendingFollow.core.clear();
    pendingFollow.context.clear();
    const itemRect = boundsOf(core);
    if (itemRect === null) return;
    const state = api.getAppState();
    const limits = followZoom(state.width);
    const insets = chromeInsets(state.width);
    const screenW = state.width - insets.left - insets.right;
    const screenH = state.height - insets.top - insets.bottom;
    // Mid-glide, judge against where the camera is heading, or a later item would undo the move still in flight.
    const actual: Camera = { cx: -state.scrollX + state.width / 2 / state.zoom.value, cy: -state.scrollY + state.height / 2 / state.zoom.value, z: state.zoom.value };
    const base = cameraFrame !== null && cameraTarget !== null ? cameraTarget : actual;
    const viewAt = (z: number, cx: number, cy: number): Rect => {
      // The usable area is offset by the chrome insets; its center is not the window's center.
      const x = cx - state.width / 2 / z + insets.left / z;
      const y = cy - state.height / 2 / z + insets.top / z;
      return { x, y, w: screenW / z, h: screenH / z };
    };
    const fitsAt = (r: Rect) => Math.min((screenW - limits.margin * 2) / Math.max(r.w, 1), (screenH - limits.margin * 2) / Math.max(r.h, 1));

    // Frames around the new item, with the title strip above them.
    const frameIds = new Set([...core, ...context].flatMap((el) => (el.frameId === null ? [] : [el.frameId])));
    const frames = scene.flatMap((el) => {
      const r = frameIds.has(el.id) ? boundsOf([el]) : null;
      return r === null ? [] : [withTitle(r)];
    });
    const contextRect = boundsOf(context);
    const options = [
      union([itemRect, ...(contextRect === null ? [] : [contextRect]), ...frames]),
      contextRect === null ? null : union([itemRect, contextRect]),
      union([itemRect, ...frames]),
    ];
    const rect = options.find((r): r is Rect => r !== null && fitsAt(r) >= limits.min) ?? itemRect;

    const zoom = base.z;
    const margin = limits.margin / zoom;
    const now = viewAt(zoom, base.cx, base.cy);
    if (contains({ x: now.x + margin, y: now.y + margin, w: now.w - margin * 2, h: now.h - margin * 2 }, rect)) return;

    let z = Math.min(limits.max, Math.max(limits.min, zoom));
    if (fitsAt(rect) < z) z = Math.max(limits.floor, fitsAt(rect));
    const view = viewAt(z, base.cx, base.cy);
    const m = limits.margin / z;
    // Too big even at the floor: show its top (where a mockup's title and header are), never a slice of the middle.
    const shift = (start: number, size: number, lo: number, len: number) => {
      if (len + 2 * m > size || lo - m < start) return lo - m - start;
      if (lo + len + m > start + size) return lo + len + m - (start + size);
      return 0;
    };
    const dx = shift(view.x, view.w, rect.x, rect.w);
    const dy = shift(view.y, view.h, rect.y, rect.h);
    glide({ from: actual, to: { cx: base.cx + dx, cy: base.cy + dy, z } });
  }

  /** Tweens the camera center and zoom together so the motion reads as one move, not a pan plus a zoom. */
  function glide({ from, to }: { from: Camera; to: Camera }) {
    if (cameraFrame !== null) cancelAnimationFrame(cameraFrame);
    cameraTarget = to;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    const step = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - start) / GLIDE_MS);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const z = from.z + (to.z - from.z) * k;
      const cx = from.cx + (to.cx - from.cx) * k;
      const cy = from.cy + (to.cy - from.cy) * k;
      const state = api.getAppState();
      if (!isNormalizedZoom(z)) {
        cameraFrame = null;
        return;
      }
      api.updateScene({
        appState: { zoom: { value: z }, scrollX: state.width / 2 / z - cx, scrollY: state.height / 2 / z - cy },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      cameraFrame = t < 1 ? requestAnimationFrame(step) : null;
    };
    cameraFrame = requestAnimationFrame(step);
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
      patch(tx, root.id, (el) => renamedFrame(el, op.title));
      commit(tx);
      lastPlaced = op.id;
      return;
    }
    // Re-adding an id replaces the node in place: same top-left, same frame, edges re-attach in finishAdd.
    const spot = existing === undefined || existing.kind === "frame" ? null : nodeRect(existing);
    const keep = spot === null || existing === undefined ? null : { at: { x: spot.x, y: spot.y }, frameId: existing.root.frameId };
    if (existing !== undefined) {
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
        if (slot !== undefined && op.placement.kind === "auto" && keep === null) {
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
    const placed = keep === null ? place(tx, built, placement) : placeAt(tx, built, keep);
    if (keep !== null && keep.frameId !== null) settleInside(tx, keep.frameId, op.id);
    finishAdd(tx, op.id, placed, existing !== undefined);
  }

  /** Children of a frame that is going away become loose items where they stand. */
  function releaseChildren(tx: Tx, frameElementId: string) {
    tx.elements = tx.elements.map((el) => (el.frameId === frameElementId && !el.isDeleted ? newElementWith(el, { frameId: null }) : el));
  }

  function finishAdd(tx: Tx, nodeId: NodeId, placed: readonly ExcalidrawElement[], replaced: boolean) {
    if (replaced) reroute(tx, new Set([nodeId]));
    // A replaced node keeps its place in line, so its neighbours make room rather than it wandering off.
    if (!replaced) markPlaced(nodeId);
    else if (!placedOrder.has(nodeId)) placedOrder.set(nodeId, -2e6);
    commit(tx);
    lastPlaced = nodeId;
    // A dormant frame has nothing to show yet; its first child announces it.
    if (placed.every(isDormantFrame)) return;
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
        patch(tx, root.id, (el) => renamedFrame(el, label));
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
    scheduleFollow(placed);
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
        announce(placed, "together", edgeContext(op.from, op.to));
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
    scheduleFollow(placed);
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
      if (cameraFrame !== null) cancelAnimationFrame(cameraFrame);
      animator.dispose();
      if (followTimer !== null) window.clearTimeout(followTimer);
      titleListeners.clear();
    },
  };
}
