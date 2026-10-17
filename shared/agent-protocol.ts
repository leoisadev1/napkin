// Wire protocol for POST /api/agent. Request is JSON; response is NDJSON, one AgentEvent per line.
import { z } from "zod";
import { BoardOp, BoardSummary } from "./board";

export const ChatTurn = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(4000),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

export const AgentRequest = z.object({
  /** What the user just said (a live phrase while they are still talking, or a full turn) or typed. */
  utterance: z.string().min(1).max(4000),
  /**
   * "live": a phrase streamed while the user keeps talking; draw only what this phrase adds, fast, no reply.
   * "turn": an explicit typed message or a tapped suggestion.
   * "suggest": the user paused; draw nothing, only return a fresh `suggestions` event (utterance is the last stretch said).
   * "refine": the user paused; restructure what was sketched live into proper diagrams, fix mis-heard labels, fill gaps,
   *   optionally add one concept image. Runs with more reasoning than live; may delete and replace items.
   */
  mode: z.enum(["live", "turn", "suggest", "refine"]),
  /** Recent conversation, oldest first, at most 20 turns. */
  history: z.array(ChatTurn).max(20),
  board: BoardSummary,
});
export type AgentRequest = z.infer<typeof AgentRequest>;

export const AgentEvent = z.discriminatedUnion("type", [
  /** Optional short reply text. Not spoken by default; the UI may show it quietly. */
  z.object({ type: z.literal("say"), text: z.string() }),
  /** 0-3 short next-step ideas (max ~48 chars each) the user can tap to send as a turn. Replaces previous suggestions. */
  z.object({ type: z.literal("suggestions"), items: z.array(z.string().min(1).max(60)).max(3) }),
  /** One validated board operation, applied immediately in arrival order. */
  z.object({ type: z.literal("op"), op: BoardOp }),
  /** Long-running work started (for example image generation) so the UI can show a placeholder. */
  z.object({ type: z.literal("pending"), id: z.string(), label: z.string() }),
  z.object({ type: z.literal("pending_done"), id: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** GET /api/status: what the server can do right now for this browser session. */
export const ServerStatus = z.object({
  chatgpt: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("signed_in"), email: z.string().nullable(), plan: z.string().nullable() }),
    z.object({ kind: z.literal("signed_out") }),
  ]),
  /** True when a dev-only LLM fallback is configured, so the app works without ChatGPT sign-in locally. */
  devLlm: z.boolean(),
  /** True when GRADIUM_API_KEY is configured on the server. */
  voice: z.boolean(),
});
export type ServerStatus = z.infer<typeof ServerStatus>;
