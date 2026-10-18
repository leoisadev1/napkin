// Layout math for agent diagrams (flow, cycle, tree, mindmap, timeline, funnel, quadrant). Pure: text is measured
// through an injected function, so the same code runs against Excalidraw's own text metrics in the browser and a
// fixed-width estimate in unit tests. Output is plain geometry; diagramBuild.ts turns it into Excalidraw elements.
import type { Color, DiagramKind, DiagramLink, DiagramNode, NodeId } from "../../shared/board";
import type { Point, Rect } from "./geometry";
import { center, inflate, overlaps, segmentHitsRect, union } from "./geometry";

export type DiagramSpec = {
  kind: DiagramKind;
  title: string;
  nodes: readonly DiagramNode[];
  links: readonly DiagramLink[];
  axes: readonly string[];
};

/** Size of `text` (already broken into lines) at `fontSize` in the hand-drawn font. */
export type Measure = (text: string, fontSize: number) => { w: number; h: number };

export type NodeShape = DiagramNode["shape"] | "band" | "cell";

export type TextBox = { text: string; size: number; rect: Rect };

export type LaidNode = {
  id: NodeId;
  color: Color;
  shape: NodeShape;
  rect: Rect;
  /** The label as wrapped and measured. Bound into the shape, except for bands and cells (free text over them). */
  text: TextBox;
  /** Funnel bands only: closed outline, first point repeated last. */
  polygon: Point[] | null;
  /** The mindmap center is a solid hub and its outermost ideas are quiet leaves; everything else is a plain node. */
  role: "node" | "center" | "leaf";
};

export type Tone = "ink" | "soft" | "faint";

export type Connector = {
  /** Stable within a diagram, so a re-layout can morph the same connector instead of redrawing it. */
  key: string;
  from: NodeId | null;
  to: NodeId | null;
  points: Point[];
  /** Smooth curve through the points rather than straight segments. */
  curved: boolean;
  head: "arrow" | "none";
  /** Stroke follows this node color; null means neutral ink. */
  color: Color | null;
  label: TextBox | null;
};

export type Deco =
  /** `after`: nodes that should be showing before the line draws in. */
  | { kind: "line"; key: string; points: Point[]; head: "arrow" | "none"; tone: Tone; width: number; after: NodeId[] }
  | { kind: "dot"; key: string; rect: Rect; color: Color }
  | { kind: "text"; key: string; text: TextBox; tone: Tone; align: "left" | "center" | "right" };

export type DiagramLayout = {
  title: TextBox & { inside: boolean };
  nodes: LaidNode[];
  connectors: Connector[];
  decos: Deco[];
  bounds: Rect;
};

// ---- Text and shape sizing --------------------------------------------------------------------

export const NODE_FONT = 20;
/** Outermost mindmap ideas: a step below nodes, so the map reads hub, arms, details. */
const LEAF_FONT = 17;
const TITLE_FONT = 26;
const SMALL_FONT = 17;
/** Matches Excalidraw's BOUND_TEXT_PADDING; the shapes keep extra room on top of it. */
const BOUND_PAD = 5;

/** Greedy word wrap by measured width. A single word longer than the limit stays whole and widens its shape. */
export function wrapToWidth(measure: Measure, text: string, size: number, maxWidth: number): string {
  const out: string[] = [];
  for (const paragraph of text.trim().split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (line.length === 0 || measure(candidate, size).w <= maxWidth) line = candidate;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function textBox(measure: Measure, label: string, size: number, maxWidth: number): TextBox {
  const text = wrapToWidth(measure, label, size, maxWidth);
  const m = measure(text, size);
  return { text, size, rect: { x: 0, y: 0, w: m.w, h: m.h } };
}

function centeredAt(box: TextBox, c: Point): TextBox {
  return { ...box, rect: { x: c.x - box.rect.w / 2, y: c.y - box.rect.h / 2, w: box.rect.w, h: box.rect.h } };
}

function topLeftAt(box: TextBox, p: Point): TextBox {
  return { ...box, rect: { ...box.rect, x: p.x, y: p.y } };
}

/** Outer size of a shape whose label (bound text of `text` size) must fit with room to spare. */
export function shapeSize(shape: DiagramNode["shape"], text: { w: number; h: number }): { w: number; h: number } {
  switch (shape) {
    case "box":
      return { w: Math.max(150, text.w + 48), h: Math.max(64, text.h + 34) };
    case "ellipse":
      // Excalidraw fits bound text in the inscribed rectangle, width / sqrt(2).
      return { w: Math.max(150, (text.w + 28) * Math.SQRT2), h: Math.max(84, (text.h + 22) * Math.SQRT2) };
    case "diamond":
      // Text box corners stay inside |x|/a + |y|/b <= 1, and Excalidraw allows width / 2 of text.
      return { w: Math.max(170, 2 * (text.w + 18)), h: Math.max(110, 2 * (text.h + 14)) };
    case "sticky":
      return { w: Math.max(140, text.w + 40), h: Math.max(100, text.h + 40) };
    default: {
      const _exhaustive: never = shape;
      return _exhaustive;
    }
  }
}

/** Largest text box Excalidraw lets a container hold, mirroring its getBoundTextMaxWidth / MaxHeight. */
export function boundTextRoom(shape: DiagramNode["shape"], size: { w: number; h: number }): { w: number; h: number } {
  switch (shape) {
    case "ellipse":
      return { w: Math.round((size.w / 2) * Math.SQRT2) - BOUND_PAD * 2, h: Math.round((size.h / 2) * Math.SQRT2) - BOUND_PAD * 2 };
    case "diamond":
      return { w: Math.round(size.w / 2) - BOUND_PAD * 2, h: Math.round(size.h / 2) - BOUND_PAD * 2 };
    case "box":
    case "sticky":
      return { w: size.w - BOUND_PAD * 2, h: size.h - BOUND_PAD * 2 };
    default: {
      const _exhaustive: never = shape;
      return _exhaustive;
    }
  }
}

type Sized = { node: DiagramNode; shape: DiagramNode["shape"]; text: TextBox; w: number; h: number; color: Color };

export function lineCount(text: string): number {
  return text.split("\n").length;
}

/**
 * Wraps a label wider before taller: the narrowest width from `minWidth` up to `maxWidth` that keeps it within a
 * tier's line budget, trying tiers in order (fewest lines at the full font first, then a step smaller font).
 */
export function fitLabel(measure: Measure, label: string, opts: { minWidth: number; maxWidth: number; tiers: readonly { size: number; lines: number }[] }): TextBox {
  for (const tier of opts.tiers) {
    for (let w = opts.minWidth; w <= opts.maxWidth; w += 10) {
      const box = textBox(measure, label, tier.size, w);
      if (lineCount(box.text) <= tier.lines) return box;
    }
  }
  const last = opts.tiers[opts.tiers.length - 1];
  return textBox(measure, label, last?.size ?? NODE_FONT, opts.maxWidth);
}

/** An ellipse holding more than this many lines turns into a tall egg; a rounded box reads better. */
const ELLIPSE_MAX_LINES = 3;

function sizeNode(measure: Measure, node: DiagramNode, opts: { size?: number; maxWidth?: number; grow?: number; shape?: DiagramNode["shape"]; color?: Color } = {}): Sized {
  const size = opts.size ?? NODE_FONT;
  const minWidth = opts.maxWidth ?? 170;
  // Long labels widen the node first (diamonds less, since only half their width holds text), then drop a font step.
  const wanted = opts.shape ?? node.shape;
  const maxWidth = opts.grow ?? minWidth + (wanted === "diamond" ? 40 : 80);
  const text = fitLabel(measure, node.label, {
    minWidth,
    maxWidth,
    tiers: [
      { size, lines: 3 },
      { size, lines: 4 },
      { size: size - 2, lines: 4 },
      { size: size - 3, lines: 5 },
    ],
  });
  const shape = wanted === "ellipse" && lineCount(text.text) > ELLIPSE_MAX_LINES ? "box" : wanted;
  const s = shapeSize(shape, text.rect);
  return { node, shape, text, w: Math.ceil(s.w), h: Math.ceil(s.h), color: opts.color ?? node.color };
}

function laid(s: Sized, at: Point, role: LaidNode["role"] = "node"): LaidNode {
  const rect = { x: at.x, y: at.y, w: s.w, h: s.h };
  return { id: s.node.id, color: s.color, shape: s.shape, rect, text: centeredAt(s.text, center(rect)), polygon: null, role };
}

/** Same node, centered on `c`. */
function laidAround(s: Sized, c: Point, role: LaidNode["role"] = "node"): LaidNode {
  return laid(s, { x: c.x - s.w / 2, y: c.y - s.h / 2 }, role);
}

// ---- Small geometry helpers -------------------------------------------------------------------

const GAP_OUT = 8;

function midRight(r: Rect): Point {
  return { x: r.x + r.w + GAP_OUT, y: r.y + r.h / 2 };
}
function midLeft(r: Rect): Point {
  return { x: r.x - GAP_OUT, y: r.y + r.h / 2 };
}
function midTop(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y - GAP_OUT };
}
function midBottom(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h + GAP_OUT };
}

