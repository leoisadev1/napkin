// Switching boards tears down the old board's conversation (what App's unmount does: useConversation's cleanup calls
// stopVoice) and starts a new one from the new board's memory. Nothing the old board's agent streams afterwards may
// reach either board.
import { afterEach, expect, test } from "bun:test";
import { AgentRequest } from "../../shared/agent-protocol";
import type { BoardOp, BoardSummary } from "../../shared/board";
import { ConversationEngine } from "../conversation/engine/conversation-engine";
import { ConversationMemory } from "../conversation/memory";
import type { BoardBridge } from "../conversation/types";

type Request = { input: AgentRequest; signal: AbortSignal | null | undefined; stream: ReadableStreamDefaultController<Uint8Array> };

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

function stubAgent(): Request[] {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            requests.push({ input: AgentRequest.parse(JSON.parse(String(init?.body))), signal: init?.signal, stream });
          },
        }),
      ),
    { preconnect: original.preconnect },
  );
  return requests;
}

function emit(request: Request | undefined, event: object) {
  try {
    request?.stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
  } catch {
    // The reader cancelled the stream; a real server would see a closed socket.
  }
}

function recordingBridge(title: string) {
  const applied: BoardOp[] = [];
  const pending: string[] = [];
  const summary: BoardSummary = { title, items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1000, h: 800 } };
  const bridge: BoardBridge = {
    getSummary: () => summary,
    apply: (op) => applied.push(op),
    showPending: ({ id }) => pending.push(id),
    clearPending: () => {},
  };
  return { bridge, applied, pending };
}

const shape = (id: string, label: string): BoardOp => ({ op: "add_shape", id, shape: "box", label, color: "blue", placement: { kind: "auto" } });

test("an old board's in-flight ops never land on the new board", async () => {
  const requests = stubAgent();
  const a = recordingBridge("Board A");
  const engineA = new ConversationEngine(a.bridge);
  engineA.sendText("Draw a payment service");
  await Bun.sleep(5);
  expect(requests).toHaveLength(1);

  emit(requests[0], { type: "op", op: shape("pay", "Payment service") });
  await Bun.sleep(5);
  expect(a.applied.map((op) => op.op === "add_shape" && op.label)).toEqual(["Payment service"]);

  // Switch: the old board's conversation is torn down, then the new board mounts with its own bridge.
  const saved = ConversationMemory.parse(JSON.parse(JSON.stringify(engineA.exportMemory())));
  engineA.stopVoice();
  expect(requests[0]?.signal?.aborted).toBe(true);
  const b = recordingBridge("Board B");
  const engineB = new ConversationEngine(b.bridge);

  // The old request keeps streaming as if the server had not noticed yet.
  emit(requests[0], { type: "op", op: shape("fraud", "Fraud check") });
  emit(requests[0], { type: "pending", id: "img-1", label: "Generating image" });
  emit(requests[0], { type: "say", text: "Added fraud." });
  emit(requests[0], { type: "done" });
  await Bun.sleep(20);

  expect(b.applied).toEqual([]);
  expect(b.pending).toEqual([]);
  expect(a.applied).toHaveLength(1);
  expect(engineB.getSnapshot().transcript).toEqual([]);
  expect(engineB.getSnapshot().sketching).toBe(false);

  // Coming back to A restores its context: the transcript shows, and the next request carries the history.
  const engineA2 = new ConversationEngine(recordingBridge("Board A").bridge, { memory: saved });
  expect(engineA2.getSnapshot().transcript.map((entry) => entry.text)).toEqual(["Draw a payment service"]);
  engineA2.sendText("Now add checkout");
  await Bun.sleep(5);
  const next = requests.at(-1);
  expect(next?.input.utterance).toBe("Now add checkout");
  expect(next?.input.history.some((turn) => turn.role === "user" && turn.text === "Draw a payment service")).toBe(true);
  engineA2.stopVoice();
  engineB.stopVoice();
});

test("queued phrases of the old board are dropped, not replayed on the new one", async () => {
  const requests = stubAgent();
  const a = recordingBridge("Board A");
  const engineA = new ConversationEngine(a.bridge, { pipeline: false });
  engineA.receivePhrase("Draw a login screen");
  engineA.receivePhrase("Add a forgot password link");
  await Bun.sleep(5);
  expect(requests).toHaveLength(1);
  expect(engineA.getSnapshot().pendingPhrases.map((phrase) => phrase.status)).toEqual(["drawing", "queued"]);

  engineA.stopVoice();
  const b = recordingBridge("Board B");
  const engineB = new ConversationEngine(b.bridge);
  emit(requests[0], { type: "op", op: shape("login", "Login") });
  emit(requests[0], { type: "done" });
  await Bun.sleep(700);

  // No second request was ever sent for the queued phrase, and neither board got the late op.
  expect(requests).toHaveLength(1);
  expect(a.applied).toEqual([]);
  expect(b.applied).toEqual([]);
  expect(engineA.getSnapshot().pendingPhrases).toEqual([]);
  engineB.stopVoice();
});

test("exported memory survives a JSON round trip through the schema", () => {
  const engine = new ConversationEngine(recordingBridge("A").bridge);
  const memory = engine.exportMemory();
  expect(ConversationMemory.parse(JSON.parse(JSON.stringify(memory)))).toEqual(memory);
});
