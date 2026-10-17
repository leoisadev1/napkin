// The voice control. One object with six readable states; sound drives its halo directly through refs
// (about 30 updates a second), so React never re-renders on level changes.
import { useEffect, useRef } from "react";
import type { Conversation } from "../conversation/types";
import { AlertIcon, MicIcon, MicOffIcon, StopIcon } from "./icons";
import { LABELS, ORB_HINTS, orbState } from "./orb";

export function VoiceOrb({ conversation }: { conversation: Conversation }) {
  const state = orbState(conversation);
  const haloRef = useRef<HTMLSpanElement>(null);
  const rippleRef = useRef<HTMLSpanElement>(null);
  const barsRef = useRef<HTMLSpanElement>(null);
  const { subscribeLevel, subscribeOutputLevel } = conversation;

  useEffect(() => {
    if (state !== "listening" && state !== "speaking") return;
    let smooth = 0;
    const halo = haloRef.current;
    const ripple = rippleRef.current;
    const source = state === "listening" ? subscribeLevel : subscribeOutputLevel;
    const unsubscribe = source((raw) => {
      const level = Math.min(1, Math.max(0, raw));
      smooth += (level - smooth) * (level > smooth ? 0.5 : 0.18);
      if (state === "listening" && halo !== null) {
        halo.style.transform = `scale(${1 + smooth * 0.55})`;
        halo.style.opacity = String(0.25 + smooth * 0.6);
      }
      if (state === "speaking") {
        if (ripple !== null) {
          ripple.style.transform = `scale(${1.04 + smooth * 0.42})`;
          ripple.style.opacity = String(0.2 + smooth * 0.5);
        }
        const bars = barsRef.current?.children;
        if (bars !== undefined) {
          for (let i = 0; i < bars.length; i++) {
            const bar = bars[i];
            if (!(bar instanceof HTMLElement)) continue;
            const shape = [0.55, 1, 0.8, 0.45][i] ?? 0.6;
            bar.style.transform = `scaleY(${0.25 + smooth * shape * (0.85 + 0.3 * Math.random())})`;
          }
        }
      }
    });
    return () => {
      unsubscribe();
      for (const el of [halo, ripple]) {
        if (el !== null) {
          el.style.transform = "";
          el.style.opacity = "";
        }
      }
    };
  }, [state, subscribeLevel, subscribeOutputLevel]);

  const onClick = () => {
    switch (state) {
      case "idle":
      case "error":
        void conversation.startVoice();
        return;
      case "listening":
        conversation.stopVoice();
        return;
      case "thinking":
      case "speaking":
        conversation.interrupt();
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
      className="orb"
      data-state={state}
      aria-label={LABELS[state]}
      title={state === "disabled" ? ORB_HINTS.disabled : undefined}
      aria-disabled={state === "disabled" || state === "connecting"}
      aria-pressed={state === "listening" || state === "speaking" || state === "thinking"}
      onClick={onClick}
    >
      <span className="orb-halo" ref={haloRef} aria-hidden="true" />
      <span className="orb-ripple" ref={rippleRef} aria-hidden="true" />
      <span className="orb-ring" aria-hidden="true" />
      <span className="orb-core" aria-hidden="true">
        <span className="orb-glyph" data-glyph="mic">
          <MicIcon size={26} strokeWidth={1.9} />
        </span>
        <span className="orb-glyph" data-glyph="off">
          <MicOffIcon size={24} strokeWidth={1.9} />
        </span>
        <span className="orb-glyph" data-glyph="alert">
          <AlertIcon size={24} strokeWidth={1.9} />
        </span>
        <span className="orb-glyph" data-glyph="dots">
          <span className="orb-dots">
            <i />
            <i />
            <i />
          </span>
        </span>
        <span className="orb-glyph" data-glyph="wave">
          <span className="orb-bars" ref={barsRef}>
            <i />
            <i />
            <i />
            <i />
          </span>
        </span>
        <span className="orb-glyph" data-glyph="stop">
          <StopIcon size={22} />
        </span>
      </span>
    </button>
  );
}