/** Label for a connector segment: above a horizontal run, right of a vertical one. */
function segmentLabel(measure: Measure, label: string, a: Point, b: Point, along = 0.5): TextBox | null {
  if (label.trim().length === 0) return null;
  const box = textBox(measure, label, SMALL_FONT, 140);
  const p = { x: a.x + (b.x - a.x) * along, y: a.y + (b.y - a.y) * along };
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const c = horizontal ? { x: p.x, y: p.y - box.rect.h / 2 - 8 } : { x: p.x + box.rect.w / 2 + 12, y: p.y };
  return centeredAt(box, c);
}

function textRectOf(deco: Deco): Rect | null {
  if (deco.kind === "text") return deco.text.rect;
  if (deco.kind === "dot") return deco.rect;
  return null;
}

function pointsRect(points: readonly Point[]): Rect | null {
  return union(points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
}

/** Puts the title above the diagram and computes the overall bounds. */
function finish(measure: Measure, spec: DiagramSpec, body: Omit<DiagramLayout, "title" | "bounds">, inside: TextBox | null = null): DiagramLayout {
  const rects: Rect[] = [
    ...body.nodes.map((n) => n.rect),
    ...body.connectors.flatMap((c) => [pointsRect(c.points), c.label?.rect ?? null].filter((r): r is Rect => r !== null)),
    ...body.decos.flatMap((d) => {
      const r = d.kind === "line" ? pointsRect(d.points) : textRectOf(d);
      return r === null ? [] : [r];
    }),
  ];
  const content = union(rects) ?? { x: 0, y: 0, w: 0, h: 0 };
  if (inside !== null) {
    const title = { ...inside, inside: true };
    return { ...body, title, bounds: union([content, title.rect]) ?? content };
  }
  const box = textBox(measure, spec.title.trim().length > 0 ? spec.title : " ", TITLE_FONT, Math.max(320, content.w));
  const title = { ...topLeftAt(box, { x: content.x, y: content.y - 30 - box.rect.h }), inside: false };
  return { ...body, title, bounds: union([content, title.rect]) ?? content };
}

// ---- Flow ---------------------------------------------------------------------------------------

const FLOW_COL_GAP = 96;
const FLOW_ROW_GAP = 64;
const FLOW_WRAP = 5;

/** Positive answers stay on the main line; the rest branch below. */
function branchRank(label: string): number {
  const l = label.trim().toLowerCase();
  if (/^(yes|y|true|ok|pass|success|approved?|valid|go)\b/.test(l)) return 0;
  if (l.length === 0) return 1;
  if (/^(no|n|false|fail|reject(ed)?|invalid|error|else|otherwise)\b/.test(l)) return 3;
  return 2;
}

function layoutFlow(measure: Measure, spec: DiagramSpec): DiagramLayout {
  const sized = spec.nodes.map((n) => sizeNode(measure, n, { maxWidth: n.shape === "diamond" ? 130 : 170 }));
  const ids = spec.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const explicit = spec.links.filter((l) => l.from !== l.to && index.has(l.from) && index.has(l.to));
  const sequential = explicit.length === 0;
  const links: DiagramLink[] = sequential ? ids.slice(1).map((to, i) => ({ from: ids[i] ?? to, to, label: "" })) : explicit;

  // A long plain chain snakes through rows so it never becomes a ribbon wider than the screen.
  const isChain = links.length === ids.length - 1 && links.every((l, i) => l.from === ids[i] && l.to === ids[i + 1]);
  if (isChain && ids.length > FLOW_WRAP) return layoutSnake(measure, spec, sized, links);

  // Ranks: longest path over forward edges. An edge into a node still on the DFS stack is a loop back.
  const out = new Map<NodeId, DiagramLink[]>(ids.map((id) => [id, []]));
  for (const l of links) out.get(l.from)?.push(l);
  const back = new Set<DiagramLink>();
  const state = new Map<NodeId, "open" | "done">();
  const visit = (id: NodeId) => {
    state.set(id, "open");
    for (const l of out.get(id) ?? []) {
      const s = state.get(l.to);
      if (s === "open") back.add(l);
      else if (s === undefined) visit(l.to);
    }
    state.set(id, "done");
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  const forward = links.filter((l) => !back.has(l));
  const rank = new Map<NodeId, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const l of forward) {
      const next = (rank.get(l.from) ?? 0) + 1;
      if (next > (rank.get(l.to) ?? 0)) {
        rank.set(l.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Lanes: the first (most positive) branch keeps its parent's lane, others open lanes below.
  const order = [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || (index.get(a) ?? 0) - (index.get(b) ?? 0));
  const lane = new Map<NodeId, number>();
  const wanted = new Map<NodeId, number>();
  const taken = new Set<string>();
  let lanes = 0;
  for (const id of order) {
    let l = wanted.get(id) ?? lanes;
    while (taken.has(`${rank.get(id)}:${l}`)) l++;
    lane.set(id, l);
    taken.add(`${rank.get(id)}:${l}`);
    lanes = Math.max(lanes, l + 1);
    const children = forward
      .filter((link) => link.from === id)
      .sort((a, b) => branchRank(a.label) - branchRank(b.label) || (index.get(a.to) ?? 0) - (index.get(b.to) ?? 0));
    for (const [i, link] of children.entries()) {
      // Side branches take the nearest lane below that is free; the per-rank check above bumps further if needed.
      const want = i === 0 ? l : l + i;
      wanted.set(link.to, Math.min(wanted.get(link.to) ?? Infinity, want));
    }
  }

  const ranks = Math.max(...ids.map((id) => rank.get(id) ?? 0)) + 1;
  const laneCount = Math.max(...ids.map((id) => lane.get(id) ?? 0)) + 1;
  const colW = Array.from({ length: ranks }, () => 0);
  const laneH = Array.from({ length: laneCount }, () => 0);
  for (const s of sized) {
    const r = rank.get(s.node.id) ?? 0;
    const l = lane.get(s.node.id) ?? 0;
    colW[r] = Math.max(colW[r] ?? 0, s.w);
    laneH[l] = Math.max(laneH[l] ?? 0, s.h);
  }
  // Gaps widen to fit labels on the links that cross them.
  const gapAfter = Array.from({ length: ranks }, () => FLOW_COL_GAP);
  for (const l of forward) {
    if (l.label.trim().length === 0) continue;
    const r = rank.get(l.from) ?? 0;
    const w = textBox(measure, l.label, SMALL_FONT, 140).rect.w;
    gapAfter[r] = Math.max(gapAfter[r] ?? 0, w + 56);
  }
  const colX: number[] = [];
  let x = 0;
  for (let r = 0; r < ranks; r++) {
    colX.push(x);
    x += (colW[r] ?? 0) + (gapAfter[r] ?? FLOW_COL_GAP);
  }
  const laneY: number[] = [];
  let y = 0;
  for (let l = 0; l < laneCount; l++) {
    laneY.push(y);
    y += (laneH[l] ?? 0) + FLOW_ROW_GAP;
  }

  const nodes = sized.map((s) => {
    const r = rank.get(s.node.id) ?? 0;
    const l = lane.get(s.node.id) ?? 0;
    return laid(s, { x: (colX[r] ?? 0) + ((colW[r] ?? 0) - s.w) / 2, y: (laneY[l] ?? 0) + ((laneH[l] ?? 0) - s.h) / 2 });
  });
  const rectOf = new Map(nodes.map((n) => [n.id, n.rect]));
  const shapeOf = new Map(nodes.map((n) => [n.id, n.shape]));
  const top = Math.min(...nodes.map((n) => n.rect.y));
  const bottom = Math.max(...nodes.map((n) => n.rect.y + n.rect.h));
  let over = 0;
  let under = 0;
  const connectors: Connector[] = [];
  for (const link of links) {
    const a = rectOf.get(link.from);
    const b = rectOf.get(link.to);
    if (a === undefined || b === undefined) continue;
    const others = nodes.filter((n) => n.id !== link.from && n.id !== link.to).map((n) => inflate(n.rect, 6));
    const yTop = top - 44 - 30 * over;
    const yLow = bottom + 44 + 30 * under;
    const points = flowRoute({ a, b, backward: back.has(link), others, yTop, yLow });
    // Each loop that runs over or under the diagram gets its own track.
    if (points.some((p) => p.y === yTop)) over++;
    if (points.some((p) => p.y === yLow)) under++;
    // Decision answers sit next to the decision; other labels ride the longest run.
    const fromDecision = shapeOf.get(link.from) === "diamond";
    const segments = points.slice(1).map((p, i) => ({ a: points[i] ?? p, b: p }));
    const longest = segments.reduce((best, seg) => (Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y) > Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y) ? seg : best), segments[0] ?? { a: points[0] ?? { x: 0, y: 0 }, b: points[0] ?? { x: 0, y: 0 } });
    const seg = fromDecision ? (segments[0] ?? longest) : longest;
    const label = segmentLabel(measure, link.label, seg.a, seg.b, fromDecision && points.length > 2 ? 0.4 : 0.5);
    connectors.push({ key: `${link.from}>${link.to}`, from: link.from, to: link.to, points, curved: false, head: "arrow", color: null, label });
  }
  return finish(measure, spec, { nodes, connectors, decos: [] });
}

/**
 * Orthogonal route from rect `a` to rect `b`: the first of a few standard shapes (straight, one elbow, a loop over or
 * under) that crosses no other node. Loops back to an earlier step go over the top.
 */
function flowRoute(args: { a: Rect; b: Rect; backward: boolean; others: readonly Rect[]; yTop: number; yLow: number }): Point[] {
  const { a, b, others } = args;
  const ac = center(a);
  const bc = center(b);
  const clear = (points: readonly Point[]) => points.slice(1).every((p, i) => others.every((r) => !segmentHitsRect(points[i] ?? p, p, r)));
  const candidates: (() => Point[] | null)[] = [];
  const ahead = b.x > a.x + a.w;
  if (!args.backward && ahead) {
    candidates.push(
      () => (Math.abs(ac.y - bc.y) < 1 ? [midRight(a), midLeft(b)] : null),
      () => (bc.y > ac.y ? [midBottom(a), { x: ac.x, y: bc.y }, midLeft(b)] : [midTop(a), { x: ac.x, y: bc.y }, midLeft(b)]),
      () => (bc.y > ac.y ? [midRight(a), { x: bc.x, y: ac.y }, midTop(b)] : [midRight(a), { x: bc.x, y: ac.y }, midBottom(b)]),
    );
  }
  const loopOver = () => {
    const y = args.yTop;
    return [midTop(a), { x: ac.x, y }, { x: bc.x, y }, midTop(b)];
  };
  const loopUnder = () => {
    const y = args.yLow;
    return [midBottom(a), { x: ac.x, y }, { x: bc.x, y }, midBottom(b)];
  };
  const aroundOver = () => {
    const y = args.yTop;
    const x = a.x + a.w + 36;
    return [midRight(a), { x, y: ac.y }, { x, y }, { x: bc.x, y }, midTop(b)];
  };
  const aroundUnder = () => {
    const y = args.yLow;
    const x = a.x + a.w + 36;
    return [midRight(a), { x, y: ac.y }, { x, y }, { x: bc.x, y }, midBottom(b)];
  };
  candidates.push(loopOver, loopUnder, aroundOver, aroundUnder);
  for (const make of candidates) {
    const points = make();
    if (points !== null && clear(points)) return points;
  }
  return loopOver();
}

/** A chain longer than one row: rows alternate direction, so each turn is a short drop. */
function layoutSnake(measure: Measure, spec: DiagramSpec, sized: readonly Sized[], links: readonly DiagramLink[]): DiagramLayout {
  const rows = Math.ceil(sized.length / FLOW_WRAP);
  const perRow = Math.ceil(sized.length / rows);
  const colW = Array.from({ length: perRow }, () => 0);
  const rowH = Array.from({ length: rows }, () => 0);
  const slot = (i: number) => {
    const row = Math.floor(i / perRow);
    const k = i % perRow;
    return { row, col: row % 2 === 0 ? k : perRow - 1 - k };
  };
  for (const [i, s] of sized.entries()) {
    const { row, col } = slot(i);
    colW[col] = Math.max(colW[col] ?? 0, s.w);
    rowH[row] = Math.max(rowH[row] ?? 0, s.h);
  }
  const gap = Math.max(FLOW_COL_GAP, ...links.map((l) => (l.label.trim().length === 0 ? 0 : textBox(measure, l.label, SMALL_FONT, 140).rect.w + 56)));
  const colX: number[] = [];
  let x = 0;
  for (const w of colW) {
    colX.push(x);
    x += w + gap;
  }
  const rowY: number[] = [];
  let y = 0;
  for (const h of rowH) {
    rowY.push(y);
    y += h + FLOW_ROW_GAP + 24;
  }
  const nodes = sized.map((s, i) => {
    const { row, col } = slot(i);
    return laid(s, { x: (colX[col] ?? 0) + ((colW[col] ?? 0) - s.w) / 2, y: (rowY[row] ?? 0) + ((rowH[row] ?? 0) - s.h) / 2 });
  });
  const connectors: Connector[] = [];
  for (const [i, link] of links.entries()) {
    const a = nodes[i]?.rect;
    const b = nodes[i + 1]?.rect;
    if (a === undefined || b === undefined) continue;
    const sameRow = slot(i).row === slot(i + 1).row;
    const forward = slot(i).row % 2 === 0;
    const points = sameRow ? (forward ? [midRight(a), midLeft(b)] : [midLeft(a), midRight(b)]) : [midBottom(a), midTop(b)];
    const [p0, p1] = points;
    const label = p0 !== undefined && p1 !== undefined ? segmentLabel(measure, link.label, p0, p1) : null;
    connectors.push({ key: `${link.from}>${link.to}`, from: link.from, to: link.to, points, curved: false, head: "arrow", color: null, label });
  }
  return finish(measure, spec, { nodes, connectors, decos: [] });
}

// ---- Cycle --------------------------------------------------------------------------------------

/** Sample of the ring from angle `a` to `b` (radians, b > a). */
function arc(rx: number, ry: number, a: number, b: number, count: number): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const t = a + ((b - a) * i) / (count - 1);
    return { x: rx * Math.cos(t), y: ry * Math.sin(t) };
  });
}

