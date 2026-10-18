// Full-screen Excalidraw used purely as an engine: every piece of its own chrome is hidden (see ui/canvas.css) and the
// shell drives it through the API. It reports the bits of state the shell renders: content, tool, selection and zoom.
// Behind the transparent canvas sits a dot grid that pans and zooms with the board.
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { memo, useCallback, useEffect, useRef } from "react";
import type { PointerSample } from "./bridge";
import { BOARD_FONT, EDGE_STROKE, INK, ROUGHNESS } from "./palette";

export type Theme = "light" | "dark";

export type CanvasState = {
  hasContent: boolean;
  tool: AppState["activeTool"]["type"];
  /** Selected elements, not counting text bound inside a shape. */
  selected: number;
  editingText: boolean;
  /** Zoom as a whole percentage. */
  zoom: number;
};

export const INITIAL_CANVAS: CanvasState = { hasContent: false, tool: "selection", selected: 0, editingText: false, zoom: 100 };

type Props = {
  theme: Theme;
  onApi: (api: ExcalidrawImperativeAPI) => void;
  onState: (state: CanvasState) => void;
  /** The mouse over the board, in screen coordinates; null on touch or when it leaves the window. */
  onPointer: (sample: PointerSample) => void;
};

/** Board units between grid dots at 100%. */
const GRID = 24;

function same(a: CanvasState, b: CanvasState): boolean {
  return a.hasContent === b.hasContent && a.tool === b.tool && a.selected === b.selected && a.editingText === b.editingText && a.zoom === b.zoom;
}

export const BoardCanvas = memo(function BoardCanvas({ theme, onApi, onState, onPointer }: Props) {
  const last = useRef<CanvasState>(INITIAL_CANVAS);
  const rootRef = useRef<HTMLDivElement>(null);

  // Native capture listeners: they see every move before Excalidraw handles it, and know whether it is a finger.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onMove = (event: PointerEvent) => onPointer(event.pointerType === "touch" ? null : { clientX: event.clientX, clientY: event.clientY });
    // Moving onto the dock or another overlay keeps the last spot; only leaving the window clears it.
    const onLeave = (event: PointerEvent) => {
      if (event.relatedTarget === null) onPointer(null);
    };
    root.addEventListener("pointermove", onMove, { capture: true, passive: true });
    root.addEventListener("pointerdown", onMove, { capture: true, passive: true });
    root.addEventListener("pointerleave", onLeave);
    return () => {
      root.removeEventListener("pointermove", onMove, { capture: true });
      root.removeEventListener("pointerdown", onMove, { capture: true });
      root.removeEventListener("pointerleave", onLeave);
    };
  }, [onPointer]);

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState) => {
      const ids = appState.selectedElementIds;
      const next: CanvasState = {
        hasContent: elements.some((el) => !el.isDeleted),
        tool: appState.activeTool.type,
        selected: elements.filter((el) => ids[el.id] === true && !el.isDeleted && !(el.type === "text" && el.containerId !== null)).length,
        editingText: appState.editingTextElement != null,
        zoom: Math.round(appState.zoom.value * 100),
      };
      if (!same(next, last.current)) {
        last.current = next;
        onState(next);
      }
    },
    [onState],
  );

  // The grid is painted by CSS on the wrapper; only its custom properties change, so React never re-renders on pan.
  const onScrollChange = useCallback((scrollX: number, scrollY: number, zoom: { value: number }) => {
    const root = rootRef.current;
    if (root === null) return;
    let step = GRID * zoom.value;
    // Zoomed far out, skip every other dot so the grid never turns into a haze.
    while (step < 14) step *= 2;
    root.style.setProperty("--grid-step", `${step}px`);
    root.style.setProperty("--grid-x", `${scrollX * zoom.value}px`);
    root.style.setProperty("--grid-y", `${scrollY * zoom.value}px`);
  }, []);

  return (
    <div className="canvas" ref={rootRef}>
      <Excalidraw
        excalidrawAPI={onApi}
        onChange={onChange}
        onScrollChange={onScrollChange}
        theme={theme}
        initialData={{
          appState: {
            viewBackgroundColor: "transparent",
            currentItemFontFamily: BOARD_FONT,
            currentItemFontSize: 20,
            currentItemRoughness: ROUGHNESS,
            currentItemStrokeWidth: EDGE_STROKE,
            currentItemStrokeColor: INK,
            currentItemBackgroundColor: "transparent",
            currentItemFillStyle: "solid",
            currentItemRoundness: "round",
            currentItemArrowType: "round",
            currentItemEndArrowhead: "triangle",
          },
        }}
        UIOptions={{
          canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, changeViewBackgroundColor: false, clearCanvas: false, saveAsImage: false },
          tools: { image: true },
        }}
      />
    </div>
  );
});
