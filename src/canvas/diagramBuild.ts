// Turns a DiagramLayout into Excalidraw elements. Every element id is chosen by the caller, so a re-layout can reuse
// ids: surviving nodes and connectors then glide to their new spots instead of being redrawn, and arrows bound to a
// node from outside the diagram stay attached.
import { convertToExcalidrawElements, ROUNDNESS } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { NodeId } from "../../shared/board";
import { localPoint } from "./builders";
import type { DiagramLayout, LaidNode, Measure, TextBox, Tone } from "./diagramLayout";
import { estimateText, splitDate } from "./diagramLayout";
import type { DiagramSpec } from "./diagramLayout";
import type { Point } from "./geometry";
import type { NodeMeta } from "./meta";
import { metaData } from "./meta";
import { HAND_FONT, INK, INK_FAINT, INK_SOFT, ROUGHNESS, STICKY_FILL, SWATCHES } from "./palette";

export type DiagramIds = {
  /** Element id for a diagram-level part: "title", "axis", a connector key. */
  part(key: string): string;
  /** Element ids for a node's outline and its label. */
  member(id: NodeId): { root: string; text: string };
};

/** Element ids of one built diagram, in the order they should appear. */
export type EntryStep = { elementIds: string[]; kind: "fade" | "draw"; after: NodeId[]; node: NodeId | null };

export type BuiltDiagram = {
  elements: ExcalidrawElement[];
  /** Root element per node, for binding arrows and outlining. */
  roots: Map<NodeId, string>;
  /** Entry choreography: decoration first, then nodes in order, connectors once both ends are visible. */
  steps: EntryStep[];
};

const TONE: Record<Tone, string> = { ink: INK, soft: INK_SOFT, faint: INK_FAINT };

