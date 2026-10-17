// Groups what the user draws by hand into sketches the agent can talk about: strokes drawn close together (in space,
// and in time when they only come near each other) become one item, and free text written on or right under them
// becomes its label. Pure, so the grouping is unit-tested; bridge.ts stores the result in each element's customData.
import { z } from "zod";
import type { NodeId } from "../../shared/board";
import { NodeId as NodeIdSchema } from "../../shared/board";
import type { Rect } from "./geometry";
import { center, contains, inflate, overlaps } from "./geometry";

/** Strokes this close always belong together: one touches or crosses the other. */
const TOUCH = 12;
/** Strokes this close belong together when drawn within STROKE_WINDOW_MS of each other. */
const NEAR = 64;
const STROKE_WINDOW_MS = 15_000;
/** Text whose center sits within this distance of a sketch labels it. */
const LABEL_REACH = 40;

/**
 * One user element that may belong to a sketch. `stroke` is anything drawn: freehand, lines, loose arrows,
 * unlabelled boxes. `text` is free text that may label a sketch. `sketch` is the id it carried last time.
 */
export type SketchPart = { id: string; kind: "stroke" | "text"; rect: Rect; updated: number; sketch: NodeId | null };

export type SketchGroup = { id: NodeId; members: string[]; strokes: string[]; texts: string[]; rect: Rect };

const SketchData = z.object({ rtwSketch: NodeIdSchema });

/** The sketch id stored on an element, if any. customData is untyped scene data, so it is parsed. */
export function sketchIdOf(element: { readonly customData?: unknown }): NodeId | null {
  const parsed = SketchData.safeParse(element.customData);
  return parsed.success ? parsed.data.rtwSketch : null;
}

/** customData with the sketch id set, or removed when `id` is null. Other keys are kept. */
export function withSketchId(customData: Record<string, unknown> | undefined, id: NodeId | null): Record<string, unknown> | undefined {
  const { rtwSketch: _dropped, ...rest } = customData ?? {};
  if (id !== null) return { ...rest, rtwSketch: id };
  return Object.keys(rest).length === 0 ? undefined : rest;
}

function unionRect(rects: readonly Rect[]): Rect {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function joined(a: SketchPart, b: SketchPart): boolean {
  if (overlaps(inflate(a.rect, TOUCH), b.rect)) return true;
  return overlaps(inflate(a.rect, NEAR), b.rect) && Math.abs(a.updated - b.updated) <= STROKE_WINDOW_MS;
}

/**
 * Groups parts into sketches and gives each a stable id: the id most of its members already carry, unless a bigger
 * group claimed it first; otherwise a fresh one from `makeId`. Text that labels no sketch is left out.
 */
export function groupSketches(args: { parts: readonly SketchPart[]; makeId: () => NodeId }): SketchGroup[] {
  const strokes = args.parts.filter((p) => p.kind === "stroke");
  const texts = args.parts.filter((p) => p.kind === "text");

  // Union-find over strokes.
  const parent = strokes.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    parent[i] = r;
    return r;
  };
  for (let i = 0; i < strokes.length; i++) {
    for (let j = i + 1; j < strokes.length; j++) {
      const a = strokes[i];
      const b = strokes[j];
      if (a !== undefined && b !== undefined && joined(a, b)) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, SketchPart[]>();
  for (const [i, part] of strokes.entries()) {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), part]);
  }

  type Draft = { strokes: SketchPart[]; texts: SketchPart[]; rect: Rect };
  const drafts: Draft[] = [...clusters.values()].map((members) => ({ strokes: members, texts: [], rect: unionRect(members.map((m) => m.rect)) }));
  for (const text of texts) {
    const c = center(text.rect);
    const host = drafts
      .filter((d) => contains(inflate(d.rect, LABEL_REACH), { x: c.x, y: c.y, w: 0, h: 0 }))
      .sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)[0];
    host?.texts.push(text);
  }

  // Bigger groups pick their id first, so a split keeps the old id on the larger half.
  drafts.sort((a, b) => b.strokes.length - a.strokes.length || a.rect.x - b.rect.x || a.rect.y - b.rect.y);
  const claimed = new Set<NodeId>();
  return drafts.map((draft) => {
    const counts = new Map<NodeId, number>();
    for (const part of [...draft.strokes, ...draft.texts]) if (part.sketch !== null) counts.set(part.sketch, (counts.get(part.sketch) ?? 0) + 1);
    const reuse = [...counts.entries()]
      .filter(([id]) => !claimed.has(id))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    let id = reuse;
    while (id === undefined || claimed.has(id)) id = args.makeId();
    claimed.add(id);
    const members = [...draft.strokes, ...draft.texts];
    return {
      id,
      members: members.map((m) => m.id),
      strokes: draft.strokes.map((m) => m.id),
      texts: draft.texts.map((m) => m.id),
      rect: unionRect(members.map((m) => m.rect)),
    };
  });
}
