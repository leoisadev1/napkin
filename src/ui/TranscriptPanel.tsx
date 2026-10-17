// Collapsible history of the conversation, newest at the bottom.
import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../conversation/types";
import { CloseIcon } from "./icons";

export function TranscriptPanel({ open, entries, onClose }: { open: boolean; entries: readonly TranscriptEntry[]; onClose: () => void }) {
  const listRef = useRef<HTMLOListElement>(null);
  const last = entries.at(-1);

  useEffect(() => {
    const list = listRef.current;
    if (list !== null && open) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [open, last?.text, entries.length]);

  return (
    <aside className="transcript" data-open={open} aria-label="Conversation" aria-hidden={!open} inert={!open}>
      <header className="transcript-head">
        <h2>Conversation</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close conversation">
          <CloseIcon size={18} />
        </button>
      </header>
      {entries.length === 0 ? (
        <p className="transcript-empty">Nothing yet. What you say shows up here.</p>
      ) : (
        <ol className="transcript-list" ref={listRef}>
          {entries.map((entry, index) => (
            // Live speech arrives as many short phrases; label a run of them once.
            <li key={entry.id} className="turn" data-role={entry.role} data-final={entry.final} data-continues={entries[index - 1]?.role === entry.role}>
              {entries[index - 1]?.role !== entry.role && <span className="turn-who">{entry.role === "user" ? "You" : "Partner"}</span>}
              <p className="turn-text">{entry.text}</p>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
