// The drawing tools, as a slim rail on the left edge (a strip under the title on phones). Keys are Excalidraw's own
// shortcuts, which keep working because the engine still listens for them; the rail only mirrors and sets the tool.
import type { ComponentType } from "react";
import type { BoardTool } from "../canvas/commands";
import {
  ArrowToolIcon,
  DiamondToolIcon,
  EllipseToolIcon,
  EraserToolIcon,
  HandToolIcon,
  ImageToolIcon,
  LineToolIcon,
  PenToolIcon,
  RectangleToolIcon,
  RedoIcon,
  SelectToolIcon,
  TextToolIcon,
  UndoIcon,
} from "./icons";

export type ToolSpec = { tool: BoardTool; label: string; key: string; Icon: ComponentType<{ size?: number }> };

/** Groups are separated by a hairline: navigate, shapes, freeform, erase. */
export const TOOL_GROUPS: readonly (readonly ToolSpec[])[] = [
  [
    { tool: "selection", label: "Select", key: "V", Icon: SelectToolIcon },
    { tool: "hand", label: "Hand", key: "H", Icon: HandToolIcon },
  ],
  [
    { tool: "rectangle", label: "Rectangle", key: "R", Icon: RectangleToolIcon },
    { tool: "diamond", label: "Diamond", key: "D", Icon: DiamondToolIcon },
    { tool: "ellipse", label: "Ellipse", key: "O", Icon: EllipseToolIcon },
    { tool: "arrow", label: "Arrow", key: "A", Icon: ArrowToolIcon },
    { tool: "line", label: "Line", key: "L", Icon: LineToolIcon },
  ],
  [
    { tool: "freedraw", label: "Pen", key: "P", Icon: PenToolIcon },
    { tool: "text", label: "Text", key: "T", Icon: TextToolIcon },
    { tool: "image", label: "Image", key: "9", Icon: ImageToolIcon },
  ],
  [{ tool: "eraser", label: "Eraser", key: "E", Icon: EraserToolIcon }],
];

type Props = {
  active: string;
  onPick: (tool: BoardTool) => void;
  onUndo: () => void;
  onRedo: () => void;
  mod: string;
};

export function ToolRail({ active, onPick, onUndo, onRedo, mod }: Props) {
  return (
    <nav className="rail" aria-label="Drawing tools">
      {TOOL_GROUPS.map((group, index) => (
        <div className="rail-group" key={group[0]?.tool ?? index} role="group">
          {group.map(({ tool, label, key, Icon }) => (
            <button
              key={tool}
              type="button"
              className="rail-btn"
              aria-label={label}
              aria-pressed={active === tool}
              aria-keyshortcuts={key}
              onClick={() => onPick(tool)}
            >
              <Icon />
              <span className="tip" role="presentation">
                {label}
                <kbd>{key}</kbd>
              </span>
            </button>
          ))}
        </div>
      ))}
      {/* Phones have no keyboard and no zoom bar, so undo and redo ride along at the end of the strip. */}
      <div className="rail-group rail-history" role="group">
        <button type="button" className="rail-btn" aria-label="Undo" onClick={onUndo}>
          <UndoIcon />
          <span className="tip" role="presentation">
            Undo<kbd>{mod}Z</kbd>
          </span>
        </button>
        <button type="button" className="rail-btn" aria-label="Redo" onClick={onRedo}>
          <RedoIcon />
          <span className="tip" role="presentation">
            Redo<kbd>{mod}⇧Z</kbd>
          </span>
        </button>
      </div>
    </nav>
  );
}
