// Board title, edited inline. The agent can also rename the board through set_title.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Mark } from "./icons";

export function TitleIsland({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

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
    <div className="title-island">
      <span className="title-mark">
        <Mark size={18} />
      </span>
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