function insideRect(p: Point, r: Rect): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

function layoutCycle(measure: Measure, spec: DiagramSpec): DiagramLayout {
  const n = spec.nodes.length;
  const sized = spec.nodes.map((node) => sizeNode(measure, node, { maxWidth: n > 6 ? 150 : 170 }));
  const avgW = sized.reduce((s, v) => s + v.w, 0) / n;
  const avgH = sized.reduce((s, v) => s + v.h, 0) / n;
  // Wide labels sit better on a wide ellipse than on a circle.
  const stretch = Math.min(1.55, Math.max(1, avgW / avgH / 1.5));
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const place = (s: number) => {
    const rx = s * stretch;
    return sized.map((v, i) => laidAround(v, { x: rx * Math.cos(angle(i)), y: s * Math.sin(angle(i)) }));
  };
  const clear = (nodes: readonly LaidNode[]) =>
    nodes.every((a, i) => nodes.every((b, j) => j <= i || !overlaps(inflate(a.rect, 30), inflate(b.rect, 30))));
  let s = Math.max(90, avgH);
  let nodes = place(s);
  while (!clear(nodes) && s < 4000) {
    s *= 1.04;
    nodes = place(s);
  }
  // A little more air than the bare minimum, so the arcs between nodes read as arrows.
  s *= n <= 3 ? 1.25 : 1.08;
  nodes = place(s);
  const rx = s * stretch;
  const ry = s;

  const linkLabel = new Map(spec.links.map((l) => [`${l.from}>${l.to}`, l.label]));
  const connectors: Connector[] = [];
  const step = (2 * Math.PI) / n;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    const t0 = angle(i);
    const t1 = t0 + step;
    const ra = inflate(a.rect, 12);
    const rb = inflate(b.rect, 16);
    let start = t0;
    while (start < t1 && insideRect({ x: rx * Math.cos(start), y: ry * Math.sin(start) }, ra)) start += 0.01;
    let end = t1;
    while (end > start && insideRect({ x: rx * Math.cos(end), y: ry * Math.sin(end) }, rb)) end -= 0.01;
    const span = end - start;
    const points = span > 0.04 ? arc(rx, ry, start, end, Math.max(3, Math.min(7, Math.round(span / 0.18) + 1))) : [midRight(a.rect), midLeft(b.rect)];
    const text = linkLabel.get(`${a.id}>${b.id}`) ?? "";
    let label: TextBox | null = null;
    if (text.trim().length > 0) {
      const box = textBox(measure, text, SMALL_FONT, 130);
      const mid = (start + end) / 2;
      const push = Math.hypot((box.rect.w / 2) * Math.cos(mid), (box.rect.h / 2) * Math.sin(mid)) + 16;
      label = centeredAt(box, { x: (rx + push) * Math.cos(mid), y: (ry + push) * Math.sin(mid) });
    }
    connectors.push({ key: `${a.id}>${b.id}`, from: a.id, to: b.id, points, curved: true, head: "arrow", color: null, label });
  }

  // The title rests in the middle of the ring when it fits there.
  const inner = Math.min(
    ...nodes.map((v) => {
      const dx = Math.max(v.rect.x, Math.min(0, v.rect.x + v.rect.w));
      const dy = Math.max(v.rect.y, Math.min(0, v.rect.y + v.rect.h));
      return Math.hypot(dx, dy);
    }),
  );
  const title = textBox(measure, spec.title, 24, Math.max(80, inner * 1.3));
  const fits = spec.title.trim().length > 0 && n >= 3 && Math.hypot(title.rect.w / 2, title.rect.h / 2) <= inner - 26;
  return finish(measure, spec, { nodes, connectors, decos: [] }, fits ? centeredAt(title, { x: 0, y: 0 }) : null);
}

