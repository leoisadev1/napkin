// The shell's canvas controls: tool rail, zoom bar, selection bar and the ⌘K menu, all driving Excalidraw through its
// API. Also claims the keys that would open Excalidraw's own dialogs (help, command palette) and routes them here.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useMemo } from "react";
import type { CanvasState, Theme } from "../canvas/BoardCanvas";
import type { BoardTool } from "../canvas/commands";
import { clearBoard, deleteSelection, exportPng, recolorSelection, redo, setTool, undo, zoomStep, zoomTo, zoomToFit } from "../canvas/commands";
import type { Command } from "./CommandMenu";
import { CommandMenu } from "./CommandMenu";
import { DownloadIcon, FitIcon, MinusIcon, MonitorIcon, MoonIcon, PlusIcon, RedoIcon, SunIcon, TrashIcon, UndoIcon } from "./icons";
import { SelectionBar } from "./SelectionBar";
import { TOOL_GROUPS, ToolRail } from "./ToolRail";
import type { ThemePreference } from "./useTheme";
import { ZoomBar } from "./ZoomBar";

export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

type Props = {
  api: ExcalidrawImperativeAPI | null;
  canvas: CanvasState;
  theme: Theme;
  title: string;
  setThemePreference: (next: ThemePreference) => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  /** Conversation actions that belong in the menu too. */
  extra: readonly Command[];
};

export function BoardChrome({ api, canvas, theme, title, setThemePreference, menuOpen, setMenuOpen, extra }: Props) {
  // ⌘K / Ctrl+K and "?" open our menu; Excalidraw's own palette (Ctrl+/, ⌘⇧P) and help dialog never get the keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement);
      const palette = (mod && key === "k") || (mod && key === "/") || (mod && event.shiftKey && key === "p");
      const help = !mod && event.key === "?" && !typing;
      if (!palette && !help) return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(!menuOpen);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [menuOpen, setMenuOpen]);

  const commands = useMemo((): Command[] => {
    if (api === null) return [...extra];
    const tools: Command[] = TOOL_GROUPS.flat().map(({ tool, label, key, Icon }) => ({
      id: `tool-${tool}`,
      group: "Tools",
      label,
      Icon,
      shortcut: key,
      keywords: "tool draw",
      run: () => setTool(api, tool),
    }));
    return [
      ...extra,
      ...tools,
      { id: "fit", group: "View", label: "Zoom to fit", Icon: FitIcon, shortcut: "⇧1", run: () => zoomToFit(api) },
      { id: "zoom-in", group: "View", label: "Zoom in", Icon: PlusIcon, shortcut: `${MOD}+`, run: () => zoomStep(api, 1) },
      { id: "zoom-out", group: "View", label: "Zoom out", Icon: MinusIcon, shortcut: `${MOD}−`, run: () => zoomStep(api, -1) },
      { id: "zoom-100", group: "View", label: "Zoom to 100%", Icon: FitIcon, shortcut: `${MOD}0`, run: () => zoomTo(api, 1) },
      { id: "theme-light", group: "Theme", label: "Light theme", Icon: SunIcon, keywords: "appearance mode", run: () => setThemePreference("light") },
      { id: "theme-dark", group: "Theme", label: "Dark theme", Icon: MoonIcon, keywords: "appearance mode", run: () => setThemePreference("dark") },
      { id: "theme-system", group: "Theme", label: "Match system theme", Icon: MonitorIcon, keywords: "appearance mode auto", run: () => setThemePreference("system") },
      { id: "undo", group: "Board", label: "Undo", Icon: UndoIcon, shortcut: `${MOD}Z`, run: undo },
      { id: "redo", group: "Board", label: "Redo", Icon: RedoIcon, shortcut: `${MOD}⇧Z`, run: redo },
      { id: "export", group: "Board", label: "Export as PNG", Icon: DownloadIcon, keywords: "download image save", run: () => void exportPng(api, { name: title, dark: theme === "dark" }) },
      { id: "clear", group: "Board", label: "Clear board", Icon: TrashIcon, keywords: "delete reset", confirm: "Press Enter again to clear the board", run: () => clearBoard(api) },
    ];
  }, [api, extra, setThemePreference, theme, title]);

  const pick = (tool: BoardTool) => {
    if (api !== null) setTool(api, tool);
  };
  const selecting = canvas.selected > 0 && !canvas.editingText && canvas.tool === "selection";

  return (
    <>
      <ToolRail active={canvas.tool} onPick={pick} onUndo={undo} onRedo={redo} mod={MOD} />
      <ZoomBar
        zoom={canvas.zoom}
        mod={MOD}
        onZoomIn={() => api !== null && zoomStep(api, 1)}
        onZoomOut={() => api !== null && zoomStep(api, -1)}
        onFit={() => api !== null && zoomToFit(api)}
        onUndo={undo}
        onRedo={redo}
      />
      <SelectionBar
        visible={selecting}
        count={canvas.selected}
        onColor={(color) => api !== null && recolorSelection(api, color)}
        onDelete={() => api !== null && deleteSelection(api)}
      />
      <CommandMenu open={menuOpen} commands={commands} onClose={() => setMenuOpen(false)} />
    </>
  );
}
