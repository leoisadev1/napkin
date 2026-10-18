// Visual vocabulary for board elements: crisp hairline strokes, quiet tinted fills, one cool ink for text, and a clean
// sans (Inter). Tones follow Linear's label colors, softened so a full board stays calm. In dark mode the canvas is
// flipped by the board's own filter (BoardCanvas, DARK_FILTER): lightness inverts while hue holds, so these light
// values become dark tinted fills with brighter strokes. Yellow is kept low in chroma because any dark yellow turns
// brown; at this chroma it lands on a warm amber instead of mud.
import { FONT_FAMILY } from "@excalidraw/excalidraw";
import type { Color } from "../../shared/board";

export type Swatch = {
  stroke: string;
  fill: string;
  /** The color at full strength, for the one solid shape a diagram has (a mindmap's hub). White text sits on it. */
  solid: string;
};

/** Stroke at mid lightness, fill a whisper of the same hue, so shapes read as tinted cards rather than paper. */
export const SWATCHES: Record<Color, Swatch> = {
  gray: { stroke: "#a3a6b0", fill: "#f4f4f6", solid: "#5f616b" },
  blue: { stroke: "#5b95e0", fill: "#eef4fc", solid: "#3f7bd0" },
  green: { stroke: "#4fa87a", fill: "#edf6f1", solid: "#2f8a5c" },
  yellow: { stroke: "#cc9f33", fill: "#fbf5e2", solid: "#b38212" },
  orange: { stroke: "#e2834f", fill: "#fdf2eb", solid: "#cf6630" },
  red: { stroke: "#da6464", fill: "#fcf0f0", solid: "#c84848" },
  purple: { stroke: "#7c84d8", fill: "#f1f2fc", solid: "#5e6ad2" },
  pink: { stroke: "#d277a5", fill: "#fbf0f6", solid: "#bc4f88" },
  teal: { stroke: "#3aa3b4", fill: "#eaf6f8", solid: "#21879a" },
};

/** Sticky notes are cards: a slightly deeper tint than shapes, a stroke barely darker than the fill. */
export const STICKY_FILL: Record<Color, string> = {
  gray: "#f1f1f4",
  blue: "#e5effc",
  green: "#e4f3ea",
  yellow: "#faf1d6",
  orange: "#fcebdf",
  red: "#fbe8e8",
  purple: "#ebecfb",
  pink: "#fae8f1",
  teal: "#e1f2f5",
};

export const STICKY_STROKE: Record<Color, string> = {
  gray: "#dcdce2",
  blue: "#c9dcf5",
  green: "#c6e3d2",
  yellow: "#ecdcab",
  orange: "#f2d2bd",
  red: "#efcccc",
  purple: "#d4d7f3",
  pink: "#edcbdd",
  teal: "#c3e2e8",
};

/** Words on a solid fill. */
export const ON_SOLID = "#ffffff";
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
