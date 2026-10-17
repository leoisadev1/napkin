// Bottom-center control: captions, the orb with its status line, and the always-available text input.
import { useState } from "react";
import type { FormEvent } from "react";
import type { Conversation } from "../conversation/types";
import { Captions } from "./Captions";
import { SendIcon } from "./icons";
import { ORB_HINTS, orbState } from "./orb";
import { VoiceOrb } from "./VoiceOrb";

export function VoiceDock({ conversation }: { conversation: Conversation }) {
  const [draft, setDraft] = useState("");
  const state = orbState(conversation);
  const error = conversation.phase.kind === "error" ? conversation.phase.message : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    conversation.sendText(text);
    setDraft("");
  };

  return (
    <div className="dock">
      <Captions conversation={conversation} />
      <div className="dock-orb">
        <VoiceOrb conversation={conversation} />
        <p className="dock-hint" data-state={state} role="status">
          {error ?? ORB_HINTS[state]}
        </p>
      </div>
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="composer-input">
          Type a message to your partner
        </label>
        <input
          id="composer-input"
          className="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={conversation.voiceAvailable ? "Or type a thought…" : "Type a thought…"}
          autoComplete="off"
          enterKeyHint="send"
          maxLength={4000}
        />
        <button className="composer-send" type="submit" aria-label="Send" data-ready={draft.trim().length > 0}>
          <SendIcon size={18} strokeWidth={2} />
        </button>
      </form>
    </div>
  );
}
