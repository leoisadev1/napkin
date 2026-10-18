// What a conversation remembers about one board, so reopening the board keeps the partner's context.
// Stored by src/boards; parsed with zod there because it comes back from IndexedDB.
import { z } from "zod";
import { ChatTurn } from "../../shared/agent-protocol";
import { BoardOp } from "../../shared/board";

export const TranscriptEntrySchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  final: z.boolean(),
});

const DiagramOp = BoardOp.transform((op, ctx) => {
  if (op.op === "add_diagram") return op;
  ctx.issues.push({ code: "custom", message: "Expected add_diagram", input: op });
  return z.NEVER;
});
const MockupOp = BoardOp.transform((op, ctx) => {
  if (op.op === "add_mockup") return op;
  ctx.issues.push({ code: "custom", message: "Expected add_mockup", input: op });
  return z.NEVER;
});

export const ConversationMemory = z.object({
  /** Agent request history, oldest first. */
  history: z.array(ChatTurn).max(20),
  transcript: z.array(TranscriptEntrySchema).max(20),
  suggestions: z.array(z.string()).max(3),
  /** Full specs of generated diagrams and mockups; the board summary only carries their titles. */
  diagrams: z.array(DiagramOp),
  mockups: z.array(MockupOp),
  imageAttempted: z.boolean(),
});
export type ConversationMemory = z.infer<typeof ConversationMemory>;

export const EMPTY_MEMORY: ConversationMemory = { history: [], transcript: [], suggestions: [], diagrams: [], mockups: [], imageAttempted: false };

/** Optional second argument to useConversation: start from a board's memory and report changes to it. */
export type ConversationOptions = {
  memory?: ConversationMemory;
  onMemory?: (memory: ConversationMemory) => void;
};
