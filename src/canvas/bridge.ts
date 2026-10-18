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
import type { DiagramIds, EntryStep } from "./diagramBuild";
import { buildDiagram, excalidrawMeasure } from "./diagramBuild";
import type { DiagramSpec } from "./diagramLayout";
import { layoutDiagram } from "./diagramLayout";
import type { EdgeRoute, Outline, Point, Rect, Segment } from "./geometry";
import { boundsOf } from "./bounds";
import { boxAround, center, contains, edgePoint, inflate, labelPointOf, overlaps, routeEdge, routeOf, routePoints, segmentsOf, union } from "./geometry";
import { mimeOf, readImageSize } from "./imageSize";
import { dedupeNodeIds } from "./identity";
import type { Block } from "./layout";
import { alignedSpot, besideSpot, fitFrame, isAligned, isFree, nearestFree, overlappingPairs, pairKey, placeAtPoint, placeAuto, placeInView, placeInside, placeNear, placeOver, settleBlocks, snapAlign } from "./layout";
import type { NodeKind, NodeMeta } from "./meta";
import { metaData, nodeIdOf, readMeta } from "./meta";
import type { PacedTask } from "./pacer";
import { createPacer } from "./pacer";
import { BOARD_FONT, SWATCHES } from "./palette";
import type { SketchPart } from "./sketches";
import { groupSketches, sketchIdOf, withSketchId } from "./sketches";
import { reAddPlan } from "./membership";

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

/** What the partner is up to, shown on its cursor: nothing, about to draw something it just heard, or tidying up. */
export type PartnerActivity = { kind: "idle" } | { kind: "thinking"; key: string } | { kind: "tidying" };

/** The user's mouse in screen coordinates, or null when it left the window or the input is touch. */
export type PointerSample = { clientX: number; clientY: number } | null;

export interface CanvasBridge extends BoardBridge {
  /** Where the user's mouse is, so "here" and "this" resolve and new things land where they are looking. */
  trackPointer(sample: PointerSample): void;
  setPartner(activity: PartnerActivity): void;
  getTitle(): string;
  setTitle(title: string): void;
  /** Fires when the title changes, from either the agent or the user. */
  subscribeTitle(listener: (title: string) => void): () => void;
  dispose(): void;
}

type NodeEntry = {
  id: NodeId;
  /** "sketch" groups loose user strokes (see sketches.ts); it has no agent meta. */
  kind: NodeKind | "sketch";
  root: ExcalidrawElement;
  /** Every element that belongs to the node. Frames list only themselves, not their children. */
  elements: ExcalidrawElement[];
  /** What the node covers on the board: its elements, plus every node element for a diagram. */
  extent: ExcalidrawElement[];
  meta: NodeMeta | null;
  /** For a diagram node: the live diagram it belongs to. Null for everything else, and for orphaned copies. */
  diagram: NodeId | null;
};

function nodeKindOf(meta: NodeMeta): NodeKind | null {
  return meta.kind === "pending" || meta.kind === "ghost" ? null : meta.kind;
}

function isGhost(el: ExcalidrawElement): boolean {
  return readMeta(el)?.kind === "ghost";
}

