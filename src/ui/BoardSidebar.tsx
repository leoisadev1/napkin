// Left sidebar listing boards, most recently edited first. Create, open, rename inline, delete with confirm and undo.
// A drawer over the canvas on phones; a column beside it on wider screens.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BoardMeta, BoardId } from "../boards/schema";
import { TITLE_MAX } from "../boards/schema";
import "./boards.css";

type Props = {
  boards: readonly BoardMeta[];
  thumbs: ReadonlyMap<BoardId, string>;
  activeId: BoardId | null;
  open: boolean;
  /** Drawer over the canvas (phones) rather than a column beside it. */
  drawer: boolean;
  onToggle: (open: boolean) => void;
  onOpen: (id: BoardId) => void;
  onCreate: () => void;
  onRename: (id: BoardId, title: string) => void;
  onDelete: (id: BoardId) => void;
  /** Set while a just-deleted board can still be brought back. */
  undo: { title: string; onUndo: () => void } | null;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h ago`;
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);
  return now;
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2" y="2.75" width="12" height="10.5" rx="2" />
      <path d="M6.25 2.75v10.5" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="12.5" cy="8" r="1.1" />
    </svg>
  );
}

function BoardRow({
  board,
  thumb,
  active,
  now,
  onOpen,
  onRename,
  onDelete,
}: {
  board: BoardMeta;
  thumb: string | undefined;
  active: boolean;
  now: number;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "menu" | "renaming" | "confirming">("idle");
  const [draft, setDraft] = useState(board.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (mode === "renaming") inputRef.current?.select();
  }, [mode]);

  // Clicking anywhere else closes the menu or the delete confirmation.
  useEffect(() => {
    if (mode !== "menu" && mode !== "confirming") return;
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
          <BoardThumb src={thumb} />
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
        <button
          type="button"
          className="board-row-main"
          aria-current={active ? "page" : undefined}
          onClick={onOpen}
          onDoubleClick={startRename}
          title={board.title}
        >
          <BoardThumb src={thumb} />
          <span className="board-row-text">
            <span className="board-row-title">{board.title}</span>
            <span className="board-row-time">Edited {relativeTime(board.updatedAt, now)}</span>
          </span>
        </button>
      )}
      {mode !== "renaming" && (
        <button
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
        <div className="board-menu" role="menu">
          <button type="button" role="menuitem" onClick={startRename}>
            Rename
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => setMode("confirming")}>
            Delete…
          </button>
        </div>
      )}
      {mode === "confirming" && (
        <div className="board-menu board-confirm" role="alertdialog" aria-label={`Delete ${board.title}?`}>
          <p>Delete this board? Its drawing and conversation go with it.</p>
          <div className="board-confirm-actions">
            <button type="button" onClick={() => setMode("idle")}>
              Cancel
            </button>
            <button
              type="button"
              className="danger solid"
              // Focus lands on Delete so Enter confirms and Escape (below) backs out.
              ref={(el) => el?.focus()}
              onKeyDown={(event) => event.key === "Escape" && setMode("idle")}
              onClick={() => {
                setMode("idle");
                onDelete();
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function BoardThumb({ src }: { src: string | undefined }) {
  return <span className="board-thumb">{src !== undefined && <img src={src} alt="" draggable={false} />}</span>;
}

export function BoardSidebar({ boards, thumbs, activeId, open, drawer, onToggle, onOpen, onCreate, onRename, onDelete, undo }: Props) {
  const now = useNow(30_000);
  // Wide screens keep a slim rail when collapsed; phones hide the drawer entirely behind a floating button.
  const rail = !open && !drawer;

  return (
    <>
      {drawer && open && <div className="boards-scrim" onClick={() => onToggle(false)} aria-hidden="true" />}
      <nav className="boards-sidebar" data-open={open} data-drawer={drawer} aria-label="Boards" inert={drawer && !open}>
        <header className="boards-header">
          {rail ? (
            <button type="button" className="boards-icon-btn" aria-label="Show boards" title="Show boards ([)" onClick={() => onToggle(true)}>
              <SidebarIcon />
            </button>
          ) : (
            <span className="boards-heading">Boards</span>
          )}
          <button type="button" className="boards-icon-btn" aria-label="New board" title="New board (C)" onClick={onCreate}>
            <PlusIcon />
          </button>
          {!rail && (
            <button type="button" className="boards-icon-btn" aria-label="Hide boards" title="Hide boards ([)" onClick={() => onToggle(false)}>
              <SidebarIcon />
            </button>
          )}
        </header>
        {!rail && (
          <ul className="boards-list">
            {boards.map((board) => (
              <BoardRow
                key={board.id}
                board={board}
                thumb={thumbs.get(board.id)}
                active={board.id === activeId}
                now={now}
                onOpen={() => onOpen(board.id)}
                onRename={(title) => onRename(board.id, title)}
                onDelete={() => onDelete(board.id)}
              />
            ))}
          </ul>
        )}
      </nav>
      {drawer && !open && (
        <button type="button" className="boards-reveal" aria-label="Show boards" onClick={() => onToggle(true)}>
          <SidebarIcon />
        </button>
      )}
      {undo !== null && (
        <div className="boards-undo" role="status">
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