/** Measures text exactly as Excalidraw will render it, by letting it build a throwaway text element. */
export function excalidrawMeasure(): Measure {
  const cache = new Map<string, { w: number; h: number }>();
  return (text, fontSize) => {
    const key = `${fontSize}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const [el] = convertToExcalidrawElements([{ type: "text", x: 0, y: 0, text, fontSize, fontFamily: HAND_FONT }]);
    const size = el === undefined || el.width === 0 ? estimateText(text, fontSize) : { w: Math.ceil(el.width), h: Math.ceil(el.height) };
    cache.set(key, size);
    return size;
  };
}

function relative(points: readonly Point[]) {
  const [first] = points;
  const origin = first ?? { x: 0, y: 0 };
  const local = points.map((p) => localPoint(p.x - origin.x, p.y - origin.y));
  const xs = local.map((p) => p[0]);
  const ys = local.map((p) => p[1]);
  return { x: origin.x, y: origin.y, points: local, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Excalidraw anchors a skeleton text's x at its alignment edge: the center for centered text, the right for right. */
function textSkeleton(id: string, box: TextBox, color: string, align: "left" | "center" | "right"): ExcalidrawElementSkeleton {
  const x = align === "center" ? box.rect.x + box.rect.w / 2 : align === "right" ? box.rect.x + box.rect.w : box.rect.x;
  return { id, type: "text", x, y: box.rect.y, text: box.text, fontSize: box.size, fontFamily: HAND_FONT, strokeColor: color, textAlign: align };
}

/** The text a node shows, which for timeline cards drops the date that moved onto the axis. */
export function shownLabel(kind: DiagramSpec["kind"], label: string): string {
  return kind === "timeline" ? (splitDate(label)?.rest ?? label) : label;
}

export function buildDiagram(args: { diagramId: NodeId; stamp: string; spec: DiagramSpec; layout: DiagramLayout; ids: DiagramIds; groupId: string }): BuiltDiagram {
  const { diagramId, spec, layout, ids, stamp } = args;
  const skeletons: ExcalidrawElementSkeleton[] = [];
  const metas = new Map<string, NodeMeta>();
  const part = (key: string): string => {
    const id = ids.part(key);
    metas.set(id, { kind: "diagram", nodeId: diagramId, role: "part", stamp });
    return id;
  };
  const steps: EntryStep[] = [];
  const roots = new Map<NodeId, string>();
  const specOf = new Map(spec.nodes.map((n) => [n.id, n]));

  // Title: the diagram's root, carrying the spec for later re-layouts.
  const titleId = ids.part("title");
  metas.set(titleId, { kind: "diagram", nodeId: diagramId, role: "root", stamp, spec: { ...spec, nodes: [...spec.nodes], links: [...spec.links], axes: [...spec.axes] } });
  skeletons.push(textSkeleton(titleId, layout.title, layout.title.inside ? INK_SOFT : INK, layout.title.inside ? "center" : "left"));
  steps.push({ elementIds: [titleId], kind: "fade", after: [], node: null });

  // Decoration: axes and blank cells draw first, dots and dates arrive with their node.
  const lateDecos = new Map<NodeId, string[]>();
  for (const deco of layout.decos) {
    switch (deco.kind) {
      case "line": {
        const id = part(deco.key);
        const geo = relative(deco.points);
        skeletons.push({
          id,
          type: deco.head === "arrow" ? "arrow" : "line",
          ...geo,
          strokeColor: TONE[deco.tone],
          strokeWidth: deco.width,
          roughness: ROUGHNESS,
          ...(deco.head === "arrow" ? { endArrowhead: "arrow" as const, startArrowhead: null } : {}),
        });
        steps.push({ elementIds: [id], kind: "draw", after: deco.after, node: null });
        break;
      }
      case "dot": {
        const id = part(deco.key);
        const swatch = SWATCHES[deco.color];
        skeletons.push({ id, type: "ellipse", x: deco.rect.x, y: deco.rect.y, width: deco.rect.w, height: deco.rect.h, strokeColor: swatch.stroke, backgroundColor: swatch.stroke, fillStyle: "solid", strokeWidth: 1, roughness: 0 });
        const owner = deco.key.replace(/^dot-/, "");
        lateDecos.set(owner, [...(lateDecos.get(owner) ?? []), id]);
        break;
      }
      case "text": {
        const id = part(deco.key);
        skeletons.push(textSkeleton(id, deco.text, TONE[deco.tone], deco.align));
        const owner = deco.key.startsWith("date-") ? deco.key.slice(5) : null;
        if (owner !== null) lateDecos.set(owner, [...(lateDecos.get(owner) ?? []), id]);
        else steps.push({ elementIds: [id], kind: "fade", after: [], node: null });
        break;
      }
      default: {
        const _exhaustive: never = deco;
        return _exhaustive;
      }
    }
  }

  // Cells first so their items stack above them; then everything else in the agent's order.
  const nodes = [...layout.nodes].sort((a, b) => Number(b.shape === "cell") - Number(a.shape === "cell"));
  const nodeSkeletons: ExcalidrawElementSkeleton[] = [];
  for (const node of nodes) {
    const given = specOf.get(node.id);
    const { root, text } = ids.member(node.id);
    roots.set(node.id, root);
    const label = given?.label ?? node.text.text;
    const meta = (role: "root" | "part"): NodeMeta => ({
      kind: "member",
      nodeId: node.id,
      role,
      diagram: diagramId,
      shape: node.shape,
      color: node.color,
      label,
      shown: shownLabel(spec.kind, label),
    });
    metas.set(root, meta("root"));
    metas.set(text, meta("part"));
    nodeSkeletons.push(...nodeElements(node, root, text));
    steps.push({ elementIds: [root, text, ...(lateDecos.get(node.id) ?? [])], kind: "fade", after: [], node: node.id });
  }

  const connectorSkeletons: ExcalidrawElementSkeleton[] = [];
  for (const c of layout.connectors) {
    const id = part(`c:${c.key}`);
    const geo = relative(c.points);
    const stroke = c.color === null ? INK_SOFT : SWATCHES[c.color].stroke;
    connectorSkeletons.push({
      id,
      type: "arrow",
      ...geo,
      strokeColor: stroke,
      strokeWidth: 2,
      roughness: ROUGHNESS,
      startArrowhead: null,
      endArrowhead: c.head === "arrow" ? "arrow" : null,
    });
    const ids2 = [id];
    if (c.label !== null) {
      const labelId = part(`l:${c.key}`);
      connectorSkeletons.push(textSkeleton(labelId, c.label, INK_SOFT, "left"));
      ids2.push(labelId);
    }
    steps.push({ elementIds: ids2, kind: "draw", after: [c.from, c.to].filter((v): v is NodeId => v !== null), node: null });
  }

  // Connectors sit under nodes, so a curve that grazes a shape never hides its label.
  const all = [...skeletons, ...connectorSkeletons, ...nodeSkeletons];
  const converted = convertToExcalidrawElements(all, { regenerateIds: false });
  const curvedKeys = new Set(layout.connectors.filter((c) => c.curved).map((c) => ids.part(`c:${c.key}`)));
  const ends = new Map(layout.connectors.map((c) => [ids.part(`c:${c.key}`), c]));
  const bindable = new Set(layout.nodes.filter((n) => n.shape !== "band").map((n) => n.id));

  const ownerOfRoot = new Map([...roots.entries()].map(([nodeId, rootId]) => [rootId, nodeId]));
  const elements = converted.map((el): ExcalidrawElement => {
    let next: ExcalidrawElement = el;
    // Bound labels get the caller's text id, so they can glide with their shape on the next re-layout.
    const container = el.type === "text" && el.containerId !== null ? ownerOfRoot.get(el.containerId) : undefined;
    if (container !== undefined) next = { ...el, id: ids.member(container).text };
    const owner = ownerOfRoot.get(el.id);
    if (owner !== undefined && el.boundElements !== null) {
      next = { ...el, boundElements: el.boundElements.map((b) => (b.type === "text" ? { ...b, id: ids.member(owner).text } : b)) };
    }
    if (next.type === "arrow") {
      const c = ends.get(next.id);
      const bind = (node: NodeId | null) => {
        const elementId = node === null || !bindable.has(node) ? undefined : roots.get(node);
        return elementId === undefined ? null : { elementId, focus: 0, gap: 8 };
      };
      next = {
        ...next,
        roundness: curvedKeys.has(next.id) ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null,
        startBinding: c === undefined ? null : bind(c.from),
        endBinding: c === undefined ? null : bind(c.to),
      };
    }
    const meta = metas.get(next.id);
    return { ...next, groupIds: [args.groupId], customData: meta === undefined ? next.customData : metaData(meta) };
  });
  return { elements, roots, steps };
}

function nodeElements(node: LaidNode, rootId: string, textId: string): ExcalidrawElementSkeleton[] {
  const swatch = SWATCHES[node.color];
  const { rect } = node;
  const base = {
    id: rootId,
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
    strokeColor: swatch.stroke,
    backgroundColor: swatch.fill,
    fillStyle: "solid" as const,
    strokeWidth: 2,
    roughness: ROUGHNESS,
  };
  const label = { text: node.text.text, fontSize: node.text.size, fontFamily: HAND_FONT, strokeColor: INK };
  switch (node.shape) {
    case "box":
      return [{ ...base, type: "rectangle", roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS }, label }];
    case "ellipse":
      return [{ ...base, type: "ellipse", strokeWidth: node.role === "center" ? 3 : 2, label }];
    case "diamond":
      return [{ ...base, type: "diamond", label }];
    case "sticky":
      return [{ ...base, type: "rectangle", strokeWidth: 1, backgroundColor: STICKY_FILL[node.color], roundness: null, label }];
    case "cell":
      return [
        { ...base, type: "rectangle", strokeWidth: 1, roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS } },
        textSkeleton(textId, node.text, swatch.stroke, "center"),
      ];
    case "band": {
      const geo = relative(node.polygon ?? []);
      return [
        { ...base, type: "line", ...geo, roundness: null },
        textSkeleton(textId, node.text, INK, "center"),
      ];
    }
    default: {
      const _exhaustive: never = node.shape;
      return _exhaustive;
    }
  }
}
