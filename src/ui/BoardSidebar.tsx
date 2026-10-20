// Left sidebar, Linear style: a workspace header, search and new board, then every board, most recently edited first.
// Rows open on click and rename on double-click or from their menu. Delete is immediate and undoable from a toast.
// A drawer over the canvas on phones; a column beside it on wider screens that collapses away entirely.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BoardId, BoardMeta } from "../boards/schema";
import { TITLE_MAX } from "../boards/schema";
import { BoardIcon, Mark, MoreIcon, NewBoardIcon, PencilIcon, SearchIcon, SidebarIcon, TrashIcon } from "./icons";
import { MOD } from "./BoardChrome";
import { Keys } from "./Keys";
import "./boards.css";

type Props = {
  boards: readonly BoardMeta[];
  activeId: BoardId | null;
  open: boolean;
  /** Drawer over the canvas (phones) rather than a column beside it. */
  drawer: boolean;
  mod: string;
  onToggle: (open: boolean) => void;
  onSearch: () => void;
  onOpen: (id: BoardId) => void;
  onCreate: () => void;
  onRename: (id: BoardId, title: string) => void;
  onDelete: (id: BoardId) => void;
  /** Set while a just-deleted board can still be brought back. */
  undo: { title: string; onUndo: () => void } | null;
};

function BoardRow({
  board,
  active,
  visible,
  onOpen,
  onRename,
  onDelete,
}: {
  board: BoardMeta;
  active: boolean;
  /** False while the sidebar is collapsed or the drawer closed; any open menu or rename is dropped. */
  visible: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "menu" | "renaming">("idle");
  const [draft, setDraft] = useState(board.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode === "renaming") inputRef.current?.select();
    if (mode === "menu") firstItemRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (!visible) setMode("idle");
  }, [visible]);

  /** Closes the menu and hands focus back to the button that opened it. */
  const closeMenu = () => {
    setMode("idle");
    moreRef.current?.focus();
  };

  // Arrow keys move between the items (wrapping), Escape closes. Handled here so the drawer keeps its own Escape.
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const at = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  // Clicking anywhere else closes the menu.
  useEffect(() => {
    if (mode !== "menu") return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rowRef.current?.contains(event.target)) return;
      setMode("idle");
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [mode]);

  const startRename = () => {
    setDraft(board.title);
    setMode("renaming");
  };
  const commit = () => {
    setMode("idle");
    if (draft.trim() !== board.title) onRename(draft);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") setMode("idle");
  };

  return (
    <li ref={rowRef} className="board-row" data-active={active} data-mode={mode}>
      {mode === "renaming" ? (
        <div className="board-row-main">
          <BoardIcon />
          <input
            ref={inputRef}
            className="board-rename"
            value={draft}
            maxLength={TITLE_MAX}
            aria-label="Board name"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
          />
        </div>
      ) : (
        <button type="button" className="board-row-main" aria-current={active ? "page" : undefined} onClick={onOpen} onDoubleClick={startRename}>
          <BoardIcon />
          <span className="board-row-title">{board.title}</span>
        </button>
      )}
      {mode !== "renaming" && (
        <button
          ref={moreRef}
          type="button"
          className="board-row-more"
          aria-label={`Actions for ${board.title}`}
          aria-haspopup="menu"
          aria-expanded={mode === "menu"}
          onClick={() => setMode(mode === "menu" ? "idle" : "menu")}
        >
          <MoreIcon />
        </button>
      )}
      {mode === "menu" && (
        <div className="board-menu" role="menu" aria-label={`Actions for ${board.title}`} onKeyDown={onMenuKeyDown}>
          <button ref={firstItemRef} type="button" role="menuitem" onClick={startRename}>
            <PencilIcon />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              setMode("idle");
              onDelete();
            }}
          >
            <TrashIcon />
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

export function BoardSidebar({ boards, activeId, open, drawer, mod, onToggle, onSearch, onOpen, onCreate, onRename, onDelete, undo }: Props) {
  const navRef = useRef<HTMLElement>(null);

  // The drawer is modal: focus moves in when it opens (to the open board) and returns to the trigger when it closes.
  // The board behind it is made inert by the shell.
  useEffect(() => {
    if (!drawer || !open) return;
    const previous = document.activeElement;
    const nav = navRef.current;
    (nav?.querySelector<HTMLElement>('[aria-current="page"]') ?? nav?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [drawer, open]);
  return (
    <>
      {drawer && <div className="boards-scrim" data-open={open} onClick={() => onToggle(false)} aria-hidden="true" />}
      <nav ref={navRef} className="boards-sidebar" data-open={open} data-drawer={drawer} aria-label="Boards" inert={!open}>
        <div className="boards-inner">
          <header className="boards-header">
            <span className="boards-workspace">
              <Mark size={18} />
              <span className="boards-workspace-name">Napkin</span>
            </span>
            <button type="button" className="boards-icon-btn" aria-label="Hide sidebar" aria-keyshortcuts="Meta+B Control+B [" onClick={() => onToggle(false)}>
              <SidebarIcon />
              <span className="tip tip-down" role="presentation">
                Hide sidebar<Keys combo={`${MOD} B`} />
              </span>
            </button>
            <button type="button" className="boards-icon-btn boards-new" aria-label="New board" aria-keyshortcuts="C" onClick={onCreate}>
              <NewBoardIcon />
              <span className="tip tip-down" role="presentation">
                New board<Keys combo="C" />
              </span>
            </button>
          </header>
          <div className="boards-nav">
            <button type="button" className="boards-nav-item" onClick={onSearch}>
              <SearchIcon />
              <span className="boards-nav-label">Search</span>
              <Keys combo={`${mod} K`} />
            </button>
          </div>
          <p className="boards-section">Boards</p>
          <ul className="boards-list">
            {boards.map((board) => (
              <BoardRow
                key={board.id}
                board={board}
                active={board.id === activeId}
                visible={open}
                onOpen={() => onOpen(board.id)}
                onRename={(title) => onRename(board.id, title)}
                onDelete={() => onDelete(board.id)}
              />
            ))}
          </ul>
        </div>
      </nav>
      {undo !== null && (
        <div className="boards-undo" role="status">
          <TrashIcon />
          <span className="boards-undo-text">
            Deleted <strong>{undo.title}</strong>
          </span>
          <button type="button" onClick={undo.onUndo}>
            Undo
          </button>
        </div>
      )}
    </>
  );
}
