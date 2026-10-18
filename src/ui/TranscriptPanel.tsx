// Collapsible history of the conversation, newest at the bottom. Live speech arrives as many short phrases; a run of
// them from one speaker reads as one paragraph under one name, like a comment in an activity feed.
import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../conversation/types";
import { CloseIcon } from "./icons";

type Turn = { id: string; role: TranscriptEntry["role"]; entries: TranscriptEntry[] };

function turnsOf(entries: readonly TranscriptEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    const last = turns.at(-1);
    if (last !== undefined && last.role === entry.role) last.entries.push(entry);
    else turns.push({ id: entry.id, role: entry.role, entries: [entry] });
  }
  return turns;
}

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
        <button type="button" className="ghost-btn" onClick={onClose} aria-label="Close conversation">
          <CloseIcon />
        </button>
      </header>
      {entries.length === 0 ? (
        <p className="transcript-empty">Nothing yet. What you say shows up here.</p>
      ) : (
        <ol className="transcript-list" ref={listRef}>
          {turnsOf(entries).map((turn) => (
            <li key={turn.id} className="turn" data-role={turn.role}>
              <span className="turn-who">{turn.role === "user" ? "You" : "Partner"}</span>
              <p className="turn-text">
                {turn.entries.map((entry, index) => (
                  <span key={entry.id} data-final={entry.final}>
                    {index > 0 ? " " : ""}
                    {entry.text.trim()}
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
