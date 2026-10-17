// Wire protocol for POST /api/agent. Request is JSON; response is NDJSON, one AgentEvent per line.
import { z } from "zod";
import { BoardOp, BoardSummary } from "./board";

export const ChatTurn = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(4000),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

export const AgentRequest = z.object({
  /** What the user just said (final transcript of the turn) or typed. */
  utterance: z.string().min(1).max(4000),
  /** Recent conversation, oldest first, at most 20 turns. */
  history: z.array(ChatTurn).max(20),
  board: BoardSummary,
});
export type AgentRequest = z.infer<typeof AgentRequest>;

export const AgentEvent = z.discriminatedUnion("type", [
  /** A chunk of the short spoken reply. Concatenate in order; the client streams it to TTS. */
  z.object({ type: z.literal("say"), text: z.string() }),
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
