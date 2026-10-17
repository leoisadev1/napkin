// Orb state vocabulary shared by the orb and the dock status line.
import type { Conversation, ConversationPhase } from "../conversation/types";

export type OrbState = ConversationPhase["kind"] | "disabled";

export function orbState(conversation: Pick<Conversation, "phase" | "voiceAvailable">): OrbState {
  return conversation.voiceAvailable ? conversation.phase.kind : "disabled";
}

export const LABELS: Record<OrbState, string> = {
  idle: "Start talking",
  connecting: "Connecting microphone",
  listening: "Stop listening",
  thinking: "Interrupt",
  speaking: "Interrupt",
  error: "Retry voice",
  disabled: "Voice is unavailable",
};

export const ORB_HINTS: Record<OrbState, string> = {
  idle: "Tap to talk",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Sketching…",
  speaking: "Speaking · tap or Esc to cut in",
  error: "Voice hit a snag · tap to retry",
  disabled: "Voice is off on this server · type instead",
};