// ---- Tree ---------------------------------------------------------------------------------------

type Forest = { roots: NodeId[]; children: Map<NodeId, NodeId[]> };

/** Parent links as a forest. Missing parents and parent loops make a node a root. */
function forest(nodes: readonly DiagramNode[], rootHint: NodeId | null = null): Forest {
  const ids = new Set(nodes.map((n) => n.id));
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent !== null && ids.has(n.parent) && n.parent !== n.id ? n.parent : null]));
  for (const n of nodes) {
    const seen = new Set<NodeId>([n.id]);
    let p = parentOf.get(n.id) ?? null;
    while (p !== null) {
      if (seen.has(p)) {
        parentOf.set(n.id, null);
        break;
      }
      seen.add(p);
      p = parentOf.get(p) ?? null;
    }
  }
  if (rootHint !== null) {
    for (const n of nodes) if (n.id !== rootHint && parentOf.get(n.id) === null) parentOf.set(n.id, rootHint);
    parentOf.set(rootHint, null);
  }
  const children = new Map<NodeId, NodeId[]>(nodes.map((n) => [n.id, []]));
  const roots: NodeId[] = [];
  for (const n of nodes) {
    const p = parentOf.get(n.id) ?? null;
    if (p === null) roots.push(n.id);
    else children.get(p)?.push(n.id);
  }
  return { roots, children };
}

