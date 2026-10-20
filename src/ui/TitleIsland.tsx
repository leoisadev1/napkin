// Board title, edited inline. The agent can also rename the board through set_title, and ⌘K through renameRequest.
// While the boards sidebar is hidden (collapsed, or a closed drawer on phones) it leads with the button that shows it.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { SidebarIcon } from "./icons";
import { MOD } from "./BoardChrome";
import { Keys } from "./Keys";

type Props = {
  title: string;
  onRename: (title: string) => void;
  /** Bumped to start editing from elsewhere. */
  renameRequest: number;
  /** Set while the sidebar is out of view. */
  sidebar: { onShow: () => void } | null;
};

export function TitleIsland({ title, onRename, renameRequest, sidebar }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef(title);
  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (renameRequest === 0) return;
    setDraft(titleRef.current);
    setEditing(true);
  }, [renameRequest]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== title) onRename(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") {
      setDraft(title);
      setEditing(false);
    }
  };

  return (
    <div className="title-island" data-toggle={sidebar !== null}>
      {sidebar !== null && (
        <button type="button" className="ghost-btn title-toggle" aria-label="Show sidebar" aria-keyshortcuts="Meta+B Control+B [" onClick={sidebar.onShow}>
          <SidebarIcon />
          <span className="tip tip-down" role="presentation">
            Show sidebar<Keys combo={`${MOD} B`} />
          </span>
        </button>
      )}
      {editing ? (
        <input
          ref={inputRef}
          className="title-input"
          value={draft}
          maxLength={80}
          aria-label="Board title"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      ) : (
        <button
          type="button"
          className="title-button"
          title="Rename board"
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
        >
          {title}
        </button>
      )}
    </div>
  );
}