/** Whitespace-insensitive text, for telling a user's edit apart from our own wrapping. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

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
  const sketches = new Map<NodeId, ExcalidrawElement[]>();

  for (const el of live) {
    const meta = readMeta(el);
    const nodeId = nodeIdOf(meta);
    const metaKind = meta === null ? null : nodeKindOf(meta);
    if (meta !== null && metaKind !== null && nodeId !== null) {
      if (meta.role === "root") roots.push({ id: nodeId, kind: metaKind, root: el, elements: [], extent: [], meta, diagram: null });
      const list = parts.get(nodeId) ?? [];
      list.push(el);
      parts.set(nodeId, list);
      continue;
    }
    if (meta !== null) continue;
    // User-drawn element. Bound text belongs to its container.
    if (containerIdOf(el) !== null && byId.has(containerIdOf(el) ?? "")) continue;
    const sketch = sketchIdOf(el);
    if (sketch !== null) {
      sketches.set(sketch, [...(sketches.get(sketch) ?? []), el]);
      continue;
    }
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
    roots.push({ id, kind, root: el, elements: [el, ...bound], extent: [], meta: null, diagram: null });
  }

  for (const [id, members] of sketches) {
    const area = (el: ExcalidrawElement) => el.width * el.height;
    const boxes = members.filter((el) => el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond");
    // The root is what arrows bind to and what gives the outline: the biggest box, else the biggest stroke.
    const root = [...(boxes.length > 0 ? boxes : members)].sort((a, b) => area(b) - area(a))[0];
    if (root === undefined) continue;
    const labels = members.flatMap((el) =>
      (el.boundElements ?? []).flatMap((b) => {
        const child = b.type === "text" ? byId.get(b.id) : undefined;
        return child === undefined ? [] : [child];
      }),
    );
    roots.push({ id, kind: "sketch", root, elements: [...members, ...labels], extent: [], meta: null, diagram: null });
  }

  for (const entry of roots) {
    if (entry.meta !== null) entry.elements = parts.get(entry.id) ?? [entry.root];
    entry.extent = entry.elements;
    nodes.set(entry.id, entry);
  }
  // Diagram nodes belong to their diagram while they share its group; an Excalidraw duplicate gets a fresh group, so a
  // copied node stands alone instead of being swept into the original's next re-layout.
  for (const entry of nodes.values()) {
    const meta = entry.meta;
    if (meta === null || meta.kind !== "member") continue;
    const owner = nodes.get(meta.diagram);
    if (owner === undefined || owner.kind !== "diagram" || !owner.root.groupIds.some((g) => entry.root.groupIds.includes(g))) continue;
    entry.diagram = owner.id;
    owner.extent = [...owner.extent, ...entry.elements];
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
  const meta = entry.meta;
  if (meta !== null && meta.kind === "member") {
    // The full label, unless the user rewrote what the node shows.
    const bound = (root.boundElements ?? []).find((b) => b.type === "text");
    const shown = bound !== undefined ? textOf(byId.get(bound.id)) : textOf(entry.elements.find((el) => el.type === "text" && el.id !== root.id));
    return normalizeText(shown) === normalizeText(meta.shown) ? meta.label : shown;
  }
  if (meta !== null && meta.kind === "diagram" && meta.spec !== undefined) {
    const shown = textOf(root);
    return normalizeText(shown) === normalizeText(meta.spec.title) ? meta.spec.title : shown;
  }
  if (entry.kind === "sketch") {
    // Words written on or under the sketch, top to bottom.
    const texts = entry.elements.filter((el) => el.type === "text").sort((a, b) => a.y - b.y || a.x - b.x);
    return texts.map((el) => normalizeText(textOf(el))).filter((t) => t.length > 0).join(" ");
  }
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
  /** When the agent last placed or moved something, to tell whether the user's mouse moved on since. */
  let lastPlacedAt = 0;
  let pointer: { clientX: number; clientY: number; at: number } | null = null;
  /** Where recently deleted nodes were, so `at` can still take the spot of something a refine just removed. */
  const gone = new Map<NodeId, { rect: Rect; frameId: string | null; at: number }>();

  function noteActivity(id: NodeId) {
    lastPlaced = id;
    lastPlacedAt = performance.now();
  }
  let followTimer: number | null = null;
  /** Elements the camera should show after the next follow: the new item, and nearby context when it fits. */
  const pendingFollow = { core: new Set<string>(), context: new Set<string>(), wide: false };
  /** When each element the camera followed was placed, so later moves keep the rest of the thought in view. */
  const followedAt = new Map<string, number>();
  /** Dormant frames that got their first child in the current transaction; they fade in after commit. */
  const woken = new Set<string>();
  /** True while paced ops are still waiting; set once the pacer exists. */
  let pacing = () => false;

  const ids = (nodeId: string): IdFactory => {
    const stamp = `${Date.now().toString(36)}${(seq++).toString(36)}`;
    return (part) => `${nodeId}~${stamp}~${part}`;
  };

  // ---- Scene transaction ------------------------------------------------------------------------

  /** `overlapsBefore` holds block pairs that already overlapped, so settling only fixes clashes this change made. */
  type Tx = { elements: ExcalidrawElement[]; overlapsBefore: Set<string> };

  /** Which user elements could belong to a sketch, as plain parts for groupSketches. */
  function sketchPartsOf(elements: readonly ExcalidrawElement[]): SketchPart[] {
    const state = api.getAppState();
    // The stroke being drawn right now is not finished; it joins once the pen lifts.
    const drawing = new Set([state.newElement?.id, state.multiElement?.id].filter((id): id is string => id !== undefined));
    const parts: SketchPart[] = [];
    for (const el of elements) {
      if (el.isDeleted || drawing.has(el.id) || readMeta(el) !== null) continue;
      const hasLabel = (el.boundElements ?? []).some((b) => b.type === "text");
      let kind: SketchPart["kind"] | null = null;
      if (el.type === "text") kind = el.containerId === null ? "text" : null;
      else if (el.type === "freedraw" || el.type === "line") kind = "stroke";
      // A loose arrow is part of a drawing; one joining two things is a connection.
      else if (el.type === "arrow") kind = el.startBinding !== null && el.endBinding !== null ? null : "stroke";
      else if (el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond") kind = hasLabel ? null : "stroke";
      if (kind === null) continue;
      const rect = boundsOf([el]);
      if (rect !== null) parts.push({ id: el.id, kind, rect, updated: el.updated, sketch: sketchIdOf(el) });
    }
    return parts;
  }

  /**
   * Groups loose user strokes into sketches and stamps each element with its sketch id, so the agent can address
   * "the thing I drew" by a stable id. Returns the elements with any changed stamps.
   */
  function syncSketches(elements: readonly ExcalidrawElement[]): { elements: ExcalidrawElement[]; changed: boolean } {
    const parts = sketchPartsOf(elements);
    const taken = new Set<string>();
    for (const el of elements) {
      const id = nodeIdOf(readMeta(el)) ?? sketchIdOf(el);
      if (id !== null && !el.isDeleted) taken.add(id);
    }
    let n = 1;
    const makeId = (): NodeId => {
      for (;;) {
        const parsed = NodeId.safeParse(`sketch-${n++}`);
        if (parsed.success && !taken.has(parsed.data)) {
          taken.add(parsed.data);
          return parsed.data;
        }
      }
    };
    const groups = groupSketches({ parts, makeId });
    // Anything that carried a sketch id but no longer qualifies (a box that got a label, say) loses it.
    const want = new Map<string, NodeId | null>(elements.filter((el) => !el.isDeleted && sketchIdOf(el) !== null).map((el) => [el.id, null]));
    for (const p of parts) want.set(p.id, null);
    for (const group of groups) for (const id of group.members) want.set(id, group.id);
    let changed = false;
    const next = elements.map((el) => {
      const target = want.get(el.id);
      if (target === undefined || target === sketchIdOf(el)) return el;
      changed = true;
      return newElementWith(el, { customData: withSketchId(el.customData, target) });
    });
    return { elements: next, changed };
  }

  function begin(): Tx {
    // Anything still gliding jumps to where it is headed, so the transaction reads final positions.
    animator.finishMotion();
    const elements = syncSketches(dedupeNodeIds(api.getSceneElementsIncludingDeleted())).elements;
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

  type CommitOptions = {
    /** Fade out what this change deleted instead of letting it blink away. */
    ghosts?: boolean;
    /** Copies of elements deleted a moment ago that come back under the same id; they glide from there. */
    revived?: readonly ExcalidrawElement[];
    glideMs?: number;
  };

  function commit(tx: Tx, capture: "undoable" | "silent" = "undoable", options: CommitOptions = {}) {
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
    animator.glideFrom(before, options.revived ?? [], options.glideMs);
    if (options.ghosts === true) {
      const gone = new Set(tx.elements.filter((el) => el.isDeleted).map((el) => el.id));
      animator.fadeOutCopies(before.filter((el) => !el.isDeleted && gone.has(el.id) && !isGhost(el) && readMeta(el)?.kind !== "pending"));
    }
    if (woken.size > 0) {
      const frames = api.getSceneElements().filter((el) => woken.has(el.id));
      woken.clear();
      animator.fadeIn([frames], 0);
    }
  }

  // ---- Geometry helpers -------------------------------------------------------------------------

  function nodeRect(entry: NodeEntry): Rect | null {
    return boundsOf(entry.kind === "frame" ? [entry.root] : entry.extent);
  }

  function obstacles(tx: Tx, exclude: ReadonlySet<string>): Rect[] {
    const rects: Rect[] = [];
    for (const el of tx.elements) {
      if (el.isDeleted || exclude.has(el.id) || el.frameId !== null || el.type === "arrow" || isGhost(el)) continue;
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

  const POINTER_STALE_MS = 20_000;
  const GONE_MS = 20_000;

  /** The user's mouse in scene coordinates, or null when off-canvas, on touch, or still for too long. */
  function scenePointer(): (Point & { at: number }) | null {
    if (pointer === null || performance.now() - pointer.at > POINTER_STALE_MS) return null;
    const state = api.getAppState();
    const z = state.zoom.value;
    return { x: (pointer.clientX - state.offsetLeft) / z - state.scrollX, y: (pointer.clientY - state.offsetTop) / z - state.scrollY, at: pointer.at };
  }

  /** The scene area the user can actually see between the app's chrome; where the camera is headed when it glides. */
  function viewRect(): Rect {
    const state = api.getAppState();
    const insets = chromeInsets(state.width);
    const gliding = cameraFrame !== null && cameraTarget !== null ? cameraTarget : null;
    const z = gliding?.z ?? state.zoom.value;
    const cx = gliding?.cx ?? -state.scrollX + state.width / 2 / z;
    const cy = gliding?.cy ?? -state.scrollY + state.height / 2 / z;
    return {
      x: cx - state.width / 2 / z + insets.left / z,
      y: cy - state.height / 2 / z + insets.top / z,
      w: (state.width - insets.left - insets.right) / z,
      h: (state.height - insets.top - insets.bottom) / z,
    };
  }

  function selectionRect(nodes: ReadonlyMap<NodeId, NodeEntry>, exclude: ReadonlySet<string>): Rect | null {
    const selected = api.getAppState().selectedElementIds;
    const rects: Rect[] = [];
    for (const entry of nodes.values()) {
      if (entry.kind === "edge" || !entry.elements.some((el) => selected[el.id] === true && !exclude.has(el.id))) continue;
      const r = nodeRect(entry);
      if (r !== null) rects.push(r);
    }
    return union(rects);
  }

  /** The item the conversation is on: the last thing placed, standing in for its frame when it sits in one. */
  function anchorRect(tx: Tx, nodes: ReadonlyMap<NodeId, NodeEntry>, exclude: ReadonlySet<string>): Rect | null {
    const entry = lastPlaced === null ? undefined : nodes.get(lastPlaced);
    if (entry === undefined || entry.elements.some((el) => exclude.has(el.id))) return null;
    const frame = entry.root.frameId === null ? undefined : tx.elements.find((el) => el.id === entry.root.frameId && !el.isDeleted);
    return frame !== undefined ? boundsOf([frame]) : nodeRect(entry);
  }

  /** A thread of thought: items placed this close together in time go beside each other. */
  const THREAD_MS = 30_000;

  /**
   * Where the user's attention is, most specific first: the mouse if it moved since the partner last drew; the item
   * the conversation is on, if placed a moment ago and still in view; the selection; that item even if older; then
   * the mouse resting where it was. (Excalidraw leaves the user's last drawing selected, so a selection alone is a
   * weaker signal than an ongoing thread.)
   */
  function attention(tx: Tx, nodes: ReadonlyMap<NodeId, NodeEntry>, exclude: ReadonlySet<string>): { focus: Point | null; anchor: Rect | null } {
    const view = viewRect();
    const mouse = scenePointer();
    if (mouse !== null && mouse.at > lastPlacedAt) return { focus: mouse, anchor: null };
    const anchor = anchorRect(tx, nodes, exclude);
    const anchorInView = anchor !== null && overlaps(anchor, view) ? anchor : null;
    if (anchorInView !== null && performance.now() - lastPlacedAt < THREAD_MS) return { focus: mouse ?? center(anchorInView), anchor: anchorInView };
    const selected = selectionRect(nodes, exclude);
    if (selected !== null) return { focus: center(selected), anchor: selected };
    if (anchorInView !== null) return { focus: mouse ?? center(anchorInView), anchor: anchorInView };
    return { focus: mouse, anchor: null };
  }

  function recentlyGone(id: NodeId): { rect: Rect; frameId: string | null } | null {
    const g = gone.get(id);
    if (g === undefined) return null;
    if (performance.now() - g.at > GONE_MS) {
      gone.delete(id);
      return null;
    }
    return g;
  }

  /** A live frame (not a dormant one) by element id. */
  function liveFrame(tx: Tx, frameId: string | null): ExcalidrawElement | undefined {
    if (frameId === null) return undefined;
    return tx.elements.find((el) => el.id === frameId && !el.isDeleted && (el.type === "frame" || el.type === "magicframe"));
  }

  /** The top-level block a node belongs to (its frame, its diagram, or itself). */
  function blockKeyOf(tx: Tx, id: NodeId): string | null {
    return blocksOf(tx.elements).find((b) => b.nodeIds.includes(id))?.block.key ?? null;
  }

  /** A node placed `at` another one is meant to sit on it; settling must not push it off. */
  function allowOverlap(tx: Tx, placed: NodeId, placement: Placement) {
    if (placement.kind !== "at") return;
    const a = blockKeyOf(tx, placed);
    const b = blockKeyOf(tx, placement.target);
    if (a !== null && b !== null && a !== b) tx.overlapsBefore.add(pairKey(a, b));
  }

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
        const blocked = obstacles(tx, exclude);
        const near = placeNear({ size, target: rect, direction: placement.direction, obstacles: blocked });
        return { at: snapAlign({ size, at: near, neighbours: blocked, obstacles: blocked }), frame: null };
      }
      case "at_pointer": {
        const mouse = scenePointer();
        if (mouse === null) return resolve(tx, { kind: "auto" }, size, exclude);
        // Pointing into a frame puts the new item in that frame, at the spot.
        const frame = [...nodes.values()].find((n) => {
          const r = n.kind === "frame" && !isDormantFrame(n.root) ? boundsOf([n.root]) : null;
          return r !== null && !exclude.has(n.root.id) && contains(r, { x: mouse.x, y: mouse.y, w: 0, h: 0 });
        });
        if (frame !== undefined) {
          const at = placeAtPoint({ size, point: mouse, obstacles: frameChildren(tx, frame.root.id, exclude) });
          return { at, frame: { element: frame.root } };
        }
        return { at: placeAtPoint({ size, point: mouse, obstacles: obstacles(tx, exclude) }), frame: null };
      }
      case "at": {
        const target = nodes.get(placement.target);
        const live = target === undefined || target.elements.some((el) => exclude.has(el.id)) ? null : nodeRect(target);
        const remembered = live === null ? recentlyGone(placement.target) : null;
        const rect = live ?? remembered?.rect ?? null;
        if (rect === null) return resolve(tx, { kind: "auto" }, size, exclude);
        const frameId = target !== undefined && target.diagram === null ? target.root.frameId : (remembered?.frameId ?? null);
        const frame = liveFrame(tx, frameId);
        return { at: placeOver({ size, target: rect }), frame: frame === undefined ? null : { element: frame } };
      }
      case "auto": {
        const blocked = obstacles(tx, exclude);
        const content = union(blocked);
        const { focus, anchor } = attention(tx, nodes, exclude);
        // Where the user is looking first: beside what the conversation is on, or near the mouse, inside the view.
        const view = viewRect();
        const inView = placeInView({ size, view, focus: focus ?? startPoint(size), anchor, obstacles: blocked });
        if (inView !== null) {
          // Tidy: line up with a neighbour's top or left edge when that is a small nudge that stays in view.
          const snapped = snapAlign({ size, at: inView, neighbours: blocked, obstacles: blocked });
          const at = contains(view, { ...snapped, ...size }) ? snapped : inView;
          // A big block that still lines up with nothing goes in a row or column with a block in view instead.
          const blocks = blocksOf(tx.elements).filter((b) => !b.elementIds.some((id) => exclude.has(id))).map((b) => b.block.rect);
          if (Math.max(size.w, size.h) <= 240 || isAligned({ at, blocks })) return { at, frame: null };
          // The camera follows a new diagram anyway, so a tidy spot just past the view edge beats a stray one in it.
          const reach = inflate(view, Math.max(view.w, view.h) * 0.3);
          return { at: alignedSpot({ size, view: reach, blocks, prefer: at, obstacles: blocked }) ?? at, frame: null };
        }
        // The view is full: grow the board the old way, beside the last thing or in a new row.
        const last = anchorRect(tx, nodes, exclude);
        if (last === null || content === null) {
          return { at: placeAuto({ size, anchor: null, viewportCenter: startPoint(size), obstacles: blocked }), frame: null };
        }
        // Beside the last thing, or a new row under everything: whichever keeps the whole board larger on screen.
        // Either way it lines up with a neighbouring block's edge when one is close.
        const blockRects = blocksOf(tx.elements).filter((b) => !b.elementIds.some((id) => exclude.has(id))).map((b) => b.block.rect);
        const tidy = (at: Point) => snapAlign({ size, at, neighbours: blockRects, obstacles: blocked });
        const beside = tidy(placeAuto({ size, anchor: last, viewportCenter: startPoint(size), obstacles: blocked }));
        const row = tidy(nearestFree({ size, preferred: { x: content.x, y: content.y + content.h + ROW_GAP }, obstacles: blocked }));
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
      if (entry.kind === "edge" || entry.root.frameId !== null || entry.diagram !== null) continue;
      const movable = entry.meta !== null;
      if (entry.kind === "diagram") {
        const rect = nodeRect(entry);
        if (rect === null) continue;
        const members = [...nodes.values()].filter((n) => n.diagram === entry.id).map((n) => n.id);
        out.push({ block: { key: entry.id, rect, movable, order: order(entry.id, entry.root.id) }, elementIds: entry.extent.map((el) => el.id), nodeIds: [entry.id, ...members] });
        continue;
      }
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
      if (entry.kind === "edge" || entry.kind === "frame" || entry.kind === "diagram") continue;
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
    const a = nodeRect(from.kind === "mockup" || from.kind === "image" ? { ...from, extent: [from.root] } : from);
    const b = nodeRect(to.kind === "mockup" || to.kind === "image" ? { ...to, extent: [to.root] } : to);
    if (a === null || b === null) return null;
    const ends = (bend: Point | null) => ({
      start: edgePoint({ rect: a, outline: outlineOf(from.root), toward: bend ?? center(b), gap: EDGE_GAP }),
      end: edgePoint({ rect: b, outline: outlineOf(to.root), toward: bend ?? center(a), gap: EDGE_GAP }),
    });
    const solids: Rect[] = [];
    for (const entry of nodes.values()) {
      if (entry.kind === "edge" || entry.kind === "frame" || entry.kind === "diagram" || entry.id === from.id || entry.id === to.id) continue;
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

  /** Arrows bind to shapes, text and images; a funnel band is a line, which Excalidraw cannot bind to. */
  function bindingTo(entry: NodeEntry) {
    return entry.root.type === "line" || entry.root.type === "arrow" || entry.root.type === "freedraw" ? null : { elementId: entry.root.id, focus: 0, gap: EDGE_GAP };
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
            startBinding: bindingTo(from),
            endBinding: bindingTo(to),
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
              startBinding: bindingTo(from),
              endBinding: bindingTo(to),
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

  /** `wide` lets the zoom go lower than usual, so a whole diagram fits instead of a slice of it. */
  function scheduleFollow(core: readonly ExcalidrawElement[], context: readonly string[] = [], wide = false) {
    if (wide) pendingFollow.wide = true;
    for (const el of core) pendingFollow.core.add(el.id);
    for (const id of context) pendingFollow.context.add(id);
    if (followTimer !== null) window.clearTimeout(followTimer);
    // While a burst is still landing, wait a little longer and take in several new items per camera move.
    followTimer = window.setTimeout(follow, pacing() ? 420 : 140);
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
  /** Elements placed earlier in the burst still landing. */
  const burstSeen = new Set<string>();
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
    // Earlier items of the same burst: the camera tries to show the whole group, not just the newest.
    const burst = scene.filter((el) => burstSeen.has(el.id) && !pendingFollow.core.has(el.id));
    // Everything placed in this thread of thought: the camera should not leave any of it half under the toolbar.
    const now0 = performance.now();
    for (const [id, at] of followedAt) if (now0 - at > THREAD_MS) followedAt.delete(id);
    const thread = scene.filter((el) => followedAt.has(el.id) && !pendingFollow.core.has(el.id));
    // Newest first, one batch per earlier camera move.
    const batches = [...new Set(thread.map((el) => followedAt.get(el.id) ?? 0))].sort((a, b) => b - a).map((t) => thread.filter((el) => followedAt.get(el.id) === t));
    for (const el of core) followedAt.set(el.id, now0);
    for (const el of core) burstSeen.add(el.id);
    if (!pacing()) burstSeen.clear();
    const wide = pendingFollow.wide;
    pendingFollow.core.clear();
    pendingFollow.context.clear();
    pendingFollow.wide = false;
    const itemRect = boundsOf(core);
    if (itemRect === null) return;
    const state = api.getAppState();
    const base0 = followZoom(state.width);
    const limits = wide ? { ...base0, floor: state.width <= 730 ? 0.22 : 0.4 } : base0;
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
    // A burst is one thought, so it may zoom out as far as the floor to stay in view together.
    const burstRect = boundsOf(burst);
    const together = burstRect === null ? null : union([itemRect, burstRect, ...frames]);
    // The new item plus as much of what came just before it as fits at a comfortable zoom.
    let withThread: Rect | null = null;
    for (const batch of batches) {
      const batchRect = boundsOf(batch);
      const next = union([withThread ?? itemRect, ...(batchRect === null ? [] : [batchRect]), ...frames]);
      if (next === null || fitsAt(next) < limits.min) break;
      withThread = next;
    }
    const rect =
      (together !== null && fitsAt(together) >= limits.floor ? together : undefined) ??
      (withThread !== null && fitsAt(withThread) >= limits.min ? withThread : undefined) ??
      options.find((r): r is Rect => r !== null && fitsAt(r) >= limits.min) ??
      itemRect;

    const zoom = base.z;
    const margin = limits.margin / zoom;
    const now = viewAt(zoom, base.cx, base.cy);
    if (contains({ x: now.x + margin, y: now.y + margin, w: now.w - margin * 2, h: now.h - margin * 2 }, rect)) return;

    const plan = (target: Rect, zoomAt?: number) => {
      let z = Math.min(limits.max, Math.max(limits.min, zoom));
      if (fitsAt(target) < z) z = Math.max(limits.floor, fitsAt(target));
      if (zoomAt !== undefined) z = Math.min(z, zoomAt);
      const view = viewAt(z, base.cx, base.cy);
      const m = limits.margin / z;
      // Too big even at the floor: show its top (where a mockup's title and header are), never a slice of the middle.
      const shift = (start: number, size: number, lo: number, len: number) => {
        if (len + 2 * m > size || lo - m < start) return lo - m - start;
        if (lo + len + m > start + size) return lo + len + m - (start + size);
        return 0;
      };
      const dx = shift(view.x, view.w, target.x, target.w);
      const dy0 = shift(view.y, view.h, target.y, target.h);
      const tidy = unstraddle({
        view: { ...view, x: view.x + dx, y: view.y + dy0 },
        chrome: { top: insets.top / z, bottom: insets.bottom / z },
        // Only the new item must stay in view; the rest of the thread just must not end up half under the chrome.
        keep: itemRect,
        others: thread,
        margin: m,
      });
      return { z, dx, dy: dy0 + tidy.d, cut: tidy.cut.length };
    };
    let next = plan(rect);
    // No pan at this zoom keeps the thread clear of the chrome: step the zoom down, as far as stays legible, until one does.
    for (let z = next.z - 0.05; next.cut > 0 && z >= base0.floor - 1e-6; z -= 0.05) {
      const tried = plan(rect, z);
      if (tried.cut === 0) next = tried;
    }
    const { z, dx, dy } = next;
    glide({ from: actual, to: { cx: base.cx + dx, cy: base.cy + dy, z } });
  }

  /**
   * Extra vertical pan so that nothing from the current thread ends up cut by the toolbar or the dock: each such item
   * is either brought fully into view or pushed fully off screen (past the chrome, not just under it), whichever is
   * the smaller move that keeps `keep` in view. When nothing clears every item, the least covered framing wins.
   * `cut` lists the items still left under the chrome.
   */
  function unstraddle(args: { view: Rect; chrome: { top: number; bottom: number }; keep: Rect; others: readonly ExcalidrawElement[]; margin: number }): { d: number; cut: Rect[] } {
    const { view, keep, margin } = args;
    const rects = args.others.flatMap((el) => {
      if (el.type === "arrow" || el.type === "line" || containerIdOf(el) !== null) return [];
      const r = boundsOf([el]);
      return r === null || r.x + r.w < view.x || r.x > view.x + view.w ? [] : [r];
    });
    // Positive pans the camera down (content moves up). Items left (partly) under the toolbar or dock after a pan of `d`:
    const top = (d: number) => view.y + d;
    const bottom = (d: number) => view.y + view.h + d;
    // How much of an item sits in the strips the toolbar and dock cover (scene units of height).
    const covered = (lo: number, hi: number, r: Rect) => Math.max(0, Math.min(hi, r.y + r.h) - Math.max(lo, r.y));
    const underChrome = (r: Rect, d: number) => covered(top(d) - args.chrome.top, top(d), r) + covered(bottom(d), bottom(d) + args.chrome.bottom, r);
    const cutAt = (d: number) => rects.filter((r) => underChrome(r, d) > 0.5);
    const costAt = (d: number) => rects.reduce((sum, r) => sum + underChrome(r, d), 0);
    const keepsItem = (d: number) => keep.y >= top(d) - 1 && keep.y + keep.h <= bottom(d) + 1;
    // Candidate pans: each item's edges lined up just inside the view or just past the chrome, off screen.
    const candidates = [0];
    for (const r of rects) {
      candidates.push(r.y - margin - view.y, r.y + r.h + margin - (view.y + view.h));
      candidates.push(r.y + r.h - (view.y - args.chrome.top), r.y - (view.y + view.h + args.chrome.bottom));
    }
    const best = candidates
      .filter(keepsItem)
      .map((d) => ({ d, cost: costAt(d) }))
      .sort((a, b) => a.cost - b.cost || Math.abs(a.d) - Math.abs(b.d))[0];
    const d = best?.d ?? 0;
    return { d, cut: cutAt(d) };
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
      if (entry.kind === "diagram") for (const member of nodes.values()) if (member.diagram === id) visit(member.id);
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
    const found = liveEntry(tx, op.id);
    // A diagram's node stays in its diagram. Re-adding it as a shape edits that node in place; a loose copy left
    // behind would sit on the diagram, and settling would slide the rest of the diagram away from it.
    const plan = reAddPlan({ op: op.op, id: op.id, owner: found?.diagram ?? null });
    if (plan.kind === "edit-member" && op.op === "add_shape") {
      const laid = reshape(tx, plan.diagram, null, (spec) => ({
        ...spec,
        nodes: spec.nodes.map((n) => (n.id === op.id ? { ...n, label: op.label, color: op.color, shape: op.shape === "text" ? n.shape : op.shape } : n)),
      }));
      if (laid === null) return;
      commit(tx, "undoable", { ghosts: true });
      noteActivity(op.id);
      playEntry(laid);
      scheduleFollow(api.getSceneElements().filter((el) => laid.elementIds.has(el.id)), [], true);
      return;
    }
    // Anything else under a member's id leaves the diagram first, which closes ranks, and then lands as a new item.
    if (plan.kind !== "plain") reshape(tx, plan.diagram, null, (spec) => ({ ...spec, nodes: spec.nodes.filter((n) => n.id !== op.id) }));
    const existing = plan.kind === "plain" ? found : undefined;
    if (existing !== undefined && existing.kind === "frame" && op.op === "add_frame") {
      // Re-declaring a frame renames it; replacing it would strand its children.
      const root = existing.root;
      patch(tx, root.id, (el) => renamedFrame(el, op.title));
      commit(tx);
      noteActivity(op.id);
      return;
    }
    // Re-adding an id replaces the node in place: same top-left, same frame, edges re-attach in finishAdd.
    const spot = existing === undefined || existing.kind === "frame" ? null : nodeRect(existing);
    const keep = spot === null || existing === undefined ? null : { at: { x: spot.x, y: spot.y }, frameId: existing.root.frameId };
    if (existing !== undefined) {
      remove(tx, new Set(existing.extent.map((el) => el.id)));
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
    if (keep === null) allowOverlap(tx, op.id, placement);
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
    noteActivity(nodeId);
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

    // Diagram nodes and diagrams re-lay out, since a longer label can change every position.
    if (entry.diagram !== null || entry.kind === "diagram") {
      const diagramId = entry.diagram ?? entry.id;
      const laid = reshape(tx, diagramId, null, (spec) =>
        entry.kind === "diagram"
          ? { ...spec, title: op.label ?? spec.title, nodes: op.color === undefined ? spec.nodes : spec.nodes.map((n) => ({ ...n, color: op.color ?? n.color })) }
          : { ...spec, nodes: spec.nodes.map((n) => (n.id === op.id ? { ...n, label: op.label ?? n.label, color: op.color ?? n.color } : n)) },
      );
      if (laid === null) return;
      commit(tx, "undoable", { ghosts: true });
      playEntry(laid);
      // A longer label can grow the diagram past the screen edge; keep the whole of it in view.
      scheduleFollow(api.getSceneElements().filter((el) => laid.elementIds.has(el.id)), [], true);
      return;
    }

    if (entry.kind === "sketch") {
      updateSketch(tx, entry, op);
      commit(tx);
      announce(pendingAnnounce.splice(0), "together");
      return;
    }

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

  /** Elements an update created outside the usual add path (a sketch's new label); announced after commit. */
  const pendingAnnounce: ExcalidrawElement[] = [];

  /** Recolors a user's sketch, or writes its label: over the old words if it has some, else just under it. */
  function updateSketch(tx: Tx, entry: NodeEntry, op: Extract<BoardOp, { op: "update" }>) {
    if (op.color !== undefined) {
      const stroke = SWATCHES[op.color].stroke;
      for (const el of entry.elements) if (el.type !== "text") patch(tx, el.id, (current) => newElementWith(current, { strokeColor: stroke }));
    }
    if (op.label === undefined) return;
    const label = op.label;
    const texts = entry.elements.filter((el) => el.type === "text" && el.containerId === null).sort((a, b) => a.y - b.y || a.x - b.x);
    const [first, ...rest] = texts;
    if (first !== undefined) {
      patch(tx, first.id, (el) => retext(el, label));
      remove(tx, new Set(rest.map((el) => el.id)));
      return;
    }
    const rect = nodeRect(entry);
    if (rect === null) return;
    const [text] = convertToExcalidrawElements([{ type: "text", x: 0, y: 0, text: label, fontSize: 20, fontFamily: BOARD_FONT, strokeColor: entry.root.strokeColor }]);
    if (text === undefined) return;
    const placed = { ...text, x: rect.x + rect.w / 2 - text.width / 2, y: rect.y + rect.h + 8, frameId: entry.root.frameId, customData: withSketchId(undefined, entry.id) };
    insert(tx, [placed], null);
    pendingAnnounce.push(placed);
  }

  function move(op: Extract<BoardOp, { op: "move" }>) {
    const tx = begin();
    const nodes = indexNodes(tx.elements);
    const asked = nodes.get(op.id);
    // A diagram's node moves with the whole diagram.
    const entry = asked !== undefined && asked.diagram !== null ? nodes.get(asked.diagram) : asked;
    if (entry === undefined || entry.kind === "edge") return;
    const placement = entry.kind === "diagram" ? diagramPlacement(nodes, entry.id, op.placement) : op.placement;
    if (placement.kind === "inside" && placement.frame === entry.id) return;
    if (placement.kind === "near" && placement.target === entry.id) return;
    const children = entry.kind === "frame" ? tx.elements.filter((el) => el.frameId === entry.root.id && !el.isDeleted) : [];
    const moving = [...entry.extent, ...children];
    const own = new Set(moving.map((el) => el.id));
    const rect = nodeRect(entry);
    if (rect === null) return;
    const { at, frame } = resolve(tx, placement, { w: rect.w, h: rect.h }, own);
    const dx = at.x - rect.x;
    const dy = at.y - rect.y;
    const nextFrameId = entry.kind === "frame" || entry.kind === "diagram" ? null : (frame?.element.id ?? null);
    for (const el of moving) {
      patch(tx, el.id, (current) => {
        const moved = translate(current, dx, dy);
        return entry.elements.includes(el) && entry.kind !== "frame" ? newElementWith(moved, { frameId: nextFrameId }) : moved;
      });
    }
    if (frame !== null && nextFrameId !== null) refitFrame(tx, frame.element.id);
    if (entry.root.frameId !== null && entry.root.frameId !== nextFrameId) refitFrame(tx, entry.root.frameId);
    const touched = new Set<NodeId>([entry.id]);
    const after = indexNodes(tx.elements);
    for (const child of children) {
      const id = nodeIdForElement(after, child.id);
      if (id !== null) touched.add(id);
    }
    for (const member of after.values()) if (member.diagram === entry.id) touched.add(member.id);
    reroute(tx, touched);
    // A moved block counts as the newest, so it is the one that steps aside if it lands on something.
    markPlaced(entry.id);
    allowOverlap(tx, entry.id, placement);
    commit(tx);
    noteActivity(entry.id);
    const placed = tx.elements.filter((el) => own.has(el.id));
    const bounds = boundsOf(placed);
    if (bounds !== null) animator.pointAt(restingPoint(bounds), []);
    scheduleFollow(placed);
  }

  // ---- Diagrams -------------------------------------------------------------------------------

  const measure = excalidrawMeasure();

  /**
   * Nodes deleted in the last moment. A refine deletes loose boxes and then draws a diagram that reuses some of their
   * ids; those come back under their old element ids and glide from where they were, so the change reads as the boxes
   * rearranging themselves rather than a blink.
   */
  type Departed = { elements: ExcalidrawElement[]; rect: Rect; at: number };
  const departed = new Map<NodeId, Departed>();
  const REFINE_WINDOW_MS = 4000;

  function freshDeparted(id: NodeId): Departed | undefined {
    const d = departed.get(id);
    if (d !== undefined && performance.now() - d.at > REFINE_WINDOW_MS) {
      departed.delete(id);
      return undefined;
    }
    return d;
  }

  function rememberDeparted(nodes: ReadonlyMap<NodeId, NodeEntry>, doomed: ReadonlySet<string>) {
    const now = performance.now();
    for (const entry of nodes.values()) {
      if ((entry.kind !== "shape" && entry.kind !== "member") || entry.meta === null || !doomed.has(entry.root.id)) continue;
      const rect = nodeRect(entry);
      if (rect !== null) departed.set(entry.id, { elements: entry.elements.map((el) => ({ ...el })), rect, at: now });
    }
  }

  /** Outline and label element ids of a node, so a diagram can take it over without changing identity. */
  function partIds(elements: readonly ExcalidrawElement[], fallback: string): { root: string; text: string } {
    const root = elements.find((el) => readMeta(el)?.role === "root") ?? elements[0];
    const text = elements.find((el) => el.type === "text" && el.id !== root?.id);
    return { root: root?.id ?? `${fallback}~root`, text: text?.id ?? `${fallback}~text` };
  }

  /** The spec a diagram was last drawn from, brought up to date with what is on the board now. */
  function currentSpec(tx: Tx, nodes: ReadonlyMap<NodeId, NodeEntry>, diagram: NodeEntry): DiagramSpec | null {
    const meta = diagram.meta;
    if (meta === null || meta.kind !== "diagram" || meta.spec === undefined) return null;
    const byId = new Map(tx.elements.map((el) => [el.id, el]));
    const parentOf = new Map(meta.spec.nodes.map((n) => [n.id, n.parent]));
    const live = meta.spec.nodes.flatMap((n) => {
      const entry = nodes.get(n.id);
      const m = entry?.meta ?? null;
      if (entry === undefined || entry.diagram !== diagram.id || m === null || m.kind !== "member") return [];
      return [{ ...n, label: labelOf(entry, byId), color: m.color }];
    });
    const ids = new Set(live.map((n) => n.id));
    // A node whose parent went away hangs from its grandparent instead.
    const parentAmong = (id: NodeId | null): NodeId | null => {
      const seen = new Set<NodeId>();
      let p = id;
      while (p !== null && !ids.has(p) && !seen.has(p)) {
        seen.add(p);
        p = parentOf.get(p) ?? null;
      }
      return p !== null && ids.has(p) ? p : null;
    };
    return {
      ...meta.spec,
      title: labelOf(diagram, byId),
      nodes: live.map((n) => ({ ...n, parent: parentAmong(n.parent) })),
      links: meta.spec.links.filter((l) => ids.has(l.from) && ids.has(l.to)),
    };
  }

  /** Diagrams never go inside frames; next to the frame instead. Near one of its own nodes means near the diagram. */
  function diagramPlacement(nodes: ReadonlyMap<NodeId, NodeEntry>, self: NodeId, placement: Placement): Placement {
    if (placement.kind === "inside") return placement.frame === self ? { kind: "auto" } : { kind: "near", target: placement.frame, direction: "right" };
    if (placement.kind !== "near") return placement;
    const target = nodes.get(placement.target);
    if (target === undefined || placement.target === self || target.diagram === self) return { kind: "auto" };
    if (target.diagram !== null) return { ...placement, target: target.diagram };
    const frame = target.root.frameId === null ? null : nodeIdForElement(nodes, target.root.frameId);
    return frame === null ? placement : { ...placement, target: frame };
  }

  type Laid = { elementIds: Set<string>; titleId: string; steps: EntryStep[]; fresh: Set<string>; revived: ExcalidrawElement[] };

  /**
   * Lays out and (re)builds a diagram inside a transaction. Nodes that already exist under the same id, in this
   * diagram, loose on the board, or deleted a moment ago, keep their element ids, so they glide and stay bound to
   * outside arrows. Everything the old drawing had that the new one lacks is removed.
   */
  function layDiagram(tx: Tx, diagramId: NodeId, spec: DiagramSpec, where: { kind: "at"; at: Point } | { kind: "place"; placement: Placement }): Laid {
    const nodes = indexNodes(tx.elements);
    const liveBefore = new Set(tx.elements.filter(isLive).map((el) => el.id));
    const old = nodes.get(diagramId);
    const oldMeta = old?.meta ?? null;
    const stamp = oldMeta !== null && oldMeta.kind === "diagram" ? oldMeta.stamp : `${Date.now().toString(36)}${(seq++).toString(36)}`;
    const groupId = (old?.kind === "diagram" ? old.root.groupIds[0] : undefined) ?? `${diagramId}~${stamp}~group`;
    const taken = new Set<string>(old?.kind === "diagram" ? old.extent.map((el) => el.id) : []);
    const memberIds = new Map<NodeId, { root: string; text: string }>();
    const anchors: Rect[] = [];
    const revived: ExcalidrawElement[] = [];
    const oldMembers = [...nodes.values()].filter((n) => n.diagram === diagramId).map((n) => n.id);
    /** Other diagrams this one takes a node from; they close ranks afterwards instead of keeping a hole and a stub. */
    const robbed = new Set<NodeId>();

    for (const n of spec.nodes) {
      const entry = nodes.get(n.id);
      const fallback = `${n.id}~${stamp}`;
      if (entry !== undefined && entry.diagram === diagramId) {
        memberIds.set(n.id, partIds(entry.elements, fallback));
        continue;
      }
      if (entry !== undefined && (entry.kind === "shape" || entry.kind === "member") && entry.meta !== null) {
        if (entry.diagram !== null) robbed.add(entry.diagram);
        // A loose box the diagram folds in travels from where it sat.
        memberIds.set(n.id, partIds(entry.elements, fallback));
        for (const el of entry.elements) taken.add(el.id);
        const r = nodeRect(entry);
        if (r !== null) anchors.push(r);
        continue;
      }
      const gone = entry === undefined ? freshDeparted(n.id) : undefined;
      if (gone !== undefined) {
        memberIds.set(n.id, partIds(gone.elements, fallback));
        revived.push(...gone.elements);
        anchors.push(gone.rect);
        departed.delete(n.id);
      }
    }
    remove(tx, taken);

    const ids: DiagramIds = {
      part: (key) => `${diagramId}~${stamp}~${key}`,
      member: (id) => {
        const known = memberIds.get(id);
        if (known !== undefined) return known;
        const made = { root: `${id}~${stamp}~root`, text: `${id}~${stamp}~text` };
        memberIds.set(id, made);
        return made;
      },
    };
    const layout = layoutDiagram(spec, measure);
    const built = buildDiagram({ diagramId, stamp, spec, layout, ids, groupId });
    const bounds = boundsOf(built.elements) ?? { x: 0, y: 0, w: 0, h: 0 };

    let at: Point;
    if (where.kind === "at") at = where.at;
    else {
      const placement = diagramPlacement(nodes, diagramId, where.placement);
      const size = { w: bounds.w, h: bounds.h };
      const anchor = union(anchors);
      if (placement.kind === "auto" && anchor !== null) {
        // Over the boxes it replaces, nodes roughly where they were, the title just above.
        const titleRoom = layout.title.inside ? 0 : layout.title.rect.h + 30;
        at = nearestFree({ size, preferred: { x: anchor.x, y: anchor.y - titleRoom }, obstacles: obstacles(tx, new Set()) });
      } else at = resolve(tx, placement, size, new Set()).at;
    }
    const dx = at.x - bounds.x;
    const dy = at.y - bounds.y;
    const previous = new Map(tx.elements.map((el) => [el.id, el]));
    const placed = built.elements.map((el) => {
      const moved = { ...el, x: el.x + dx, y: el.y + dy };
      const prior = previous.get(el.id);
      return prior === undefined ? moved : { ...moved, version: prior.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) };
    });
    const placedIds = new Set(placed.map((el) => el.id));
    tx.elements = [...tx.elements.filter((el) => !placedIds.has(el.id)), ...placed];

    // Outside arrows to nodes that left the diagram go with them; the rest re-aim at the new spots.
    const kept = new Set(spec.nodes.map((n) => n.id));
    const dropped = new Set(oldMembers.filter((id) => !kept.has(id)));
    if (dropped.size > 0) {
      const edges = new Set<string>();
      for (const entry of indexNodes(tx.elements).values()) {
        const m = entry.meta;
        if (m !== null && m.kind === "edge" && (dropped.has(m.from) || dropped.has(m.to))) for (const el of entry.elements) edges.add(el.id);
      }
      remove(tx, edges);
    }
    reroute(tx, new Set([diagramId, ...kept]));
    for (const other of robbed) if (other !== diagramId) reshape(tx, other, null, (s) => s);
    if (old === undefined) markPlaced(diagramId);
    else if (!placedOrder.has(diagramId)) placedOrder.set(diagramId, -2e6);

    const revivedIds = new Set(revived.map((el) => el.id));
    const fresh = new Set([...placedIds].filter((id) => !liveBefore.has(id) && !revivedIds.has(id)));
    return { elementIds: placedIds, titleId: ids.part("title"), steps: built.steps, fresh, revived };
  }

  /** Re-lays a diagram where it stands after `edit` changes its spec. Removes it when no nodes are left. */
  function reshape(tx: Tx, diagramId: NodeId, at: Point | null, edit: (spec: DiagramSpec) => DiagramSpec): Laid | null {
    const nodes = indexNodes(tx.elements);
    const diagram = nodes.get(diagramId);
    if (diagram === undefined || diagram.kind !== "diagram") return null;
    const spec = currentSpec(tx, nodes, diagram);
    if (spec === null) return null;
    const next = edit(spec);
    if (next.nodes.length === 0) {
      remove(tx, new Set(diagram.extent.map((el) => el.id)));
      return null;
    }
    const rect = nodeRect(diagram);
    const spot = at ?? (rect === null ? null : { x: rect.x, y: rect.y });
    return layDiagram(tx, diagramId, next, spot === null ? { kind: "place", placement: { kind: "auto" } } : { kind: "at", at: spot });
  }

  /** Nodes appear one after another; each connector draws itself once both of its ends are showing. */
  function playEntry(laid: Laid) {
    const nodeSteps = laid.steps.filter((s) => s.node !== null && s.elementIds.some((id) => laid.fresh.has(id)));
    const stagger = Math.max(55, Math.min(110, 1000 / Math.max(1, nodeSteps.length)));
    const nodeDelay = new Map<NodeId, number>();
    for (const [i, step] of nodeSteps.entries()) if (step.node !== null) nodeDelay.set(step.node, 140 + i * stagger);
    const plan = laid.steps.flatMap((step) => {
      const elementIds = step.elementIds.filter((id) => laid.fresh.has(id));
      if (elementIds.length === 0) return [];
      const delay =
        step.node !== null
          ? (nodeDelay.get(step.node) ?? 0)
          : step.after.length > 0
            ? Math.max(0, ...step.after.map((id) => nodeDelay.get(id) ?? 0)) + 220
            : step.kind === "draw"
              ? 60
              : 0;
      return [{ elementIds, delay, draw: step.kind === "draw" }];
    });
    animator.enter(plan);
  }

  function addDiagram(op: Extract<BoardOp, { op: "add_diagram" }>) {
    const seen = new Set<NodeId>();
    const nodes = op.nodes.filter((n) => n.id !== op.id && !seen.has(n.id) && seen.add(n.id));
    if (nodes.length === 0) return;
    const spec: DiagramSpec = { kind: op.kind, title: op.title, nodes, links: op.links, axes: op.axes };
    // Nodes deleted a moment ago that come straight back: their fading copies go, the originals glide instead.
    animator.dropGhosts(new Set(nodes.flatMap((n) => freshDeparted(n.id)?.elements.map((el) => el.id) ?? [])));
    const tx = begin();
    const found = liveEntry(tx, op.id);
    // A node of another diagram leaves it (which closes ranks) before a diagram takes over its id.
    const plan = reAddPlan({ op: op.op, id: op.id, owner: found?.diagram ?? null });
    if (plan.kind !== "plain") reshape(tx, plan.diagram, null, (spec) => ({ ...spec, nodes: spec.nodes.filter((n) => n.id !== op.id) }));
    const existing = plan.kind === "plain" ? found : undefined;
    let where: Parameters<typeof layDiagram>[3] = { kind: "place", placement: op.placement };
    if (existing !== undefined) {
      const rect = nodeRect(existing);
      if (rect !== null) where = { kind: "at", at: { x: rect.x, y: rect.y } };
      if (existing.kind !== "diagram") {
        remove(tx, new Set(existing.extent.map((el) => el.id)));
        if (existing.kind === "frame") releaseChildren(tx, existing.root.id);
      }
    }
    const laid = layDiagram(tx, op.id, spec, where);
    if (where.kind === "place") allowOverlap(tx, op.id, op.placement);
    const transforming = laid.revived.length > 0 || existing !== undefined;
    commit(tx, "undoable", { ghosts: true, revived: laid.revived, glideMs: transforming ? 560 : undefined });
    noteActivity(op.id);
    playEntry(laid);
    const placed = api.getSceneElements().filter((el) => laid.elementIds.has(el.id));
    const rect = boundsOf(animator.finalGeometry(placed));
    if (rect !== null) animator.pointAt(restingPoint(rect), [laid.titleId]);
    scheduleFollow(placed, [], true);
  }

  function apply(op: BoardOp) {
    switch (op.op) {
      case "add_shape":
      case "add_frame":
      case "add_mockup":
      case "add_image":
        addNode(op);
        return;
      case "add_diagram":
        addDiagram(op);
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
        const nodes = indexNodes(tx.elements);
        const asked = new Set(op.ids);
        // Diagrams losing some of their nodes re-lay where they stand.
        const shrinking = new Map<NodeId, Point | null>();
        for (const id of op.ids) {
          const diagramId = nodes.get(id)?.diagram ?? null;
          if (diagramId === null || asked.has(diagramId)) continue;
          const diagram = nodes.get(diagramId);
          const rect = diagram === undefined ? null : nodeRect(diagram);
          shrinking.set(diagramId, rect === null ? null : { x: rect.x, y: rect.y });
        }
        const doomed = deletionSet(tx, op.ids);
        if (doomed.size === 0) return;
        rememberDeparted(nodes, doomed);
        const now = performance.now();
        for (const entry of nodes.values()) {
          if (entry.kind === "edge" || !entry.elements.some((el) => doomed.has(el.id))) continue;
          const rect = nodeRect(entry);
          if (rect !== null) gone.set(entry.id, { rect, frameId: entry.root.frameId, at: now });
        }
        // Frames emptied by this delete (a refine moving their contents into a diagram) go too, not linger empty.
        const touchedFrames = new Set<string>();
        for (const el of tx.elements) if (doomed.has(el.id) && el.frameId !== null) touchedFrames.add(el.frameId);
        remove(tx, doomed);
        const emptied = new Set<string>();
        for (const frameId of touchedFrames) {
          if (tx.elements.some((el) => !el.isDeleted && el.frameId === frameId)) continue;
          const frame = tx.elements.find((el) => el.id === frameId && !el.isDeleted);
          if (frame !== undefined && readMeta(frame) !== null) emptied.add(frameId);
        }
        if (emptied.size > 0) remove(tx, emptied);
        const relaid = [...shrinking].flatMap(([diagramId, at]) => reshape(tx, diagramId, at, (spec) => spec) ?? []);
        commit(tx, "undoable", { ghosts: true, glideMs: 460 });
        for (const laid of relaid) playEntry(laid);
        if (lastPlaced !== null && op.ids.includes(lastPlaced)) lastPlaced = null;
        return;
      }
      case "set_title":
        setTitle(op.title);
        return;
      case "clear": {
        const tx = begin();
        remove(tx, new Set(tx.elements.map((el) => el.id)));
        commit(tx, "undoable", { ghosts: true });
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

  /** Scene rect rounded to whole units, as the summary reports it. */
  function rounded(r: Rect): Rect {
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  }

  /** Pointer reach for "nearest item", in scene units: about 160 screen pixels. */
  const OVER_REACH_PX = 160;

  /** The item under the mouse (the smallest one containing it), else the nearest within reach. */
  function itemAt(point: Point, items: readonly BoardItem[]): NodeId | null {
    const candidates = items.filter((item) => item.kind !== "edge" && item.kind !== "diagram");
    const hit = (r: Rect) => point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
    const under = candidates.filter((item) => hit(item.bounds)).sort((a, b) => a.bounds.w * a.bounds.h - b.bounds.w * b.bounds.h)[0];
    if (under !== undefined) return under.id;
    const reach = OVER_REACH_PX / api.getAppState().zoom.value;
    const gap = (r: Rect) => Math.hypot(Math.max(r.x - point.x, 0, point.x - (r.x + r.w)), Math.max(r.y - point.y, 0, point.y - (r.y + r.h)));
    const near = candidates
      .filter((item) => item.kind !== "frame")
      .map((item) => ({ id: item.id, d: gap(item.bounds) }))
      .filter((c) => c.d <= reach)
      .sort((a, b) => a.d - b.d)[0];
    return near?.id ?? null;
  }

  function getSummary(): BoardSummary {
    const synced = syncSketches(dedupeNodeIds(api.getSceneElementsIncludingDeleted()));
    const state = api.getAppState();
    const busy = state.newElement !== null || state.selectedElementsAreBeingDragged || state.isResizing || state.isRotating || state.editingTextElement !== null;
    // Store the sketch ids so they stay stable, unless the user is mid-gesture (the next summary stores them).
    if (synced.changed && !busy) api.updateScene({ elements: synced.elements, captureUpdate: CaptureUpdateAction.NEVER });
    const elements = synced.elements;
    const nodes = indexNodes(elements);
    const byId = new Map(elements.map((el) => [el.id, el]));
    const nodeOfElement = new Map<string, NodeId>();
    for (const entry of nodes.values()) for (const el of entry.elements) nodeOfElement.set(el.id, entry.id);

    const items: BoardItem[] = [];
    for (const entry of nodes.values()) {
      const label = labelOf(entry, byId).trim();
      const frame = entry.root.frameId === null ? null : (nodeOfElement.get(entry.root.frameId) ?? null);
      const origin = entry.meta === null ? "user" : "agent";
      const rect = entry.kind === "edge" ? boundsOf(entry.elements) : nodeRect(entry);
      if (rect === null) continue;
      const bounds = rounded(rect);
      if (entry.kind === "edge") {
        const meta = entry.meta;
        const arrow = entry.root;
        const from = meta !== null && meta.kind === "edge" ? meta.from : arrow.type === "arrow" ? (nodeOfElement.get(arrow.startBinding?.elementId ?? "") ?? null) : null;
        const to = meta !== null && meta.kind === "edge" ? meta.to : arrow.type === "arrow" ? (nodeOfElement.get(arrow.endBinding?.elementId ?? "") ?? null) : null;
        if (from === null || to === null || !nodes.has(from) || !nodes.has(to)) continue;
        items.push({ id: entry.id, kind: "edge", origin, bounds, label, frame, link: `${from} -> ${to}` });
        continue;
      }
      // Diagram nodes are shapes inside their diagram, so the agent can update, link or delete them one by one.
      if (entry.kind === "member") {
        items.push({ id: entry.id, kind: "shape", origin, bounds, label, frame: entry.diagram, link: "" });
        continue;
      }
      items.push({ id: entry.id, kind: entry.kind, origin, bounds, label, frame, link: "" });
    }

    const selected = new Set<NodeId>();
    for (const elementId of Object.keys(state.selectedElementIds)) {
      const id = nodeOfElement.get(elementId);
      if (id !== undefined) selected.add(id);
    }
    const kept = items.slice(0, 400);
    const mouse = scenePointer();
    return {
      title,
      items: kept,
      selection: [...selected],
      pointer: mouse === null ? null : { x: Math.round(mouse.x), y: Math.round(mouse.y), over: itemAt(mouse, kept) },
      viewport: rounded(viewRect()),
    };
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

  // ---- Pacing and the partner's cursor ---------------------------------------------------------

  const DORMANT_FRAME_TTL_MS = 10_000;
  let dormantSweepTimer: number | null = null;
  /** Agent frames that lost every child (contents moved into a diagram, deleted, or moved out) are removed. */
  function sweepEmptyFrames() {
    const tx = begin();
    const occupied = new Set<string>();
    for (const el of tx.elements) if (!el.isDeleted && el.frameId !== null) occupied.add(el.frameId);
    const empty = new Set<string>();
    for (const el of tx.elements) {
      if (el.isDeleted || el.type !== "frame" || occupied.has(el.id)) continue;
      // A dormant frame waits briefly for its first child; one that never gets it stops reserving space.
      if (isDormantFrame(el) && Date.now() - el.updated < DORMANT_FRAME_TTL_MS) continue;
      const meta = readMeta(el);
      if (meta !== null && meta.kind === "frame") empty.add(el.id);
    }
    if (empty.size === 0) return;
    remove(tx, empty);
    commit(tx, "undoable", { ghosts: true });
  }

  const runSweep = guard(() => sweepEmptyFrames(), undefined);

  const runSafely = guard((task: PacedTask) => {
    if (task.kind === "op") {
      apply(task.op);
      if (task.op.op !== "add_frame") sweepEmptyFrames();
      else {
        // Re-check once the dormant frame's grace period has passed, in case no child ever arrives.
        if (dormantSweepTimer !== null) window.clearTimeout(dormantSweepTimer);
        dormantSweepTimer = window.setTimeout(() => { dormantSweepTimer = null; runSweep(); }, DORMANT_FRAME_TTL_MS + 500);
      }
    } else task.run();
  }, undefined);
  const pacer = createPacer({
    run: runSafely,
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (handle) => window.clearTimeout(handle),
    now: () => performance.now(),
  });
  pacing = () => pacer.waiting() > 0;

  let activity: PartnerActivity = { kind: "idle" };

  /** Where the partner will most likely draw next: the user's focus, else beside the last thing, else mid-view. */
  function likelySpot(): Point {
    const elements = api.getSceneElements();
    const tx: Tx = { elements: [...elements], overlapsBefore: new Set() };
    const nodes = indexNodes(elements);
    const { focus, anchor } = attention(tx, nodes, new Set());
    if (focus !== null) return focus;
    if (anchor !== null) return { x: anchor.x + anchor.w + 60, y: anchor.y + anchor.h / 2 };
    return center(viewRect());
  }

  function setPartner(next: PartnerActivity) {
    const prev = activity;
    activity = next;
    switch (next.kind) {
      case "idle":
        animator.setStatus(null);
        return;
      case "thinking":
        animator.setStatus("…");
        // A new phrase: glide toward where it will land right away, so silence never reads as being ignored.
        if (prev.kind !== "thinking" || prev.key !== next.key) animator.anticipate(likelySpot());
        return;
      case "tidying":
        animator.setStatus("· tidying up…");
        if (prev.kind !== "tidying") animator.anticipate(likelySpot());
        return;
      default: {
        const _exhaustive: never = next;
        return _exhaustive;
      }
    }
  }

  return {
    apply: (op) => pacer.push({ kind: "op", op }),
    getSummary: guard(getSummary, { title: DEFAULT_TITLE, items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 0, h: 0 } }),
    showPending: guard(showPending, undefined),
    // Behind any ops still waiting, so an image lands in its card before the card goes.
    clearPending: (id) => pacer.push({ kind: "task", run: () => clearPending(id) }),
    trackPointer(sample) {
      pointer = sample === null ? null : { ...sample, at: performance.now() };
    },
    setPartner: guard(setPartner, undefined),
    getTitle: () => title,
    setTitle: guard(setTitle, undefined),
    subscribeTitle(listener) {
      titleListeners.add(listener);
      return () => titleListeners.delete(listener);
    },
    dispose() {
      pacer.dispose();
      if (dormantSweepTimer !== null) window.clearTimeout(dormantSweepTimer);
      if (cameraFrame !== null) cancelAnimationFrame(cameraFrame);
      animator.dispose();
      if (followTimer !== null) window.clearTimeout(followTimer);
      titleListeners.clear();
    },
  };
}