function layoutTree(measure: Measure, spec: DiagramSpec): DiagramLayout {
  const { roots, children } = forest(spec.nodes);
  const sized = new Map(spec.nodes.map((n) => [n.id, sizeNode(measure, n, { maxWidth: 150 })]));
  const depth = new Map<NodeId, number>();
  const walk = (id: NodeId, d: number) => {
    depth.set(id, d);
    for (const c of children.get(id) ?? []) walk(c, d + 1);
  };
  for (const r of roots) walk(r, 0);
  const levels = Math.max(...[...depth.values()]) + 1;
  const levelH = Array.from({ length: levels }, () => 0);
  for (const [id, d] of depth) levelH[d] = Math.max(levelH[d] ?? 0, sized.get(id)?.h ?? 0);
  const levelY: number[] = [];
  let y = 0;
  for (const h of levelH) {
    levelY.push(y);
    y += h + 84;
  }

  const SIB = 36;
  const width = new Map<NodeId, number>();
  const measureTree = (id: NodeId): number => {
    const kids = children.get(id) ?? [];
    const own = sized.get(id)?.w ?? 0;
    const span = kids.reduce((s, c) => s + measureTree(c), 0) + SIB * Math.max(0, kids.length - 1);
    const w = Math.max(own, span);
    width.set(id, w);
    return w;
  };
  const cx = new Map<NodeId, number>();
  const place = (id: NodeId, left: number) => {
    const kids = children.get(id) ?? [];
    const w = width.get(id) ?? 0;
    if (kids.length === 0) {
      cx.set(id, left + w / 2);
      return;
    }
    const span = kids.reduce((s, c) => s + (width.get(c) ?? 0), 0) + SIB * (kids.length - 1);
    let x = left + (w - span) / 2;
    for (const c of kids) {
      place(c, x);
      x += (width.get(c) ?? 0) + SIB;
    }
    const first = cx.get(kids[0] ?? id) ?? 0;
    const last = cx.get(kids[kids.length - 1] ?? id) ?? 0;
    cx.set(id, (first + last) / 2);
  };
  let left = 0;
  for (const r of roots) {
    const w = measureTree(r);
    place(r, left);
    left += w + 72;
  }

  const nodes: LaidNode[] = spec.nodes.flatMap((n) => {
    const s = sized.get(n.id);
    const d = depth.get(n.id) ?? 0;
    if (s === undefined) return [];
    return [laidAround(s, { x: cx.get(n.id) ?? 0, y: (levelY[d] ?? 0) + (levelH[d] ?? 0) / 2 })];
  });
  // Org-chart connectors: a trunk drops from the parent to a bus, and each child hangs from the bus. Drawing the trunk
  // once keeps hand-drawn strokes from piling up where siblings share a path.
  const rectOf = new Map(nodes.map((v) => [v.id, v.rect]));
  const connectors: Connector[] = [];
  const decos: Deco[] = [];
  for (const [parent, kids] of children) {
    const a = rectOf.get(parent);
    const rects = kids.flatMap((k) => {
      const r = rectOf.get(k);
      return r === undefined ? [] : [{ id: k, r }];
    });
    if (a === undefined || rects.length === 0) continue;
    const p = midBottom(a);
    const busY = p.y + (Math.min(...rects.map(({ r }) => r.y)) - GAP_OUT - p.y) / 2;
    const xs = rects.map(({ r }) => r.x + r.w / 2);
    const straight = rects.length === 1 && Math.abs((xs[0] ?? p.x) - p.x) < 2;
    if (!straight) {
      decos.push({ kind: "line", key: `trunk-${parent}`, points: [p, { x: p.x, y: busY }], head: "none", tone: "soft", width: 2, after: [parent] });
      const lo = Math.min(p.x, ...xs);
      const hi = Math.max(p.x, ...xs);
      decos.push({ kind: "line", key: `bus-${parent}`, points: [{ x: lo, y: busY }, { x: hi, y: busY }], head: "none", tone: "soft", width: 2, after: [parent] });
    }
    for (const { id, r } of rects) {
      const q = midTop(r);
      const from = straight ? p : { x: q.x, y: busY };
      connectors.push({ key: `${parent}>${id}`, from: straight ? parent : null, to: id, points: [from, q], curved: false, head: "arrow", color: null, label: null });
    }
  }
  return finish(measure, spec, { nodes, connectors, decos });
}

// ---- Mindmap ------------------------------------------------------------------------------------

/** Widest a mindmap's center may grow before its label wraps further and then shrinks a font step. */
const CENTER_MAX_W = 320;

/**
 * The center grows with its label. A short one sits in an ellipse; a long one gets a rounded box (an ellipse would
 * have to be a tall egg to hold it) that widens up to CENTER_MAX_W, wraps to at most four lines, then shrinks.
 */
