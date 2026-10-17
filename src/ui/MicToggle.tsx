// The mic switch. Off reads "Talk"; on, it fills like a selected Excalidraw tool and shows a red live dot plus a
// small level meter driven straight from the mic level through refs, so React never re-renders on sound.
import { useEffect, useRef } from "react";
import type { Conversation } from "../conversation/types";
import { AlertIcon, MicIcon, MicOffIcon } from "./icons";

export type MicState = "off" | "connecting" | "live" | "error" | "disabled";

export function micState(conversation: Pick<Conversation, "phase" | "voiceAvailable">): MicState {
  if (!conversation.voiceAvailable) return "disabled";
  switch (conversation.phase.kind) {
    case "idle":
    case "thinking":
      return "off";
    case "connecting":
      return "connecting";
    case "listening":
    case "speaking":
      return "live";
    case "error":
      return "error";
    default: {
      const _exhaustive: never = conversation.phase;
      return _exhaustive;
    }
  }
}

const LABELS: Record<MicState, string> = {
  off: "Talk",
  connecting: "Connecting…",
  live: "Live",
  error: "Retry",
  disabled: "Voice off",
};

const BAR_SHAPE = [0.6, 1, 0.75] as const;

export function MicToggle({ conversation }: { conversation: Conversation }) {
  const state = micState(conversation);
  const meterRef = useRef<HTMLSpanElement>(null);
  const { subscribeLevel } = conversation;

  useEffect(() => {
    if (state !== "live") return;
    const bars = meterRef.current?.children;
    let smooth = 0;
    const unsubscribe = subscribeLevel((raw) => {
      const level = Math.min(1, Math.max(0, raw));
      smooth += (level - smooth) * (level > smooth ? 0.55 : 0.2);
      if (bars === undefined) return;
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        if (!(bar instanceof HTMLElement)) continue;
        bar.style.transform = `scaleY(${0.36 + Math.min(0.64, smooth * (BAR_SHAPE[i] ?? 0.7) * 1.2)})`;
      }
    });
    return () => {
      unsubscribe();
      if (bars === undefined) return;
      for (const bar of bars) if (bar instanceof HTMLElement) bar.style.transform = "";
    };
  }, [state, subscribeLevel]);

  const onClick = () => {
    switch (state) {
      case "off":
      case "error":
        void conversation.startVoice();
        return;
      case "live":
        conversation.stopVoice();
        return;
      case "connecting":
      case "disabled":
        return;
      default: {
        const _exhaustive: never = state;
        return _exhaustive;
      }
    }
  };

  return (
    <button
      type="button"
      className="mic"
      data-state={state}
      aria-pressed={state === "live"}
      aria-disabled={state === "disabled" || state === "connecting"}
      title={state === "disabled" ? "Voice is off on this server. Type instead." : state === "live" ? "Stop listening" : undefined}
      onClick={onClick}
    >
      <span className="mic-glyph" aria-hidden="true">
        <span className="mic-icon">
          {state === "error" ? <AlertIcon size={18} strokeWidth={2} /> : state === "disabled" ? <MicOffIcon size={18} strokeWidth={2} /> : <MicIcon size={18} strokeWidth={2} />}
        </span>
        <span className="mic-meter" ref={meterRef}>
          <i />
          <i />
          <i />
        </span>
      </span>
      <span>{LABELS[state]}</span>
      {state === "live" && <span className="mic-dot" aria-hidden="true" />}
    </button>
  );
}
