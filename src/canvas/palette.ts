// Visual vocabulary for board elements: crisp hairline strokes, quiet tinted fills, one cool ink for text, and a clean
// sans (Inter). Tones follow Linear's label colors, softened so a full board stays calm. In dark mode Excalidraw inverts
// the canvas (invert 93%, hue-rotate 180deg), so these light values become dark tinted fills with lighter strokes.
import { FONT_FAMILY } from "@excalidraw/excalidraw";
import type { Color } from "../../shared/board";

export type Swatch = { stroke: string; fill: string };

/** Stroke at mid lightness, fill a whisper of the same hue, so shapes read as tinted cards rather than paper. */
export const SWATCHES: Record<Color, Swatch> = {
  gray: { stroke: "#a3a6b0", fill: "#f4f4f6" },
  blue: { stroke: "#5b9ae6", fill: "#edf4fd" },
  green: { stroke: "#4fae7c", fill: "#ebf6f0" },
  yellow: { stroke: "#d6a62a", fill: "#fcf5e1" },
  orange: { stroke: "#e98550", fill: "#fdf0e8" },
  red: { stroke: "#e06464", fill: "#fcefef" },
  purple: { stroke: "#7d85dc", fill: "#f0f1fc" },
  pink: { stroke: "#d877a8", fill: "#fbeef5" },
  teal: { stroke: "#3aa9bb", fill: "#e8f6f8" },
};

/** Sticky notes are cards: a slightly deeper tint than shapes, a stroke barely darker than the fill. */
export const STICKY_FILL: Record<Color, string> = {
  gray: "#f1f1f4",
  blue: "#e3eefc",
  green: "#e2f3e9",
  yellow: "#fbf0cf",
  orange: "#fce8da",
  red: "#fbe6e6",
  purple: "#e9eafb",
  pink: "#fae6f0",
  teal: "#def2f5",
};

export const STICKY_STROKE: Record<Color, string> = {
  gray: "#dcdce2",
  blue: "#c6dbf6",
  green: "#c3e4d0",
  yellow: "#efdca4",
  orange: "#f4cfb6",
  red: "#f1c9c9",
  purple: "#d2d5f4",
  pink: "#efc9dc",
  teal: "#bfe2e8",
};

export const INK = "#282a30";
export const INK_SOFT = "#6f6e77";
export const INK_FAINT = "#b9b8bf";
/** Arrows and connectors: a neutral a step lighter than soft ink, so lines recede behind the shapes they join. */
export const EDGE = "#8f8e98";
export const WIRE = "#d6d5db";
export const WIRE_FILL = "#f4f4f6";
export const SCREEN = "#ffffff";
export const ACCENT = "#5e6ad2";
export const ACCENT_FILL = "#eef0fc";

/**
 * The board's one typeface. Excalidraw has no API for custom fonts, so `public/fonts/Liberation/` ships Inter (500)
 * under Liberation Sans's file name: Excalidraw loads and measures it like any built-in family.
 */
export const BOARD_FONT = FONT_FAMILY["Liberation Sans"];

export const ROUGHNESS = 0;
/** Outlines of shapes and devices. */
export const STROKE = 1.5;
/** Arrows, connectors and axes. */
export const EDGE_STROKE = 1.5;
/** Fine detail inside mockups. */
export const HAIRLINE = 1;