function sizeCenter(measure: Measure, node: DiagramNode): Sized {
  const short = fitLabel(measure, node.label, { minWidth: 150, maxWidth: 200, tiers: [{ size: 26, lines: 2 }] });
  if (lineCount(short.text) <= 2) {
    const s = shapeSize("ellipse", short.rect);
    // Never rounder than about 4:3, so it reads as the hub rather than a ball.
    const h = Math.ceil(s.h);
    return { node, shape: "ellipse", text: short, w: Math.ceil(Math.max(s.w, h * 1.35)), h, color: node.color };
  }
  const text = fitLabel(measure, node.label, {
    minWidth: 200,
    maxWidth: CENTER_MAX_W - 48,
    tiers: [
      { size: 26, lines: 3 },
      { size: 24, lines: 3 },
      { size: 24, lines: 4 },
      { size: 22, lines: 4 },
      { size: 20, lines: 4 },
      { size: 18, lines: 4 },
      { size: 16, lines: 5 },
    ],
  });
  const s = shapeSize("box", text.rect);
  return { node, shape: "box", text, w: Math.ceil(s.w), h: Math.ceil(Math.max(s.h, 96)), color: node.color };
}

/**
 * Where a link leaves the center toward `toward` on side `side`: the ellipse outline, or the box's side edge with
 * the start fanned a little toward the target so sibling links do not all leave from one point.
 */
function centerEdge(r: Rect, shape: NodeShape, toward: Point, side: 1 | -1): Point {
  const c = center(r);
  const limit = r.h * (shape === "ellipse" ? 0.22 : 0.32);
  const spread = Math.max(-limit, Math.min(limit, (toward.y - c.y) * 0.3));
  if (shape !== "ellipse") return { x: side === 1 ? r.x + r.w + GAP_OUT : r.x - GAP_OUT, y: c.y + spread };
  // On the ellipse's outline at that height, so every arm leaves from the hub's side rather than its top or bottom.
  const a = r.w / 2;
  const b = r.h / 2;
  const half = a * Math.sqrt(Math.max(0, 1 - (spread * spread) / (b * b)));
  return { x: c.x + side * (half + GAP_OUT), y: c.y + spread };
}

function layoutMindmap(measure: Measure, spec: DiagramSpec): DiagramLayout {
  const centerNode = spec.nodes.find((n) => n.parent === null) ?? spec.nodes[0];
  if (centerNode === undefined) return finish(measure, spec, { nodes: [], connectors: [], decos: [] });
  const { children } = forest(spec.nodes, centerNode.id);
  const branches = children.get(centerNode.id) ?? [];
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));

  // Every descendant wears its branch's color, so each arm reads as one thought.
  const branchColor = new Map<NodeId, Color>();
  const tint = (id: NodeId, color: Color) => {
    branchColor.set(id, color);
    for (const c of children.get(id) ?? []) tint(c, color);
  };
  for (const b of branches) tint(b, byId.get(b)?.color ?? "gray");

  const sized = new Map<NodeId, Sized>();
  const depthOf = new Map<NodeId, number>();
  const size = (id: NodeId, d: number) => {
    const node = byId.get(id);
    if (node === undefined) return;
    depthOf.set(id, d);
    sized.set(
      id,
      d === 0
        ? sizeCenter(measure, node)
        : sizeNode(measure, node, { size: d === 1 ? NODE_FONT : LEAF_FONT, maxWidth: d === 1 ? 150 : 160, color: branchColor.get(id) ?? node.color }),
    );
    for (const c of children.get(id) ?? []) size(c, d + 1);
  };
  size(centerNode.id, 0);

  // Siblings share one width and the arms share another, so every column of the map has a straight edge.
  const evenWidth = (ids: readonly NodeId[]) => {
    const list = ids.map((i) => sized.get(i)).filter((v): v is Sized => v !== undefined && v.shape === "box");
    const w = Math.max(0, ...list.map((v) => v.w));
    for (const v of list) sized.set(v.node.id, { ...v, w });
  };
  evenWidth(branches);
  const evenBelow = (id: NodeId) => {
    const kids = children.get(id) ?? [];
    if (kids.length > 0) evenWidth(kids);
    for (const c of kids) evenBelow(c);
  };
  for (const b of branches) evenBelow(b);

  const V_GAP = 18;
  const BLOCK_GAP = 40;
  const H_GAP = 84;
  const heightOf = new Map<NodeId, number>();
  const blockHeight = (id: NodeId): number => {
    const kids = children.get(id) ?? [];
    const own = sized.get(id)?.h ?? 0;
    const span = kids.reduce((s, c) => s + blockHeight(c), 0) + V_GAP * Math.max(0, kids.length - 1);
    const h = Math.max(own, span);
    heightOf.set(id, h);
    return h;
  };
  const heights = branches.map((b) => blockHeight(b));

  // Split the arms into a right and a left side of about equal height, keeping their order clockwise.
  let split = branches.length;
  if (branches.length > 1) {
    let best = Infinity;
    const total = heights.reduce((s, h) => s + h, 0);
    let acc = 0;
    for (let k = 1; k < branches.length; k++) {
      acc += heights[k - 1] ?? 0;
      const diff = Math.abs(acc - (total - acc));
      if (diff < best) {
        best = diff;
        split = k;
      }
    }
  }
  const right = branches.slice(0, split);
  const leftSide = branches.slice(split).reverse();

  const centerSized = sized.get(centerNode.id);
  if (centerSized === undefined) return finish(measure, spec, { nodes: [], connectors: [], decos: [] });
  const nodes: LaidNode[] = [laidAround(centerSized, { x: 0, y: 0 }, "center")];
  const centerRect = nodes[0]?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
  const connectors: Connector[] = [];

  // A cubic S that leaves and arrives horizontally, sampled finely enough to read as a smooth line. Excalidraw's own
  // curve through a few points overshoots into loops on short, steep links. Nearly level links stay straight.
  const curve = (a: Point, b: Point): Point[] => {
    if (Math.abs(b.y - a.y) < 6) return [a, b];
    const pull = (b.x - a.x) * 0.55;
    const c1 = { x: a.x + pull, y: a.y };
    const c2 = { x: b.x - pull, y: b.y };
    const steps = 16;
    return Array.from({ length: steps + 1 }, (_, i) => {
      const t = i / steps;
      const u = 1 - t;
      return {
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      };
    });
  };

  const placeSubtree = (id: NodeId, side: 1 | -1, edgeX: number, top: number) => {
    const s = sized.get(id);
    if (s === undefined) return;
    const h = heightOf.get(id) ?? s.h;
    const cy = top + h / 2;
    const x = side === 1 ? edgeX : edgeX - s.w;
    const kids = children.get(id) ?? [];
    const node = laid(s, { x, y: cy - s.h / 2 }, (depthOf.get(id) ?? 1) >= 2 && kids.length === 0 ? "leaf" : "node");
    nodes.push(node);
    const span = kids.reduce((acc, c) => acc + (heightOf.get(c) ?? 0), 0) + V_GAP * Math.max(0, kids.length - 1);
    let y = top + (h - span) / 2;
    const nextEdge = side === 1 ? node.rect.x + node.rect.w + H_GAP : node.rect.x - H_GAP;
    for (const c of kids) {
      placeSubtree(c, side, nextEdge, y);
      const child = nodes.find((v) => v.id === c);
      if (child !== undefined) {
        const a = side === 1 ? midRight(node.rect) : midLeft(node.rect);
        const b = side === 1 ? midLeft(child.rect) : midRight(child.rect);
        connectors.push({ key: `${id}>${c}`, from: id, to: c, points: curve(a, b), curved: false, head: "none", color: node.color, label: null });
      }
      y += (heightOf.get(c) ?? 0) + V_GAP;
    }
  };

  const placeSide = (list: readonly NodeId[], side: 1 | -1) => {
    const total = list.reduce((s, b) => s + (heightOf.get(b) ?? 0), 0) + BLOCK_GAP * Math.max(0, list.length - 1);
    let y = -total / 2;
    for (const b of list) {
      const h = heightOf.get(b) ?? 0;
      const cy = y + h / 2;
      // Arms farther from the middle sit a little farther out, so the map reads as radial rather than as two lists.
      const reach = 96 + Math.abs(cy) * 0.28;
      const edgeX = side === 1 ? centerRect.x + centerRect.w + reach : centerRect.x - reach;
      placeSubtree(b, side, edgeX, y);
      const branch = nodes.find((v) => v.id === b);
      if (branch !== undefined) {
        const end = side === 1 ? midLeft(branch.rect) : midRight(branch.rect);
        const start = centerEdge(centerRect, centerSized.shape, end, side);
        connectors.push({ key: `${centerNode.id}>${b}`, from: centerNode.id, to: b, points: curve(start, end), curved: false, head: "none", color: branch.color, label: null });
      }
      y += h + BLOCK_GAP;
    }
  };
  placeSide(right, 1);
  placeSide(leftSide, -1);
  return finish(measure, spec, { nodes, connectors, decos: [] });
}

