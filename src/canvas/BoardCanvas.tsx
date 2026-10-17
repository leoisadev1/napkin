// Full-screen Excalidraw. Keeps the drawing toolbar so people can sketch alongside the partner,
// trims menus that make no sense here, and reports the bits of state the shell cares about.
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { memo, useCallback, useEffect, useRef } from "react";
import type { PointerSample } from "./bridge";

export type CanvasState = { hasContent: boolean; theme: "light" | "dark" };

type Props = {
  onApi: (api: ExcalidrawImperativeAPI) => void;
  onState: (state: CanvasState) => void;
  /** The mouse over the board, in screen coordinates; null on touch or when it leaves the window. */
  onPointer: (sample: PointerSample) => void;
};

export const BoardCanvas = memo(function BoardCanvas({ onApi, onState, onPointer }: Props) {
  const last = useRef<CanvasState>({ hasContent: false, theme: "light" });
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
    (elements: readonly { isDeleted: boolean }[], appState: { theme: "light" | "dark" }) => {
      const next: CanvasState = { hasContent: elements.some((el) => !el.isDeleted), theme: appState.theme };
      if (next.hasContent !== last.current.hasContent || next.theme !== last.current.theme) {
        last.current = next;
        onState(next);
      }
    },
    [onState],
  );

  return (
    <div className="canvas" ref={rootRef}>
      <Excalidraw
        excalidrawAPI={onApi}
        onChange={onChange}
        initialData={{ appState: { currentItemFontFamily: 5, currentItemRoughness: 1, currentItemFillStyle: "solid" } }}
        UIOptions={{
          canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: true },
          tools: { image: true },
        }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  );
});
