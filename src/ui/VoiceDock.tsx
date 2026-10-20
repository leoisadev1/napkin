// Bottom-center dock: suggestion chips, the live line, and one bar with the mic switch and a text input.
import { useState } from "react";
import type { FormEvent } from "react";
import type { Conversation } from "../conversation/types";
import { PencilIcon, SendIcon } from "./icons";
import { LiveLine } from "./LiveLine";
import { MicPicker, MicToggle, micState, MuteButton } from "./MicToggle";
import { Suggestions } from "./Suggestions";

export function VoiceDock({ conversation }: { conversation: Conversation }) {
  const [draft, setDraft] = useState("");
  const mic = micState(conversation);
  // Tidying explains why things the user already saw start moving around.
  const working = conversation.refining ? "Tidying up" : conversation.sketching ? "Sketching" : null;

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
        {mic === "live" && <MuteButton muted={conversation.muted} onToggle={() => conversation.setMuted(!conversation.muted)} />}
        {mic !== "disabled" && <MicPicker conversation={conversation} />}
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
          <span className="sketching" data-active={working !== null} role="status" aria-live="polite">
            <PencilIcon size={12} strokeWidth={2} />
            <span>{working ?? ""}</span>
          </span>
          <button className="composer-send" type="submit" aria-label="Send" data-ready={draft.trim().length > 0}>
            <SendIcon strokeWidth={2} />
          </button>
        </form>
      </div>
    </div>
  );
}