// ---- Timeline -----------------------------------------------------------------------------------

/** "Q1 2027: Beta" -> date "Q1 2027", rest "Beta". Only short prefixes count as dates. */
export function splitDate(label: string): { date: string; rest: string } | null {
  const m = /^\s*([^:\n]{1,22}?)\s*(?::|\s[-–—]\s)\s*(.+)$/s.exec(label);
  if (m === null) return null;
  const date = m[1]?.trim() ?? "";
  const rest = m[2]?.trim() ?? "";
  if (date.length === 0 || rest.length === 0 || date.split(/\s+/).length > 4) return null;
  return { date, rest };
}

function layoutTimeline(measure: Measure, spec: DiagramSpec): DiagramLayout {
  const items = spec.nodes.map((node) => {
    const parts = splitDate(node.label);
    const s = sizeNode(measure, { ...node, label: parts?.rest ?? node.label }, { size: 18, maxWidth: 150 });
    const date = parts === null ? null : textBox(measure, parts.date, SMALL_FONT, 140);
    return { s, date };
  });
  const STEM = 54;
  const SAME_SIDE_GAP = 36;
  const xs: number[] = [];
  for (const [i, it] of items.entries()) {
    if (i === 0) {
      xs.push(0);
      continue;
    }
    const prev = xs[i - 1] ?? 0;
    let x = prev + 96;
    const twoBack = items[i - 2];
    const twoBackX = xs[i - 2];
    if (twoBack !== undefined && twoBackX !== undefined) {
      const cards = (twoBack.s.w + it.s.w) / 2 + SAME_SIDE_GAP;
      const dates = ((twoBack.date?.rect.w ?? 0) + (it.date?.rect.w ?? 0)) / 2 + 24;
      x = Math.max(x, twoBackX + Math.max(cards, dates));
    }
    // Neighbours sit on opposite sides, but their dates and stems still need a little room.
    const dateNeighbour = ((items[i - 1]?.date?.rect.w ?? 0) + (it.date?.rect.w ?? 0)) / 4 + 12;
    xs.push(Math.max(x, prev + dateNeighbour));
  }

  const nodes: LaidNode[] = [];
  const connectors: Connector[] = [];
  const decos: Deco[] = [];
  for (const [i, it] of items.entries()) {
    const x = xs[i] ?? 0;
    const above = i % 2 === 0;
    const cardTop = above ? -STEM - it.s.h : STEM;
    const node = laid(it.s, { x: x - it.s.w / 2, y: cardTop });
    nodes.push(node);
    const stemFrom = above ? { x, y: cardTop + it.s.h + GAP_OUT } : { x, y: cardTop - GAP_OUT };
    connectors.push({ key: `stem-${node.id}`, from: node.id, to: null, points: [stemFrom, { x, y: above ? -9 : 9 }], curved: false, head: "none", color: node.color, label: null });
    decos.push({ kind: "dot", key: `dot-${node.id}`, rect: { x: x - 7, y: -7, w: 14, h: 14 }, color: node.color });
    if (it.date !== null) {
      const c = { x, y: above ? 14 + it.date.rect.h / 2 : -14 - it.date.rect.h / 2 };
      decos.push({ kind: "text", key: `date-${node.id}`, text: centeredAt(it.date, c), tone: "soft", align: "center" });
    }
  }
  const first = nodes[0]?.rect;
  const last = nodes[nodes.length - 1]?.rect;
  const x0 = Math.min(-40, (first?.x ?? 0) - 28);
  const x1 = Math.max((xs[xs.length - 1] ?? 0) + 60, (last === undefined ? 0 : last.x + last.w) + 36);
  decos.unshift({ kind: "line", key: "axis", points: [{ x: x0, y: 0 }, { x: x1, y: 0 }], head: "arrow", tone: "soft", width: 2, after: [] });
  return finish(measure, spec, { nodes, connectors, decos });
}

// ---- Funnel -------------------------------------------------------------------------------------

function layoutFunnel(measure: Measure, spec: DiagramSpec): DiagramLayout {
  const INSET = 38;
  const GAP = 10;
  const texts = spec.nodes.map((n) => textBox(measure, n.label, NODE_FONT, 240));
  const heights = texts.map((t) => Math.max(64, t.rect.h + 32));
  // Wide enough at the top that every stage's label still fits the narrow bottom edge of its band.
  let top = 380;
  for (const [i, t] of texts.entries()) top = Math.max(top, t.rect.w + 56 + 2 * INSET * (i + 1));
  const widthAt = (i: number) => top - 2 * INSET * i;
  const nodes: LaidNode[] = [];
  let y = 0;
  for (const [i, node] of spec.nodes.entries()) {
    const h = heights[i] ?? 64;
    const wTop = widthAt(i);
    const wBottom = widthAt(i + 1);
    const polygon = [
      { x: -wTop / 2, y },
      { x: wTop / 2, y },
      { x: wBottom / 2, y: y + h },
      { x: -wBottom / 2, y: y + h },
      { x: -wTop / 2, y },
    ];
    const rect = { x: -wTop / 2, y, w: wTop, h };
    const text = texts[i];
    if (text === undefined) continue;
    nodes.push({ id: node.id, color: node.color, shape: "band", rect, text: centeredAt(text, center(rect)), polygon, role: "node" });
    y += h + GAP;
  }
  return finish(measure, spec, { nodes, connectors: [], decos: [] });
}

