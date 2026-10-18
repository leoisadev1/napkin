// The partner's cursor, drawn by the shell: an accent arrow with a name tag that says what it is doing. The animator
// moves it in scene coordinates; this maps them to the screen on every move and every pan or zoom, through refs, so
// React never re-renders while it glides.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useRef } from "react";
import type { CursorStore, PartnerCursor as Cursor } from "../canvas/cursorStore";

const LABEL: Record<NonNullable<Cursor["status"]> | "idle", string> = { idle: "Partner", thinking: "Partner", tidying: "Tidying up" };

export function PartnerCursor({ store, api }: { store: CursorStore; api: ExcalidrawImperativeAPI | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const label = labelRef.current;
    if (api === null || root === null || label === null) return;
    const place = () => {
      const cursor = store.get();
      root.dataset.visible = String(cursor !== null);
      if (cursor === null) return;
      const { scrollX, scrollY, zoom } = api.getAppState();
      root.style.transform = `translate(${(cursor.x + scrollX) * zoom.value}px, ${(cursor.y + scrollY) * zoom.value}px)`;
      root.dataset.status = cursor.status ?? "idle";
      label.textContent = LABEL[cursor.status ?? "idle"];
    };
    place();
    const offStore = store.subscribe(place);
    const offScroll = api.onScrollChange(place);
    return () => {
      offStore();
      offScroll();
    };
  }, [api, store]);

  return (
    <div className="cursor-layer" aria-hidden="true">
      <div className="partner-cursor" ref={rootRef} data-visible="false">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2.5 1.8 13.2 7.1c.5.25.45.98-.08 1.15L8.6 9.6 6.9 13.9c-.2.52-.95.5-1.12-.03L2 2.6c-.15-.47.33-.9.78-.67Z" fill="var(--accent)" stroke="var(--bg-panel)" strokeWidth="1.25" strokeLinejoin="round" />
        </svg>
        <span className="partner-tag">
          <span ref={labelRef}>Partner</span>
          <i className="partner-dots">
            <b />
            <b />
            <b />
          </i>
        </span>
      </div>
    </div>
  );
}
