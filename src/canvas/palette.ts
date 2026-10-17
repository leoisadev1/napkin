// Visual vocabulary for agent-drawn elements: soft solid fills, hand-drawn strokes, one ink color for text.
import { FONT_FAMILY } from "@excalidraw/excalidraw";
import type { Color } from "../../shared/board";

export type Swatch = { stroke: string; fill: string };

/** Open Color tones: stroke from the 7-8 range, fill from the 1 range, so shapes read as tinted paper. */
export const SWATCHES: Record<Color, Swatch> = {
  gray: { stroke: "#495057", fill: "#f1f3f5" },
  blue: { stroke: "#1971c2", fill: "#dbeafe" },
  green: { stroke: "#2b8a3e", fill: "#d3f9d8" },
  yellow: { stroke: "#c27c0e", fill: "#fff3bf" },
  orange: { stroke: "#d9480f", fill: "#ffe8cc" },
  red: { stroke: "#c92a2a", fill: "#ffe3e3" },
  purple: { stroke: "#6741d9", fill: "#e5dbff" },
  pink: { stroke: "#c2255c", fill: "#ffdeeb" },
  teal: { stroke: "#0c8599", fill: "#c5f6fa" },
};

/** Sticky notes use a warmer, more saturated paper than ordinary boxes. */
export const STICKY_FILL: Record<Color, string> = {
  gray: "#e9ecef",
  blue: "#c5dcfb",
  green: "#c0f0c8",
  yellow: "#ffec99",
  orange: "#ffd8a8",
  red: "#ffc9c9",
  purple: "#d6c8ff",
  pink: "#fcc2d7",
  teal: "#a8ecf2",
};

export const INK = "#1e1e1e";
export const INK_SOFT = "#495057";
export const INK_FAINT = "#adb5bd";
export const WIRE = "#868e96";
export const WIRE_FILL = "#f1f3f5";
export const ACCENT = "#1971c2";
export const ACCENT_FILL = "#dbeafe";

export const HAND_FONT = FONT_FAMILY.Excalifont;
export const UI_FONT = FONT_FAMILY.Nunito;

export const ROUGHNESS = 1;
