// A stable bridge that exists before Excalidraw mounts. The conversation engine gets it on first render;
// calls made before the canvas is ready are queued and replayed once the real bridge attaches.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardOp } from "../../shared/board";
import type { CanvasBridge, PartnerActivity, PointerSample } from "./bridge";
import { createBoardBridge, DEFAULT_TITLE } from "./bridge";
import type { CursorStore } from "./cursorStore";
import { createCursorStore } from "./cursorStore";

type Queued =
  | { kind: "apply"; op: BoardOp }
  | { kind: "showPending"; id: string; label: string }
  | { kind: "clearPending"; id: string };

export type BridgeHost = {
  bridge: CanvasBridge;
  /** The partner's cursor, published for the shell to draw. */
  cursor: CursorStore;
  attach(api: ExcalidrawImperativeAPI): () => void;
};

export function createBridgeHost(options: { onError?: (error: unknown) => void } = {}): BridgeHost {
  let real: CanvasBridge | null = null;
  const cursor = createCursorStore();
  let title = DEFAULT_TITLE;
  const queue: Queued[] = [];
  let pointer: PointerSample = null;
  let activity: PartnerActivity = { kind: "idle" };
  const titleListeners = new Set<(title: string) => void>();
  const notify = (next: string) => {
    title = next;
    for (const listener of titleListeners) listener(next);
  };

  const bridge: CanvasBridge = {
    apply(op) {
      if (real === null) queue.push({ kind: "apply", op });
      else real.apply(op);
    },
    getSummary() {
      return real === null ? { title, items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 0, h: 0 } } : real.getSummary();
    },
    showPending(args) {
      if (real === null) queue.push({ kind: "showPending", ...args });
      else real.showPending(args);
    },
    clearPending(id) {
      if (real === null) queue.push({ kind: "clearPending", id });
      else real.clearPending(id);
    },
    trackPointer(sample) {
      pointer = sample;
      real?.trackPointer(sample);
    },
    setPartner(next) {
      activity = next;
      real?.setPartner(next);
    },
    getTitle: () => title,
    setTitle(next) {
      if (real === null) notify(next.trim().slice(0, 80) || DEFAULT_TITLE);
      else real.setTitle(next);
    },
    subscribeTitle(listener) {
      titleListeners.add(listener);
      return () => titleListeners.delete(listener);
    },
    dispose() {
      real?.dispose();
    },
  };

  function attach(api: ExcalidrawImperativeAPI) {
    const instance = createBoardBridge(api, { ...options, cursor });
    instance.setTitle(title);
    const unsubscribe = instance.subscribeTitle(notify);
    real = instance;
    instance.trackPointer(pointer);
    instance.setPartner(activity);
    for (const item of queue.splice(0)) {
      switch (item.kind) {
        case "apply":
          instance.apply(item.op);
          break;
        case "showPending":
          instance.showPending(item);
          break;
        case "clearPending":
          instance.clearPending(item.id);
          break;
        default: {
          const _exhaustive: never = item;
          return _exhaustive;
        }
      }
    }
    return () => {
      unsubscribe();
      instance.dispose();
      if (real === instance) real = null;
    };
  }

  return { bridge, cursor, attach };
}
