// What the shell can ask of the canvas, built on Excalidraw's imperative API so its own toolbar, menus and footer can
// stay hidden. Undo and redo have no API, so they replay Excalidraw's own keyboard shortcut.
import { CaptureUpdateAction, exportToBlob, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI, NormalizedZoomValue, ToolType } from "@excalidraw/excalidraw/types";
import type { Color } from "../../shared/board";
import { SWATCHES } from "./palette";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

/** Tools the shell offers, in rail order. */
export type BoardTool = Extract<ToolType, "selection" | "hand" | "rectangle" | "diamond" | "ellipse" | "arrow" | "line" | "freedraw" | "text" | "image" | "eraser">;

export function setTool(api: ExcalidrawImperativeAPI, tool: BoardTool): void {
  api.setActiveTool({ type: tool });
}

/** Zooms around the middle of the viewport, the way the + and - buttons of any canvas do. */
export function zoomTo(api: ExcalidrawImperativeAPI, value: number): void {
  const state = api.getAppState();
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  const cx = state.width / 2;
  const cy = state.height / 2;
  const sceneX = cx / state.zoom.value - state.scrollX;
  const sceneY = cy / state.zoom.value - state.scrollY;
  api.updateScene({
    appState: {
      // Excalidraw brands zoom values it has clamped; `next` is clamped to the same range above.
      zoom: { value: next as NormalizedZoomValue },
      scrollX: cx / next - sceneX,
      scrollY: cy / next - sceneY,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

/** Steps through the usual canvas zoom ladder. */
const LADDER = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

export function zoomStep(api: ExcalidrawImperativeAPI, direction: 1 | -1): void {
  const current = api.getAppState().zoom.value;
  const next = direction === 1 ? LADDER.find((z) => z > current + 0.001) : LADDER.findLast((z) => z < current - 0.001);
  zoomTo(api, next ?? current);
}

export function zoomToFit(api: ExcalidrawImperativeAPI): void {
  const elements = api.getSceneElements();
  if (elements.length === 0) {
    zoomTo(api, 1);
    return;
  }
  api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.8, animate: true, duration: 320 });
}

function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

/** Replays Ctrl/Cmd+Z (and Shift for redo) where Excalidraw listens for it. */
function history(redo: boolean): void {
  const mac = isMac();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: redo ? "Z" : "z", code: "KeyZ", shiftKey: redo, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
}

export const undo = () => history(false);
export const redo = () => history(true);

export function selectedElements(api: ExcalidrawImperativeAPI): ExcalidrawElement[] {
  const ids = api.getAppState().selectedElementIds;
  return api.getSceneElements().filter((el) => ids[el.id] === true);
}

/** Recolors the selection: shapes take stroke and fill, lines and text take the stroke. Undoable. */
export function recolorSelection(api: ExcalidrawImperativeAPI, color: Color): void {
  const swatch = SWATCHES[color];
  const ids = api.getAppState().selectedElementIds;
  const elements = api.getSceneElements().map((el) => {
    if (ids[el.id] !== true) return el;
    switch (el.type) {
      case "rectangle":
      case "ellipse":
      case "diamond":
        return newElementWith(el, { strokeColor: swatch.stroke, backgroundColor: el.backgroundColor === "transparent" ? el.backgroundColor : swatch.fill });
      case "arrow":
      case "line":
      case "freedraw":
      case "text":
        return newElementWith(el, { strokeColor: swatch.stroke });
      default:
        return el;
    }
  });
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

/** Deletes the selection and anything bound inside it (labels). Undoable. */
export function deleteSelection(api: ExcalidrawImperativeAPI): void {
  const ids = api.getAppState().selectedElementIds;
  const elements = api.getSceneElements().map((el) => {
    const container = el.type === "text" ? el.containerId : null;
    return ids[el.id] === true || (container !== null && ids[container] === true) ? newElementWith(el, { isDeleted: true }) : el;
  });
  api.updateScene({ elements, appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

export function clearBoard(api: ExcalidrawImperativeAPI): void {
  const elements = api.getSceneElements().map((el) => newElementWith(el, { isDeleted: true }));
  api.updateScene({ elements, appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

/** Downloads the board as a PNG. Dark mode inverts the white background along with everything else. */
export async function exportPng(api: ExcalidrawImperativeAPI, args: { name: string; dark: boolean }): Promise<void> {
  const elements = api.getSceneElements();
  if (elements.length === 0) return;
  const blob = await exportToBlob({
    elements,
    files: api.getFiles(),
    mimeType: "image/png",
    exportPadding: 32,
    appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: args.dark, exportScale: 2 },
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${args.name.trim() || "Board"}.png`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
