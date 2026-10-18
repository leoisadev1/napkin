// Full-screen Excalidraw used purely as an engine: every piece of its own chrome is hidden (see ui/canvas.css) and the
// shell drives it through the API. It reports the bits of state the shell renders: content, tool, selection and zoom.
// Behind the transparent canvas sits a dot grid that pans and zooms with the board.
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { PointerSample } from "./bridge";
import { FrameLayer } from "./FrameLayer";
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
  /** A saved board to start from. Read once on mount; the board shell remounts the canvas to switch boards. */
  initialScene?: ExcalidrawInitialDataState;
};

/**
 * Dark mode for the board. Excalidraw's own filter (invert, then hue-rotate) bends hues on the way: yellows go olive
 * and strokes go dull. This one flips lightness around luma and keeps most of the color difference, so a hue stays
 * itself, then lifts the midtones so strokes read brighter on the dark board than they do on the light one.
 * canvas.css points Excalidraw's --theme-filter here.
 */
const LUMA = [0.2126, 0.7152, 0.0722] as const;
/** Luma 0 lands at 0.94 and luma 1 at 0.06: the board never reaches pure black or white. */
const TOP = 0.94;
const SPAN = 0.88;
/** Chroma kept. A little less than all, because a dark tint at full chroma turns muddy (yellow most of all). */
const CHROMA = 0.78;
const DARK_MATRIX = [0, 1, 2]
  .map((row) => [...LUMA.map((w, col) => (row === col ? CHROMA : 0) - (CHROMA + SPAN) * w), 0, TOP].map((v) => v.toFixed(5)).join(" "))
  .concat("0 0 0 1 0")
  .join(" ");

function DarkFilter() {
  return (
    <svg className="dark-filter" aria-hidden="true" focusable="false" width="0" height="0">
      <filter id="board-dark" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values={DARK_MATRIX} />
        <feComponentTransfer>
          <feFuncR type="gamma" exponent="0.85" />
          <feFuncG type="gamma" exponent="0.85" />
          <feFuncB type="gamma" exponent="0.85" />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

/** Board units between grid dots at 100%. */
const GRID = 24;

function same(a: CanvasState, b: CanvasState): boolean {
  return a.hasContent === b.hasContent && a.tool === b.tool && a.selected === b.selected && a.editingText === b.editingText && a.zoom === b.zoom;
}

export const BoardCanvas = memo(function BoardCanvas({ theme, onApi, onState, onPointer, initialScene }: Props) {
  const last = useRef<CanvasState>(INITIAL_CANVAS);
  const rootRef = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const onExcalidrawApi = useCallback(
    (next: ExcalidrawImperativeAPI) => {
      setApi(next);
      onApi(next);
    },
    [onApi],
  );

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

  // When the board's panel resizes (the sidebar opening or closing, the window changing), keep what was in the middle
  // in the middle, instead of letting the drawing slide with the panel's left edge.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || api === null) return;
    let last: { width: number; height: number } | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      const previous = last;
      last = { width, height };
      if (previous === null || (previous.width === width && previous.height === height)) return;
      const { scrollX, scrollY, zoom } = api.getAppState();
      api.updateScene({ appState: { scrollX: scrollX + (width - previous.width) / 2 / zoom.value, scrollY: scrollY + (height - previous.height) / 2 / zoom.value } });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [api]);

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
      <DarkFilter />
      <FrameLayer api={api} />
      <Excalidraw
        excalidrawAPI={onExcalidrawApi}
        onChange={onChange}
        onScrollChange={onScrollChange}
        theme={theme}
        // Tool keys work wherever focus is (except text fields), not only after a click on the canvas.
        handleKeyboardGlobally
        initialData={{
          ...initialScene,
          appState: {
            ...initialScene?.appState,
            // The dot grid shows through, and the app owns the theme; a saved board keeps only its camera.
            viewBackgroundColor: "transparent",
            theme,
            // Frames are drawn by FrameLayer; Excalidraw keeps their names, clipping and behavior.
            frameRendering: { enabled: true, name: true, outline: false, clip: true },
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
