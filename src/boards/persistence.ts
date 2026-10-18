// Keeps one open board saved: the scene (from Excalidraw), the conversation memory (from the engine) and the title
// (from the bridge, both ways). Saves about 500ms after things go quiet, and immediately on board switch or pagehide.
import { exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import type { CanvasBridge } from "../canvas/bridge";
import type { ConversationMemory, ConversationOptions } from "../conversation/memory";
import type { BoardData, BoardMeta } from "./schema";
import { captureScene, initialDataOf, savableElements, sceneFingerprint } from "./scene";
import type { BoardStore } from "./store";

export const SAVE_DELAY_MS = 500;
const THUMB_SIZE = 240;

/** One opened board: what the app shell needs to render it. */
export type BoardSession = {
  store: BoardStore;
  meta: BoardMeta;
  data: BoardData;
  /** Filled in by the board's persistence so the shell can save pending edits on demand (before a delete). */
  handle: { flush: () => void };
};

export type BoardPersistence = {
  initialScene: ExcalidrawInitialDataState;
  conversation: ConversationOptions;
  /** Starts watching the canvas. Returns a cleanup that saves whatever is pending. */
  attach(api: ExcalidrawImperativeAPI): () => void;
  /** Title sync and pagehide flush; returns a cleanup. */
  start(): () => void;
};

type Live = { elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles };

export function createPersistence(session: BoardSession, bridge: CanvasBridge, options: { onError?: (error: unknown) => void } = {}): BoardPersistence {
  const { store } = session;
  const id = session.meta.id;
  bridge.setTitle(session.meta.title);

  let live: Live | null = null;
  let memory: ConversationMemory = session.data.memory;
  let savedScene = session.data.scene;
  /** Fingerprint of the last scene seen, to tell edits apart from camera moves and selection. */
  let baseline = sceneFingerprint(session.data.scene.elements);
  /** Until the restored scene has been reported once, a change that keeps the same elements is Excalidraw's restore. */
  let restoring = true;
  const restoredIds = new Set(session.data.scene.elements.map((el) => el.id));
  let thumbFor: string | null = session.data.scene.elements.length > 0 ? baseline : null;
  let sceneDirty = false;
  let memoryDirty = false;
  let touched = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const report = (error: unknown) => options.onError?.(error);

  function schedule() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => flush(false), SAVE_DELAY_MS);
  }

  /** `forced`: saving before things went quiet (switch, pagehide, delete), so animations may be mid-way. */
  function flush(forced = true) {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!sceneDirty && !memoryDirty) return;
    const scene = live === null ? savedScene : captureScene({ ...live, settle: forced });
    savedScene = scene;
    const fingerprint = live === null ? null : sceneFingerprint(live.elements);
    const wasTouched = touched;
    sceneDirty = false;
    memoryDirty = false;
    touched = false;
    store.save({ version: 1, id, scene, memory }, { touched: wasTouched }).catch(report);
    if (fingerprint !== null && fingerprint !== thumbFor) {
      thumbFor = fingerprint;
      void renderThumb(scene.elements, live?.files ?? {}, live?.appState.viewBackgroundColor ?? "#ffffff");
    }
  }

  async function renderThumb(elements: readonly ExcalidrawElement[], files: BinaryFiles, background: string) {
    if (elements.length === 0) return;
    try {
      const blob = await exportToBlob({
        elements,
        files,
        appState: { exportBackground: true, viewBackgroundColor: background, exportWithDarkMode: false },
        maxWidthOrHeight: THUMB_SIZE,
        mimeType: "image/png",
        exportPadding: 16,
      });
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unreadable thumbnail")));
        reader.onerror = () => reject(reader.error ?? new Error("Unreadable thumbnail"));
        reader.readAsDataURL(blob);
      });
      await store.saveThumb(id, dataUrl);
    } catch (error) {
      report(error);
    }
  }

  function onMemory(next: ConversationMemory) {
    const before = memory.transcript;
    memory = next;
    memoryDirty = true;
    // A new or changed line in the conversation counts as an edit; suggestions coming and going do not.
    if (next.transcript.length !== before.length || next.transcript.at(-1)?.text !== before.at(-1)?.text) touched = true;
    schedule();
  }

  function attach(api: ExcalidrawImperativeAPI) {
    const unsubscribe = api.onChange((elements, appState, files) => {
      live = { elements, appState, files };
      const fingerprint = sceneFingerprint(elements);
      if (restoring) {
        restoring = false;
        const kept = savableElements(elements);
        if (fingerprint !== baseline && kept.length === restoredIds.size && kept.every((el) => restoredIds.has(el.id))) {
          // restore() can bump versions while repairing text and bindings; that is not an edit.
          baseline = fingerprint;
          thumbFor = fingerprint;
          return;
        }
      }
      if (fingerprint !== baseline) {
        baseline = fingerprint;
        touched = true;
      }
      sceneDirty = true;
      schedule();
    });
    return () => {
      unsubscribe();
      flush();
    };
  }

  function start() {
    const offBridge = bridge.subscribeTitle((title) => {
      if (store.get(id)?.title !== title) store.rename(id, title).catch(report);
    });
    const offStore = store.subscribe(() => {
      const title = store.get(id)?.title;
      if (title !== undefined && title !== bridge.getTitle()) bridge.setTitle(title);
    });
    const onHide = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      offBridge();
      offStore();
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }

  session.handle.flush = flush;
  return { initialScene: initialDataOf(session.data.scene), conversation: { memory: session.data.memory, onMemory }, attach, start };
}
