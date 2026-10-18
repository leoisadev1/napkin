// While something is selected: the board's nine tones and delete, in a small bar at the top. It stands in for
// Excalidraw's property panel, which is hidden along with the rest of its chrome.
import { Color } from "../../shared/board";
import { SWATCHES } from "../canvas/palette";
import { TrashIcon } from "./icons";

type Props = { visible: boolean; count: number; onColor: (color: Color) => void; onDelete: () => void };

export function SelectionBar({ visible, count, onColor, onDelete }: Props) {
  return (
    <div className="selbar panel" data-visible={visible} aria-hidden={!visible} inert={!visible} role="toolbar" aria-label="Selection">
      <span className="selbar-count">{count === 1 ? "1 item" : `${count} items`}</span>
      <span className="panel-divider" aria-hidden="true" />
      <div className="swatches">
        {Color.options.map((color) => (
          <button
            key={color}
            type="button"
            className="swatch"
            aria-label={`Color ${color}`}
            style={{ color: SWATCHES[color].stroke }}
            onClick={() => onColor(color)}
          />
        ))}
      </div>
      <span className="panel-divider" aria-hidden="true" />
      <button type="button" className="ghost-btn" aria-label="Delete" onClick={onDelete}>
        <TrashIcon />
        <span className="tip" role="presentation">
          Delete<kbd>⌫</kbd>
        </span>
      </button>
    </div>
  );
}
