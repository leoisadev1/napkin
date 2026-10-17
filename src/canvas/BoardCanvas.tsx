// Full-screen Excalidraw. Keeps the drawing toolbar so people can sketch alongside the partner,
// trims menus that make no sense here, and reports the bits of state the shell cares about.
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { memo, useCallback, useRef } from "react";

export type CanvasState = { hasContent: boolean; theme: "light" | "dark" };

type Props = {
  onApi: (api: ExcalidrawImperativeAPI) => void;
  onState: (state: CanvasState) => void;
};

export const BoardCanvas = memo(function BoardCanvas({ onApi, onState }: Props) {
  const last = useRef<CanvasState>({ hasContent: false, theme: "light" });
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
    <div className="canvas">
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
