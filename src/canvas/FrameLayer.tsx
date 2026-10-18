// Frames drawn as soft cards beneath the (transparent) canvas, in place of Excalidraw's gray outline: a panel tint and
// a hairline that hide the dot grid, so a frame reads as a surface the way a Linear card does. Positions follow every
// scene change and every pan or zoom through direct DOM writes, batched to one per frame.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useRef } from "react";

/** Corner radius in board units, so a frame keeps its shape at any zoom. */
const RADIUS = 14;

export function FrameLayer({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (api === null || root === null) return;
    const nodes = new Map<string, HTMLDivElement>();
    let queued: number | null = null;

    const draw = () => {
      queued = null;
      const { scrollX, scrollY, zoom } = api.getAppState();
      const z = zoom.value;
      const seen = new Set<string>();
      for (const el of api.getSceneElements()) {
        // Dormant frames are invisible placeholders until their first child lands.
        if (el.type !== "frame" || el.opacity === 0) continue;
        seen.add(el.id);
        let node = nodes.get(el.id);
        if (node === undefined) {
          node = document.createElement("div");
          node.className = "board-frame";
          root.appendChild(node);
          nodes.set(el.id, node);
        }
        node.style.transform = `translate(${(el.x + scrollX) * z}px, ${(el.y + scrollY) * z}px)`;
        node.style.width = `${el.width * z}px`;
        node.style.height = `${el.height * z}px`;
        node.style.borderRadius = `${Math.max(6, RADIUS * z)}px`;
        node.style.opacity = String(el.opacity / 100);
      }
      for (const [id, node] of nodes) {
        if (seen.has(id)) continue;
        node.remove();
        nodes.delete(id);
      }
    };
    const schedule = () => {
      if (queued === null) queued = requestAnimationFrame(draw);
    };

    draw();
    const offChange = api.onChange(schedule);
    const offScroll = api.onScrollChange(schedule);
    return () => {
      offChange();
      offScroll();
      if (queued !== null) cancelAnimationFrame(queued);
      for (const node of nodes.values()) node.remove();
    };
  }, [api]);

  return <div className="frame-layer" ref={rootRef} aria-hidden="true" />;
}
