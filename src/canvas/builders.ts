// Builds Excalidraw elements for one agent node at the origin. The bridge measures the result, picks a
// position with the layout engine, then translates every element of the node there.
import { convertToExcalidrawElements, ROUNDNESS } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawArrowElement, ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { Color, MockupComponent, ShapeKind } from "../../shared/board";
import type { NodeMeta } from "./meta";
import { metaData } from "./meta";
import {
  ACCENT,
  ACCENT_FILL,
  HAND_FONT,
  INK,
  INK_FAINT,
  INK_SOFT,
  ROUGHNESS,
  STICKY_FILL,
  SWATCHES,
  WIRE,
  WIRE_FILL,
} from "./palette";

export type Built = {
  elements: ExcalidrawElement[];
  /** Element that edges bind to and that represents the node's outline. */
  rootId: string;
};

export type IdFactory = (part: string) => string;

const ADAPTIVE = { type: ROUNDNESS.ADAPTIVE_RADIUS };

/** Rough Excalifont advance per character as a fraction of font size; good enough to size containers. */
const CHAR_WIDTH = 0.56;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Greedy word wrap for free text, which Excalidraw does not wrap on its own. */
export function wrap(text: string, maxChars: number): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= maxChars) line = `${line} ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function finish(skeletons: ExcalidrawElementSkeleton[], meta: (id: string) => NodeMeta, groupIds: string[] = []): ExcalidrawElement[] {
  return convertToExcalidrawElements(skeletons, { regenerateIds: false }).map((el) => ({
    ...el,
    groupIds: [...groupIds, ...el.groupIds],
    customData: metaData(meta(el.id)),
  }));
}

export function buildShape(args: { nodeId: string; id: IdFactory; shape: ShapeKind; label: string; color: Color }): Built {
  const { nodeId, id, shape, label, color } = args;
  const swatch = SWATCHES[color];
  const rootId = id("root");
  const meta = (elId: string): NodeMeta => ({ kind: "shape", nodeId, role: elId === rootId ? "root" : "part", shape, color });
  // A notch above Excalidraw's default so labels stay legible when a full board is fit to the screen.
  const fontSize = 22;
  const textWidth = label.length * fontSize * CHAR_WIDTH;
  const base = {
    id: rootId,
    x: 0,
    y: 0,
    strokeColor: swatch.stroke,
    backgroundColor: swatch.fill,
    fillStyle: "solid" as const,
    strokeWidth: 2,
    roughness: ROUGHNESS,
  };
  const textLabel = { text: label, fontSize, fontFamily: HAND_FONT, strokeColor: INK };

  switch (shape) {
    case "box":
      return {
        rootId,
        elements: finish(
          [{ ...base, type: "rectangle", width: clamp(textWidth + 56, 170, 300), height: 80, roundness: ADAPTIVE, label: textLabel }],
          meta,
        ),
      };
    case "ellipse":
      return {
        rootId,
        elements: finish(
          [{ ...base, type: "ellipse", width: clamp(textWidth * 0.8 + 96, 180, 300), height: 100, label: textLabel }],
          meta,
        ),
      };
    case "diamond":
      return {
        rootId,
        elements: finish(
          [{ ...base, type: "diamond", width: clamp(textWidth * 0.7 + 120, 200, 320), height: 140, label: textLabel }],
          meta,
        ),
      };
    case "sticky":
      return {
        rootId,
        elements: finish(
          [
            {
              ...base,
              type: "rectangle",
              width: 200,
              height: 200,
              strokeColor: swatch.stroke,
              strokeWidth: 1,
              backgroundColor: STICKY_FILL[color],
              roundness: null,
              label: { ...textLabel, fontSize: 20 },
            },
          ],
          meta,
        ),
      };
    case "text":
      return {
        rootId,
        elements: finish(
          [{ id: rootId, type: "text", x: 0, y: 0, text: wrap(label, 36), fontSize: 28, fontFamily: HAND_FONT, strokeColor: INK }],
          meta,
        ),
      };
    default: {
      const _exhaustive: never = shape;
      return _exhaustive;
    }
  }
}

/**
 * Frames start dormant: invisible, locked and unnamed (the title waits in customData) so an empty box never sits on
 * the board. The bridge wakes the frame when its first child lands. It still reserves its space, so waking it moves
 * nothing.
 */
/** Name a dormant frame carries: invisible, but not empty, since Excalidraw shows "Frame" for a missing name. */
export const DORMANT_FRAME_NAME = "\u200b";

export function buildFrame(args: { nodeId: string; id: IdFactory; title: string }): Built {
  const rootId = args.id("root");
  const elements = finish(
    [{ id: rootId, type: "frame", children: [], x: 0, y: 0, width: 440, height: 260 }],
    () => ({ kind: "frame", nodeId: args.nodeId, role: "root", title: args.title }),
  ).map((el) => (el.type === "frame" ? { ...el, name: DORMANT_FRAME_NAME, opacity: 0, locked: true } : el));
  return { rootId, elements };
}

export function buildPending(args: { pendingId: string; id: IdFactory; label: string }): Built {
  const rootId = args.id("root");
  const elements = finish(
    [
      {
        id: rootId,
        type: "rectangle",
        x: 0,
        y: 0,
        width: 300,
        height: 300,
        strokeColor: INK_FAINT,
        backgroundColor: "#f8f9fa",
        fillStyle: "solid",
        strokeStyle: "dashed",
        strokeWidth: 2,
        roughness: ROUGHNESS,
        roundness: ADAPTIVE,
        label: { text: args.label, fontSize: 18, fontFamily: HAND_FONT, strokeColor: INK_SOFT },
      },
    ],
    (elId) => ({ kind: "pending", pendingId: args.pendingId, role: elId === rootId ? "root" : "part" }),
  );
  return { rootId, elements };
}

export function buildImage(args: { nodeId: string; id: IdFactory; fileId: FileId; caption: string; width: number; height: number }): Built {
  const rootId = args.id("root");
  const skeletons: ExcalidrawElementSkeleton[] = [
    { id: rootId, type: "image", x: 0, y: 0, width: args.width, height: args.height, fileId: args.fileId, status: "saved" },
  ];
  if (args.caption.trim().length > 0) {
    skeletons.push({
      id: args.id("caption"),
      type: "text",
      x: 0,
      y: args.height + 12,
      text: wrap(args.caption, 34),
      fontSize: 16,
      fontFamily: HAND_FONT,
      strokeColor: INK_SOFT,
      textAlign: "left",
    });
  }
  const elements = finish(skeletons, (elId) => ({ kind: "image", nodeId: args.nodeId, role: elId === rootId ? "root" : "part" }), [args.id("group")]);
  return { rootId, elements };
}

/** Arrow from (x, y) by (dx, dy). Bindings are attached by the bridge, which knows the endpoint elements. */
export function buildArrow(args: {
  nodeId: string;
  id: IdFactory;
  from: string;
  to: string;
  label: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
}): Built {
  const rootId = args.id("root");
  const skeleton: ExcalidrawElementSkeleton = {
    id: rootId,
    type: "arrow",
    x: args.x,
    y: args.y,
    width: nonZero(args.dx),
    height: nonZero(args.dy),
    strokeColor: INK_SOFT,
    strokeWidth: 2,
    roughness: ROUGHNESS,
    endArrowhead: "arrow",
    ...(args.label.trim().length > 0
      ? { label: { text: wrap(args.label.trim(), 18), fontSize: 17, fontFamily: HAND_FONT, strokeColor: INK_SOFT } }
      : {}),
  };
  const elements = finish([skeleton], (elId) => ({
    kind: "edge",
    nodeId: args.nodeId,
    role: elId === rootId ? "root" : "part",
    from: args.from,
    to: args.to,
  }));
  return { rootId, elements };
}

type LocalPoint = ExcalidrawArrowElement["points"][number];

/** Excalidraw's point brand is nominal; this is the one place plain numbers become a LocalPoint, as in its own pointFrom. */
function localPoint(x: number, y: number): LocalPoint {
  return [x, y] as LocalPoint;
}

/**
 * Arrow geometry from (x, y) by (dx, dy), optionally curving through `bend` (relative to the start) so it clears
 * whatever sits on the straight line.
 */
export function arrowGeometry(args: { x: number; y: number; dx: number; dy: number; bend: { x: number; y: number } | null }) {
  const end = localPoint(nonZero(args.dx), nonZero(args.dy));
  const points = args.bend === null ? [localPoint(0, 0), end] : [localPoint(0, 0), localPoint(args.bend.x, args.bend.y), end];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: args.x,
    y: args.y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points,
    roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
  };
}

function nonZero(value: number): number {
  return Math.abs(value) < 0.5 ? 0.5 : value;
}

// ---------------------------------------------------------------------------------------------
// Mockups: a device outline with wireframe components stacked inside, all in one group.

type Device = "phone" | "desktop";
type Cursor = { skeletons: ExcalidrawElementSkeleton[]; y: number };

const DEVICE = {
  phone: { width: 300, minHeight: 560, pad: 16, top: 44, gap: 14, imageHeight: 130 },
  desktop: { width: 720, minHeight: 450, pad: 24, top: 52, gap: 16, imageHeight: 170 },
} as const;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function buildMockup(args: { nodeId: string; id: IdFactory; title: string; device: Device; components: readonly MockupComponent[] }): Built {
  const { nodeId, id, title, device, components } = args;
  const spec = DEVICE[device];
  const rootId = id("root");
  const left = spec.pad;
  const width = spec.width - spec.pad * 2;
  const cursor: Cursor = { skeletons: [], y: spec.top };
  let partSeq = 0;
  const part = (): string => id(`p${partSeq++}`);

  const wire = { strokeColor: WIRE, strokeWidth: 1, roughness: ROUGHNESS, fillStyle: "solid" as const };
  const text = (args: { x: number; y: number; text: string; size?: number; color?: string; align?: "left" | "center" }) =>
    cursor.skeletons.push({
      id: part(),
      type: "text",
      x: args.x,
      y: args.y,
      text: args.text,
      fontSize: args.size ?? 16,
      fontFamily: HAND_FONT,
      strokeColor: args.color ?? INK,
      textAlign: args.align ?? "left",
    });
  const line = (x: number, y: number, w: number) =>
    cursor.skeletons.push({ id: part(), type: "line", x, y, width: w, height: 0, strokeColor: INK_FAINT, strokeWidth: 2, roughness: ROUGHNESS });
  const rect = (args: { x: number; y: number; w: number; h: number; fill?: string; stroke?: string; round?: boolean; label?: string; labelColor?: string }) =>
    cursor.skeletons.push({
      ...wire,
      id: part(),
      type: "rectangle",
      x: args.x,
      y: args.y,
      width: args.w,
      height: args.h,
      backgroundColor: args.fill ?? "#ffffff",
      strokeColor: args.stroke ?? WIRE,
      roundness: args.round === false ? null : ADAPTIVE,
      ...(args.label !== undefined
        ? { label: { text: args.label, fontSize: 16, fontFamily: HAND_FONT, strokeColor: args.labelColor ?? INK } }
        : {}),
    });
  const circle = (x: number, y: number, d: number, fill: string = WIRE_FILL, stroke: string = WIRE) =>
    cursor.skeletons.push({ ...wire, id: part(), type: "ellipse", x, y, width: d, height: d, backgroundColor: fill, strokeColor: stroke });

  const maxChars = Math.floor(width / (16 * CHAR_WIDTH));
  let tabbar: MockupComponent | null = null;

  for (const component of components) {
    const y = cursor.y;
    const label = component.label;
    switch (component.kind) {
      case "header": {
        rect({ x: left, y, w: width, h: 44, fill: WIRE_FILL });
        text({ x: left + 14, y: y + 11, text: label.slice(0, maxChars - 4), size: 18 });
        circle(left + width - 36, y + 10, 24, "#ffffff");
        cursor.y += 44;
        break;
      }
      case "text": {
        const body = wrap(label, maxChars);
        const lines = body.split("\n").length;
        text({ x: left, y, text: body });
        const below = y + lines * 20 + 10;
        line(left, below, width * 0.85);
        line(left, below + 14, width * 0.55);
        cursor.y = below + 16;
        break;
      }
      case "button": {
        rect({ x: left, y, w: width, h: 44, fill: ACCENT_FILL, stroke: ACCENT, label: label.slice(0, maxChars), labelColor: ACCENT });
        cursor.y += 44;
        break;
      }
      case "input": {
        rect({ x: left, y, w: width, h: 40 });
        text({ x: left + 12, y: y + 10, text: label.slice(0, maxChars - 2), color: INK_FAINT });
        cursor.y += 40;
        break;
      }
      case "image": {
        const h = spec.imageHeight;
        rect({ x: left, y, w: width, h, fill: WIRE_FILL, round: false });
        cursor.skeletons.push({ id: part(), type: "line", x: left, y, width, height: h, strokeColor: INK_FAINT, strokeWidth: 1, roughness: ROUGHNESS });
        cursor.skeletons.push({ id: part(), type: "line", x: left, y: y + h, width, height: -h, strokeColor: INK_FAINT, strokeWidth: 1, roughness: ROUGHNESS });
        cursor.y += h;
        if (label.trim().length > 0) {
          text({ x: left, y: cursor.y + 6, text: label.slice(0, maxChars), size: 14, color: INK_SOFT });
          cursor.y += 26;
        }
        break;
      }
      case "card": {
        rect({ x: left, y, w: width, h: 88 });
        rect({ x: left + 12, y: y + 12, w: 64, h: 64, fill: WIRE_FILL });
        text({ x: left + 90, y: y + 14, text: label.slice(0, maxChars - 8) });
        line(left + 90, y + 50, (width - 110) * 0.9);
        line(left + 90, y + 64, (width - 110) * 0.55);
        cursor.y += 88;
        break;
      }
      case "list": {
        const items = label.split(/\s*[,;·|]\s*/).filter(Boolean);
        const rows = items.length > 1 ? items.slice(0, 4) : [label, "", ""];
        for (const [index, row] of rows.entries()) {
          const ry = cursor.y + index * 44;
          circle(left, ry + 8, 26);
          if (row.length > 0) text({ x: left + 38, y: ry + 10, text: row.slice(0, maxChars - 4) });
          else line(left + 38, ry + 21, width * (index % 2 === 0 ? 0.55 : 0.4));
          if (index < rows.length - 1) line(left, ry + 42, width);
        }
        cursor.y += rows.length * 44 - 2;
        break;
      }
      case "tabbar": {
        tabbar = component;
        continue;
      }
      case "toggle": {
        text({ x: left, y: y + 9, text: label.slice(0, maxChars - 6) });
        cursor.skeletons.push({
          ...wire,
          id: part(),
          type: "rectangle",
          x: left + width - 48,
          y: y + 6,
          width: 48,
          height: 28,
          backgroundColor: ACCENT_FILL,
          strokeColor: ACCENT,
          roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS, value: 14 },
        });
        circle(left + width - 26, y + 9, 22, "#ffffff", ACCENT);
        cursor.y += 40;
        break;
      }
      case "avatar": {
        circle(left, y, 56);
        text({ x: left + 72, y: y + 8, text: label.slice(0, maxChars - 6), size: 18 });
        line(left + 72, y + 42, width * 0.4);
        cursor.y += 56;
        break;
      }
      case "chart": {
        const h = 150;
        rect({ x: left, y, w: width, h });
        text({ x: left + 12, y: y + 10, text: label.slice(0, maxChars - 2), size: 14, color: INK_SOFT });
        const bars = 6;
        const slot = (width - 24) / bars;
        const seed = hash(label);
        for (let i = 0; i < bars; i++) {
          const bh = 24 + ((seed >>> (i * 4)) % 9) * 9;
          cursor.skeletons.push({
            ...wire,
            id: part(),
            type: "rectangle",
            x: left + 12 + i * slot + slot * 0.2,
            y: y + h - 14 - bh,
            width: slot * 0.6,
            height: bh,
            backgroundColor: i === bars - 1 ? ACCENT : ACCENT_FILL,
            strokeColor: ACCENT,
            roundness: null,
          });
        }
        line(left + 12, y + h - 14, width - 24);
        cursor.y += h;
        break;
      }
      default: {
        const _exhaustive: never = component.kind;
        return _exhaustive;
      }
    }
    cursor.y += spec.gap;
  }

  const tabbarHeight = tabbar === null ? 0 : 60;
  const height = Math.max(spec.minHeight, cursor.y + spec.pad + tabbarHeight);

  if (tabbar !== null) {
    const ty = height - tabbarHeight;
    line(0, ty, spec.width);
    const names = tabbar.label.split(/\s*[,;·|/]\s*/).filter(Boolean).slice(0, 5);
    const tabs = names.length > 1 ? names : ["Home", "Explore", "Stats", "Profile"];
    const slot = spec.width / tabs.length;
    for (const [index, name] of tabs.entries()) {
      const cx = slot * index + slot / 2;
      cursor.skeletons.push({
        ...wire,
        id: part(),
        type: "rectangle",
        x: cx - 11,
        y: ty + 10,
        width: 22,
        height: 22,
        backgroundColor: index === 0 ? ACCENT_FILL : "#ffffff",
        strokeColor: index === 0 ? ACCENT : WIRE,
        roundness: ADAPTIVE,
      });
      text({ x: cx, y: ty + 36, text: name.slice(0, 10), size: 12, color: index === 0 ? ACCENT : INK_SOFT, align: "center" });
    }
  }

  const chrome: ExcalidrawElementSkeleton[] = [
    {
      id: rootId,
      type: "rectangle",
      x: 0,
      y: 0,
      width: spec.width,
      height,
      strokeColor: INK,
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: ROUGHNESS,
      roundness: device === "phone" ? { type: ROUNDNESS.ADAPTIVE_RADIUS, value: 36 } : { type: ROUNDNESS.ADAPTIVE_RADIUS, value: 14 },
    },
    { id: id("title"), type: "text", x: 0, y: -34, text: title, fontSize: 20, fontFamily: HAND_FONT, strokeColor: INK },
  ];
  if (device === "phone") {
    chrome.push({
      ...wire,
      id: id("notch"),
      type: "rectangle",
      x: spec.width / 2 - 36,
      y: 14,
      width: 72,
      height: 12,
      backgroundColor: INK,
      strokeColor: INK,
      roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS, value: 6 },
    });
  } else {
    for (const [index, fill] of ["#ff8787", "#ffd43b", "#69db7c"].entries()) {
      chrome.push({ ...wire, id: id(`dot${index}`), type: "ellipse", x: 16 + index * 18, y: 16, width: 11, height: 11, backgroundColor: fill, strokeColor: WIRE });
    }
    chrome.push({ id: id("chrome-line"), type: "line", x: 0, y: 40, width: spec.width, height: 0, strokeColor: WIRE, strokeWidth: 1, roughness: ROUGHNESS });
  }

  const elements = finish(
    [...chrome, ...cursor.skeletons],
    (elId) => ({ kind: "mockup", nodeId, role: elId === rootId ? "root" : "part" }),
    [id("group")],
  );
  return { rootId, elements };
}
