// Bottom-left: zoom out, the current zoom (click to fit the board), zoom in, then undo and redo.
import { MinusIcon, PlusIcon, RedoIcon, UndoIcon } from "./icons";

type Props = {
  zoom: number;
  mod: string;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
};

export function ZoomBar({ zoom, mod, onZoomIn, onZoomOut, onFit, onUndo, onRedo }: Props) {
  return (
    <div className="zoombar panel" role="toolbar" aria-label="View">
      <button type="button" className="ghost-btn" aria-label="Zoom out" onClick={onZoomOut}>
        <MinusIcon />
        <span className="tip tip-up" role="presentation">
          Zoom out<kbd>{mod}−</kbd>
        </span>
      </button>
      <button type="button" className="ghost-btn zoom-value" aria-label={`Zoom ${zoom}%. Fit board to screen`} onClick={onFit}>
        {zoom}%
        <span className="tip tip-up" role="presentation">
          Zoom to fit<kbd>⇧1</kbd>
        </span>
      </button>
      <button type="button" className="ghost-btn" aria-label="Zoom in" onClick={onZoomIn}>
        <PlusIcon />
        <span className="tip tip-up" role="presentation">
          Zoom in<kbd>{mod}+</kbd>
        </span>
      </button>
      <span className="panel-divider" aria-hidden="true" />
      <button type="button" className="ghost-btn" aria-label="Undo" onClick={onUndo}>
        <UndoIcon />
        <span className="tip tip-up" role="presentation">
          Undo<kbd>{mod}Z</kbd>
        </span>
      </button>
      <button type="button" className="ghost-btn" aria-label="Redo" onClick={onRedo}>
        <RedoIcon />
        <span className="tip tip-up" role="presentation">
          Redo<kbd>{mod}⇧Z</kbd>
        </span>
      </button>
    </div>
  );
}
