// Multiple boards: the store, the URL, the sidebar, and one App per opened board. App is keyed by board id, so
// switching boards unmounts the old canvas, bridge and conversation (aborting its agent requests) and mounts fresh
// ones; nothing from the old board can reach the new one.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ComponentType } from "react";
import { MOD } from "../ui/BoardChrome";
import { BoardSidebar } from "../ui/BoardSidebar";
import { useMediaQuery } from "../ui/useMediaQuery";
import type { BoardSession } from "./persistence";
import type { RemovedBoard } from "./store";
import type { BoardStore } from "./store";
import type { BoardId, BoardMeta } from "./schema";
import { navigateToBoard, parseRoute, subscribeRoute } from "./router";

const SIDEBAR_KEY = "rtw:sidebar";
const UNDO_MS = 8000;

/** True when a key press belongs to whatever has focus, or to text being edited on the board. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function readSidebarPref(): boolean | null {
  try {
    const value = window.localStorage.getItem(SIDEBAR_KEY);
    return value === "open" ? true : value === "closed" ? false : null;
  } catch {
    return null;
  }
}

function useRoute() {
  const path = useSyncExternalStore(subscribeRoute, () => window.location.pathname);
  return useMemo(() => parseRoute(path), [path]);
}

/** What an open board can do to the rest of the workspace: the ⌘K menu and the title bar drive these. */
export type Workspace = {
  boards: readonly BoardMeta[];
  sidebar: { open: boolean; drawer: boolean; setOpen: (open: boolean) => void };
  /** The ⌘K menu, owned here so the sidebar's search row can open it. */
  menu: { open: boolean; setOpen: (open: boolean) => void };
  create: () => void;
  open: (id: BoardId) => void;
  rename: (id: BoardId, title: string) => void;
  remove: (id: BoardId) => void;
};

export type BoardScreenProps = { board: BoardSession; workspace: Workspace };

export function BoardsApp({ store, Screen, onError }: { store: BoardStore; Screen: ComponentType<BoardScreenProps>; onError: (error: unknown) => void }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const route = useRoute();
  const [session, setSession] = useState<BoardSession | null>(null);
  const [undo, setUndo] = useState<{ removed: RemovedBoard; timer: number } | null>(null);
  // Below 960px a docked sidebar would squeeze the board's panel under the width its chrome needs (the dock would
  // run into the zoom bar), so the sidebar becomes a drawer over a full-width board instead, as Linear does.
  const drawer = useMediaQuery("(max-width: 959px)");
  const [pref, setPref] = useState(readSidebarPref);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const open = drawer ? drawerOpen : (pref ?? true);

  useEffect(() => {
    store.init().catch(onError);
  }, [store, onError]);

  // Resolve the URL to a board: open it, or fall back to the most recent board (creating one if there are none).
  const ready = snapshot.status === "ready";
  const routeId = route.kind === "board" ? route.id : null;
  const openId = session?.meta.id ?? null;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    if (routeId === null || store.get(routeId) === undefined) {
      const latest = store.latest();
      if (latest !== undefined) navigateToBoard(latest.id, { replace: true });
      else
        store
          .create()
          .then((board) => !cancelled && navigateToBoard(board.id, { replace: true }))
          .catch(onError);
      return () => {
        cancelled = true;
      };
    }
    if (openId === routeId) return;
    store
      .load(routeId)
      .then((data) => {
        const meta = store.get(routeId);
        if (!cancelled && meta !== undefined) setSession({ store, meta, data, handle: { flush: () => {} } });
      })
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [ready, routeId, openId, store, onError]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (drawer) {
        setDrawerOpen(next);
        return;
      }
      setPref(next);
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? "open" : "closed");
      } catch {
        // Private mode: the choice lasts for this page only.
      }
    },
    [drawer],
  );

  const openBoard = useCallback(
    (id: BoardId) => {
      navigateToBoard(id);
      if (drawer) setOpen(false);
    },
    [drawer, setOpen],
  );

  const createBoard = useCallback(() => {
    store
      .create()
      .then((board) => openBoard(board.id))
      .catch(onError);
  }, [store, openBoard, onError]);

  const deleteBoard = useCallback(
    (id: BoardId) => {
      const active = session?.meta.id === id;
      // Save the open board's last edits first, so undo brings back exactly what was there.
      if (active) session.handle.flush();
      const next = (snapshot.status === "ready" ? snapshot.boards : []).find((board) => board.id !== id);
      store
        .remove(id)
        .then((removed) => {
          if (removed === null) return;
          setUndo((previous) => {
            if (previous !== null) window.clearTimeout(previous.timer);
            return { removed, timer: window.setTimeout(() => setUndo(null), UNDO_MS) };
          });
          if (!active) return;
          if (next !== undefined) navigateToBoard(next.id, { replace: true });
          else store.create().then((board) => navigateToBoard(board.id, { replace: true }), onError);
        })
        .catch(onError);
    },
    [session, snapshot, store, onError],
  );

  const undoDelete = useCallback(() => {
    if (undo === null) return;
    window.clearTimeout(undo.timer);
    setUndo(null);
    store
      .restore(undo.removed)
      .then(() => navigateToBoard(undo.removed.meta.id))
      .catch(onError);
  }, [undo, store, onError]);

  // C makes a new board, [ shows or hides the list. Ignored while typing, with modifiers, or while editing board text.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape closes the drawer and stops there, so it doesn't also interrupt the partner. A field or a row menu in
      // the drawer keeps Escape for itself.
      const inMenu = event.target instanceof Element && event.target.closest('[role="menu"]') !== null;
      if (event.key === "Escape" && drawer && open && !inMenu && !isTyping(event.target)) {
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector(".excalidraw-textEditorContainer textarea") !== null) return;
      if (event.key.toLowerCase() === "c" && !event.shiftKey) {
        event.preventDefault();
        createBoard();
      } else if (event.key === "[") {
        event.preventDefault();
        setOpen(!open);
      }
    };
    // Capture phase: Excalidraw handles keys globally and stops some (Escape) before they bubble to the window.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [createBoard, setOpen, open, drawer]);

  const boards = useMemo(() => (snapshot.status === "ready" ? snapshot.boards : []), [snapshot]);
  const activeId = session?.meta.id ?? null;
  const renameBoard = useCallback((id: BoardId, title: string) => void store.rename(id, title).catch(onError), [store, onError]);
  const workspace = useMemo(
    (): Workspace => ({ boards, sidebar: { open, drawer, setOpen }, menu: { open: menuOpen, setOpen: setMenuOpen }, create: createBoard, open: openBoard, rename: renameBoard, remove: deleteBoard }),
    [boards, open, drawer, setOpen, menuOpen, createBoard, openBoard, renameBoard, deleteBoard],
  );

  return (
    <div className="boards-shell" data-sidebar={open ? "open" : "closed"} data-drawer={drawer}>
      <BoardSidebar
        boards={boards}
        activeId={activeId}
        open={open}
        drawer={drawer}
        mod={MOD}
        onToggle={setOpen}
        onSearch={() => {
          if (drawer) setOpen(false);
          setMenuOpen(true);
        }}
        onOpen={openBoard}
        onCreate={createBoard}
        onRename={renameBoard}
        onDelete={deleteBoard}
        undo={undo === null ? null : { title: undo.removed.meta.title, onUndo: undoDelete }}
      />
      <main className="boards-main" inert={drawer && open}>{session !== null && <Screen key={session.meta.id} board={session} workspace={workspace} />}</main>
    </div>
  );
}
