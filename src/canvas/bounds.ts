// Scene bounds of Excalidraw elements as a plain Rect.
import { getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { Rect } from "./geometry";

export function boundsOf(elements: readonly ExcalidrawElement[]): Rect | null {
  if (elements.length === 0) return null;
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
