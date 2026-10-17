// Contract between the UI (canvas + shell) and the conversation engine (voice + agent).
// The UI implements BoardBridge; the engine implements useConversation in ./useConversation.ts.
import type { BoardOp, BoardSummary } from "../../shared/board";

export type ConversationPhase =
  | { kind: "idle" }
  | { kind: "connecting" }
  /** Mic open, waiting for or hearing the user. */
  | { kind: "listening" }
  /** User turn ended; waiting for the agent. */
  | { kind: "thinking" }
  /** Assistant audio is playing. The user can still talk to interrupt. */
  | { kind: "speaking" }
  | { kind: "error"; message: string };

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** False while the text is still streaming in. */
  final: boolean;
};

/** Implemented by the canvas. All methods are synchronous and must not throw on unknown ids. */
export interface BoardBridge {
  getSummary(): BoardSummary;
  apply(op: BoardOp): void;
  /** Show a placeholder (for example "Generating image…") until clearPending is called with the same id. */
  showPending(args: { id: string; label: string }): void;
  clearPending(id: string): void;
}

export interface Conversation {
  phase: ConversationPhase;
  /** True while the agent is drawing. Independent of phase: the user can keep talking while it sketches. */
  sketching: boolean;
  /** Current tappable next-step ideas from the agent (0-3). */
  suggestions: string[];
  /** Send a suggestion as a user turn and clear the chips. */
  pickSuggestion(text: string): void;
  /** Final and in-progress turns, oldest first. */
  transcript: TranscriptEntry[];
  /** Live partial transcript of what the user is saying right now, or "". */
  partial: string;
  /** Whether the server has Gradium configured. When false, only typing works. */
  voiceAvailable: boolean;
  /** Mic input level 0..1, pushed about 30 times per second while listening. Returns an unsubscribe function. */
  subscribeLevel(listener: (level: number) => void): () => void;
  /** Same for assistant output level while speaking. */
  subscribeOutputLevel(listener: (level: number) => void): () => void;
  startVoice(): Promise<void>;
  stopVoice(): void;
  /** Send a typed message as a user turn. Works with or without voice. */
  sendText(text: string): void;
  /** Stop assistant speech and cancel the in-flight agent turn. */
  interrupt(): void;
}
