// The mic switch. Off reads "Talk"; on, it takes the accent tint and shows a red live dot plus a
// small level meter driven straight from the mic level through refs, so React never re-renders on sound.
// While live, a mute button sits beside it: muted, the meter goes flat, the dot goes grey and the button reads "Muted".
import { useEffect, useRef } from "react";
import type { Conversation } from "../conversation/types";
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  MicIcon,
  MicOffIcon,
} from "./icons";

export type MicState = "off" | "connecting" | "live" | "error" | "disabled";

export function micState(
  conversation: Pick<Conversation, "phase" | "voiceAvailable">,
): MicState {
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
  const { subscribeLevel, muted } = conversation;
  const listening = state === "live" && !muted;

  useEffect(() => {
    if (!listening) return;
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
      for (const bar of bars)
        if (bar instanceof HTMLElement) bar.style.transform = "";
    };
  }, [listening, subscribeLevel]);

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
      data-muted={state === "live" && muted}
      aria-pressed={state === "live"}
      aria-disabled={state === "disabled" || state === "connecting"}
      title={
        state === "disabled"
          ? "Voice is off on this server. Type instead."
          : state === "live"
            ? "Stop listening"
            : undefined
      }
      onClick={onClick}
    >
      <span className="mic-glyph" aria-hidden="true">
        <span className="mic-icon">
          {state === "error" ? (
            <AlertIcon />
          ) : state === "disabled" ? (
            <MicOffIcon />
          ) : (
            <MicIcon />
          )}
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

/** Keyboard shortcut for mute. The canvas engine binds no tool to M. */
export const MUTE_KEY = "m";

/** Mute stays in the voice session (instant to undo); typing, chips and drawing keep working. */
export function MuteButton({
  muted,
  onToggle,
}: {
  muted: boolean;
  onToggle: () => void;
}) {
  const hint = muted ? "Unmute (M)" : "Mute (M)";
  return (
    <button
      type="button"
      className="mute"
      data-muted={muted}
      aria-pressed={muted}
      aria-label={muted ? "Unmute microphone" : "Mute microphone"}
      aria-keyshortcuts="M"
      title={hint}
      onClick={onToggle}
    >
      <span className="mute-glyph" aria-hidden="true">
        <MicIcon className="mute-on" />
        <MicOffIcon className="mute-off" />
      </span>
      <span className="mute-label">
        <span>Muted</span>
      </span>
    </button>
  );
}

/** Shorten long OS names: "MacBook Pro Microphone (Built-in)" reads as "MacBook Pro Microphone". */
function micName(label: string) {
  return label.replace(/\s*\([^)]*\)\s*$/, "") || label;
}

/** Which mic to use: a pill naming the current mic, and a menu above the bar. Talk opens the same menu when no mic is chosen yet. */
export function MicPicker({ conversation }: { conversation: Conversation }) {
  const { micDevices, micDevice, micMenu, closeMicMenu } = conversation;
  const rootRef = useRef<HTMLDivElement>(null);
  const current = micDevices.find((device) => device.id === micDevice);
  const open = micMenu !== "closed";

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMicMenu();
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMicMenu();
    };
    // Capture phase: the canvas swallows Escape before it bubbles to the window.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, closeMicMenu]);

  useEffect(() => {
    if (micMenu !== "open") return;
    const target =
      rootRef.current?.querySelector<HTMLButtonElement>(
        '.mic-option[aria-checked="true"]',
      ) ?? rootRef.current?.querySelector<HTMLButtonElement>(".mic-option");
    target?.focus();
  }, [micMenu]);

  return (
    <div className="mic-picker" ref={rootRef}>
      <button
        type="button"
        className="mic-picker-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={current ? `Microphone: ${current.label}` : "Choose a microphone"}
        onClick={() =>
          open ? conversation.closeMicMenu() : conversation.openMicMenu()
        }
      >
        <span className="mic-picker-label">
          {current ? micName(current.label) : "Choose mic"}
        </span>
        <ChevronDownIcon aria-hidden="true" />
      </button>
      {open && (
        <div className="mic-menu" role="menu" aria-label="Microphone">
          <p className="mic-menu-title">Which microphone?</p>
          {micMenu === "loading" ? (
            <p className="mic-menu-empty">Looking for microphones…</p>
          ) : micDevices.length === 0 ? (
            <p className="mic-menu-empty">
              No microphones found. Allow mic access in the browser, then try
              again.
            </p>
          ) : (
            micDevices.map((device) => (
              <button
                key={device.id}
                type="button"
                role="menuitemradio"
                className="mic-option"
                aria-checked={device.id === micDevice}
                onClick={() => conversation.pickMic(device.id)}
              >
                <span>{device.label}</span>
                {device.id === micDevice && <CheckIcon aria-hidden="true" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
