// Bottom-center dock: suggestion chips, the live line, and one bar with the mic switch and a text input.
import { useState } from "react";
import type { FormEvent } from "react";
import type { Conversation } from "../conversation/types";
import { PencilIcon, SendIcon } from "./icons";
import { LiveLine } from "./LiveLine";
import { MicToggle, micState } from "./MicToggle";
import { Suggestions } from "./Suggestions";

export function VoiceDock({ conversation }: { conversation: Conversation }) {
  const [draft, setDraft] = useState("");
  const mic = micState(conversation);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    conversation.sendText(text);
    setDraft("");
  };

  return (
    <div className="dock">
      <Suggestions suggestions={conversation.suggestions} onPick={conversation.pickSuggestion} />
      <LiveLine conversation={conversation} mic={mic} />
      <div className="bar">
        <MicToggle conversation={conversation} />
        <span className="bar-divider" aria-hidden="true" />
        <form className="composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="composer-input">
            Type a thought
          </label>
          <input
            id="composer-input"
            className="composer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={mic === "disabled" ? "Type a thought…" : "Or type a thought…"}
            autoComplete="off"
            enterKeyHint="send"
            maxLength={4000}
          />
          <span className="sketching" data-active={conversation.sketching} role="status" aria-live="polite">
            <PencilIcon size={14} strokeWidth={2} />
            <span>{conversation.sketching ? "Sketching" : ""}</span>
          </span>
          <button className="composer-send" type="submit" aria-label="Send" data-ready={draft.trim().length > 0}>
            <SendIcon size={18} strokeWidth={2} />
          </button>
        </form>
      </div>
    </div>
  );
}
