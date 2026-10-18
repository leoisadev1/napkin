// Converting between a live Excalidraw scene and its stored form.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawInitialDataState, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import { readMeta } from "../canvas/meta";
import type { StoredFile, StoredScene, StoredView } from "./schema";

/** Elements worth keeping: live ones, minus placeholders and fading ghosts that only make sense mid-request. */
export function savableElements(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  return elements.filter((el) => {
    if (el.isDeleted) return false;
    const kind = readMeta(el)?.kind;
    return kind !== "pending" && kind !== "ghost";
  });
}

/** Changes whenever an element is added, removed or edited; ignores camera moves and selection. */
export function sceneFingerprint(elements: readonly ExcalidrawElement[]): string {
  let versions = 0;
  let nonces = 0;
  let count = 0;
  for (const el of elements) {
    if (el.isDeleted) continue;
    count += 1;
    versions += el.version;
    nonces = (nonces + el.versionNonce) % 2_147_483_647;
  }
  return `${count}:${versions}:${nonces}`;
}

/**
 * Agent elements fade in from 0 to full opacity; only dormant frames rest below it (at 0, locked). A save forced in
 * the middle of a fade (switching boards while the partner draws) stores them at their resting opacity instead.
 */
export function settleFades(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  return elements.map((el) => {
    if (el.opacity >= 100 || readMeta(el) === null) return el;
    if (el.type === "frame" && el.locked && el.opacity === 0) return el;
    return { ...el, opacity: 100 };
  });
}

type ViewState = Pick<AppState, "scrollX" | "scrollY" | "zoom" | "theme" | "viewBackgroundColor">;

export function captureScene(args: { elements: readonly ExcalidrawElement[]; appState: ViewState | null; files: BinaryFiles; settle: boolean }): StoredScene {
  const kept = savableElements(args.elements);
  const elements = args.settle ? settleFades(kept) : kept;
  const used = new Set(elements.flatMap((el) => (el.type === "image" && el.fileId !== null ? [el.fileId] : [])));
  const files: StoredFile[] = [];
  for (const file of Object.values(args.files)) {
    if (!used.has(file.id) || !file.mimeType.startsWith("image/")) continue;
    files.push({ id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created });
  }
  const state = args.appState;
  const view: StoredView | null =
    state === null
      ? null
      : { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value, theme: state.theme, viewBackgroundColor: state.viewBackgroundColor };
  return { elements, files, view };
}

function isNormalizedZoom(value: number): value is NormalizedZoomValue {
  return Number.isFinite(value) && value >= 0.1 && value <= 30;
}

/** Excalidraw initialData for a stored scene. Excalidraw's restore() repairs the elements on load. */
export function initialDataOf(scene: StoredScene, options: { theme?: "light" | "dark" } = {}): ExcalidrawInitialDataState {
  const files: BinaryFiles = {};
  for (const file of scene.files) files[file.id] = { ...file, lastRetrieved: Date.now() };
  const view = scene.view;
  const zoom = view !== null && isNormalizedZoom(view.zoom) ? view.zoom : null;
  // The theme is the app's, not the board's: the one in use wins, and the board's saved one only seeds a fresh page.
  const theme = options.theme ?? view?.theme;
  return {
    elements: scene.elements,
    files,
    appState: {
      ...(view === null || zoom === null ? {} : { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: zoom }, viewBackgroundColor: view.viewBackgroundColor }),
      ...(theme === undefined ? {} : { theme }),
    },
    scrollToContent: view === null && scene.elements.length > 0,
  };
}