// ---- Quadrant -----------------------------------------------------------------------------------

function layoutQuadrant(measure: Measure, spec: DiagramSpec): DiagramLayout {
  const cells = spec.nodes.slice(0, 4);
  const cellIds = new Set(cells.map((c) => c.id));
  const items = spec.nodes.slice(4).map((n) => sizeNode(measure, n, { size: 18, maxWidth: 140, shape: "sticky" }));
  const members: Sized[][] = [[], [], [], []];
  let rr = 0;
  for (const it of items) {
    const parent = it.node.parent;
    const target = parent !== null && cellIds.has(parent) ? cells.findIndex((c) => c.id === parent) : rr++ % Math.max(1, cells.length);
    members[target]?.push(it);
  }
  const PAD = 22;
  const ITEM_GAP = 14;
  const itemW = Math.max(0, ...items.map((s) => s.w));
  const grid = (list: readonly Sized[]) => {
    const cols = list.length <= 1 ? 1 : 2;
    const rows = Math.ceil(list.length / cols);
    const rowHeights = Array.from({ length: rows }, (_, r) => Math.max(0, ...list.slice(r * cols, r * cols + cols).map((s) => s.h)));
    return { cols, rows, rowHeights, w: cols * itemW + (cols - 1) * ITEM_GAP, h: rowHeights.reduce((s, h) => s + h, 0) + ITEM_GAP * Math.max(0, rows - 1) };
  };
  const labels = cells.map((c, i) => textBox(measure, c.label, (members[i]?.length ?? 0) > 0 ? NODE_FONT : 22, 260));
  const grids = members.map(grid);
  const cellW = Math.max(300, ...grids.map((g) => g.w + PAD * 2), ...labels.map((l) => l.rect.w + PAD * 2));
  const cellH = Math.max(
    210,
    ...grids.map((g, i) => (g.h === 0 ? (labels[i]?.rect.h ?? 0) + PAD * 4 : (labels[i]?.rect.h ?? 0) + PAD * 2 + 16 + g.h)),
  );
  const G = 30;
  const origin = (i: number): Point => ({ x: (i % 2) * (cellW + G), y: Math.floor(i / 2) * (cellH + G) });

  const nodes: LaidNode[] = [];
  const decos: Deco[] = [];
  for (const [i, cell] of cells.entries()) {
    const o = origin(i);
    const rect = { x: o.x, y: o.y, w: cellW, h: cellH };
    const list = members[i] ?? [];
    const label = labels[i];
    if (label === undefined) continue;
    const text = list.length === 0 ? centeredAt(label, center(rect)) : centeredAt(label, { x: o.x + cellW / 2, y: o.y + PAD + label.rect.h / 2 });
    nodes.push({ id: cell.id, color: cell.color, shape: "cell", rect, text, polygon: null, role: "node" });
  }
  // Items after the cells, so they stack above them.
  for (const [i, list] of members.entries()) {
    const o = origin(i);
    const g = grids[i];
    const label = labels[i];
    if (g === undefined || label === undefined || list.length === 0) continue;
    const left = o.x + (cellW - g.w) / 2;
    let y = o.y + PAD + label.rect.h + 16 + (cellH - (label.rect.h + PAD * 2 + 16) - g.h) / 2;
    for (let r = 0; r < g.rows; r++) {
      const row = list.slice(r * g.cols, r * g.cols + g.cols);
      const rowW = row.length * itemW + (row.length - 1) * ITEM_GAP;
      let x = left + (g.w - rowW) / 2;
      for (const s of row) {
        nodes.push(laid({ ...s, w: itemW }, { x, y: y + ((g.rowHeights[r] ?? s.h) - s.h) / 2 }));
        x += itemW + ITEM_GAP;
      }
      y += (g.rowHeights[r] ?? 0) + ITEM_GAP;
    }
  }
  // Blank cells when fewer than four were given, so the grid still reads as a 2x2.
  for (let i = cells.length; i < 4; i++) {
    const o = origin(i);
    decos.push({ kind: "line", key: `blank-${i}`, points: [o, { x: o.x + cellW, y: o.y }, { x: o.x + cellW, y: o.y + cellH }, { x: o.x, y: o.y + cellH }, o], head: "none", tone: "faint", width: 1, after: [] });
  }
  const W = cellW * 2 + G;
  const H = cellH * 2 + G;
  const midX = cellW + G / 2;
  const midY = cellH + G / 2;
  decos.push({ kind: "line", key: "axis-x", points: [{ x: -26, y: midY }, { x: W + 26, y: midY }], head: "arrow", tone: "soft", width: 2, after: [] });
  decos.push({ kind: "line", key: "axis-y", points: [{ x: midX, y: H + 26 }, { x: midX, y: -26 }], head: "arrow", tone: "soft", width: 2, after: [] });
  const [xLabel, yLabel] = spec.axes;
  if (xLabel !== undefined && xLabel.trim().length > 0) {
    const box = textBox(measure, xLabel, 18, 160);
    decos.push({ kind: "text", key: "axis-x-label", text: topLeftAt(box, { x: W + 38, y: midY - box.rect.h / 2 }), tone: "soft", align: "left" });
  }
  if (yLabel !== undefined && yLabel.trim().length > 0) {
    const box = textBox(measure, yLabel, 18, 220);
    decos.push({ kind: "text", key: "axis-y-label", text: centeredAt(box, { x: midX, y: -36 - box.rect.h / 2 }), tone: "soft", align: "center" });
  }
  return finish(measure, spec, { nodes, connectors: [], decos });
}

// ---- Entry point ----------------------------------------------------------------------------------

export function layoutDiagram(spec: DiagramSpec, measure: Measure): DiagramLayout {
  switch (spec.kind) {
    case "flow":
      return layoutFlow(measure, spec);
    case "cycle":
      return layoutCycle(measure, spec);
    case "tree":
      return layoutTree(measure, spec);
    case "mindmap":
      return layoutMindmap(measure, spec);
    case "timeline":
      return layoutTimeline(measure, spec);
    case "funnel":
      return layoutFunnel(measure, spec);
    case "quadrant":
      return layoutQuadrant(measure, spec);
    default: {
      const _exhaustive: never = spec.kind;
      return _exhaustive;
    }
  }
}

/** Fixed-advance estimate of the hand-drawn font, for tests and as a fallback before fonts load. */
export function estimateText(text: string, fontSize: number): { w: number; h: number } {
  const lines = text.split("\n");
  return { w: Math.max(...lines.map((l) => l.length)) * fontSize * 0.6, h: lines.length * fontSize * 1.25 };
}
