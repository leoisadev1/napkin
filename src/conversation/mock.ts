// A scripted stand-in for the real conversation engine, so the UI can be built and demoed with no backend.
// It follows the same Conversation contract: phases cycle, captions stream, ops land with realistic timing,
// and mic and output levels are synthesized. Add ?novoice to the URL to simulate a server without Gradium.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardOp } from "../../shared/board";
import type { BoardBridge, Conversation, ConversationPhase, TranscriptEntry } from "./types";

type Step =
  | { kind: "say"; text: string }
  | { kind: "op"; op: BoardOp }
  | { kind: "wait"; ms: number }
  | { kind: "pending"; id: string; label: string }
  | { kind: "pending_done"; id: string };

type Script = { match: RegExp; utterance: string; steps: (bridge: BoardBridge) => Step[] };

const op = (value: unknown): Step => ({ kind: "op", op: BoardOp.parse(value) });
const say = (text: string): Step => ({ kind: "say", text });
const wait = (ms: number): Step => ({ kind: "wait", ms });

/** Draws a small badge illustration so the image path (pending card, then image) can be demoed offline. */
function badgeDataUrl(): string {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return "data:image/png;base64,";
  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, "#fff4e6");
  bg.addColorStop(1, "#ffe3e3");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  const ring = ctx.createRadialGradient(256, 230, 40, 256, 256, 200);
  ring.addColorStop(0, "#ffa94d");
  ring.addColorStop(1, "#f76707");
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(256, 256, 170, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff9db";
  ctx.beginPath();
  ctx.moveTo(256, 120);
  ctx.bezierCurveTo(330, 200, 350, 250, 320, 320);
  ctx.bezierCurveTo(300, 370, 212, 370, 192, 320);
  ctx.bezierCurveTo(176, 280, 196, 240, 226, 214);
  ctx.bezierCurveTo(226, 250, 240, 262, 252, 262);
  ctx.bezierCurveTo(240, 210, 250, 160, 256, 120);
  ctx.fill();
  ctx.fillStyle = "#d9480f";
  ctx.font = "700 64px 'Instrument Sans Variable', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("21", 256, 336);
  return canvas.toDataURL("image/png");
}

const SCRIPTS: Script[] = [
  {
    match: /habit/i,
    utterance: "I'm building a habit tracker app. Help me map the core loop and sketch the main screen.",
    steps: () => [
      say("Love it. Let me sketch the core loop first."),
      op({ op: "set_title", title: "Habit tracker" }),
      op({ op: "add_frame", id: "core-loop", title: "Core loop", placement: { kind: "auto" } }),
      op({ op: "add_shape", id: "pick-habit", shape: "box", label: "Pick a habit", color: "blue", placement: { kind: "inside", frame: "core-loop" } }),
      op({ op: "add_shape", id: "check-in", shape: "box", label: "Daily check-in", color: "green", placement: { kind: "inside", frame: "core-loop" } }),
      op({ op: "add_shape", id: "streak", shape: "ellipse", label: "Streak grows", color: "yellow", placement: { kind: "inside", frame: "core-loop" } }),
      op({ op: "add_edge", id: "e-pick-check", from: "pick-habit", to: "check-in", label: "every day" }),
      op({ op: "add_edge", id: "e-check-streak", from: "check-in", to: "streak", label: "" }),
      op({ op: "add_shape", id: "reminder", shape: "sticky", label: "Gentle nudge at 8pm if not checked in", color: "yellow", placement: { kind: "near", target: "check-in", direction: "below" } }),
      wait(600),
      say("Here's a first pass at the today screen."),
      op({
        op: "add_mockup",
        id: "today-screen",
        title: "Today",
        device: "phone",
        components: [
          { kind: "header", label: "Today" },
          { kind: "text", label: "3 of 5 habits done" },
          { kind: "list", label: "Drink water, Read 20 min, Stretch" },
          { kind: "button", label: "Check in" },
          { kind: "chart", label: "This week" },
          { kind: "tabbar", label: "Today, Stats, Profile" },
        ],
        placement: { kind: "near", target: "core-loop", direction: "right" },
      }),
      op({ op: "add_edge", id: "e-loop-screen", from: "check-in", to: "today-screen", label: "lives here" }),
      wait(500),
      say("And I'm drawing a streak badge to make it feel rewarding."),
      { kind: "pending", id: "streak-badge", label: "Generating image…" },
      wait(2600),
      op({ op: "add_image", id: "streak-badge", caption: "Streak badge concept", dataUrl: badgeDataUrl(), placement: { kind: "auto" } }),
      { kind: "pending_done", id: "streak-badge" },
    ],
  },
  {
    match: /podcast|launch/i,
    utterance: "Plan a launch for my podcast. I've got six weeks and no audience yet.",
    steps: () => [
      say("Six weeks is plenty. Here's a simple runway."),
      op({ op: "set_title", title: "Podcast launch" }),
      op({ op: "add_shape", id: "trailer", shape: "box", label: "Record a 60s trailer", color: "purple", placement: { kind: "auto" } }),
      op({ op: "add_shape", id: "guests", shape: "box", label: "Book 3 launch guests", color: "blue", placement: { kind: "near", target: "trailer", direction: "right" } }),
      op({ op: "add_shape", id: "clips", shape: "box", label: "Cut social clips", color: "pink", placement: { kind: "near", target: "guests", direction: "right" } }),
      op({ op: "add_shape", id: "launch-day", shape: "diamond", label: "Launch day", color: "orange", placement: { kind: "near", target: "clips", direction: "right" } }),
      op({ op: "add_edge", id: "e1", from: "trailer", to: "guests", label: "week 1" }),
      op({ op: "add_edge", id: "e2", from: "guests", to: "clips", label: "weeks 2-4" }),
      op({ op: "add_edge", id: "e3", from: "clips", to: "launch-day", label: "week 6" }),
      say("Two ideas to seed an audience before day one."),
      op({ op: "add_shape", id: "idea-swap", shape: "sticky", label: "Swap promos with a show your size", color: "green", placement: { kind: "near", target: "guests", direction: "below" } }),
      op({ op: "add_shape", id: "idea-list", shape: "sticky", label: "Email list from the trailer page", color: "teal", placement: { kind: "near", target: "clips", direction: "below" } }),
    ],
  },
  {
    match: /checkout|payment/i,
    utterance: "Map how our checkout service talks to payments and fraud checks.",
    steps: () => [
      say("Sure. Here's the request path."),
      op({ op: "set_title", title: "Checkout architecture" }),
      op({ op: "add_shape", id: "web", shape: "box", label: "Web app", color: "gray", placement: { kind: "auto" } }),
      op({ op: "add_shape", id: "checkout", shape: "box", label: "Checkout API", color: "blue", placement: { kind: "near", target: "web", direction: "right" } }),
      op({ op: "add_shape", id: "fraud", shape: "diamond", label: "Fraud check", color: "red", placement: { kind: "near", target: "checkout", direction: "right" } }),
      op({ op: "add_shape", id: "payments", shape: "box", label: "Payments provider", color: "green", placement: { kind: "near", target: "fraud", direction: "right" } }),
      op({ op: "add_shape", id: "ledger", shape: "ellipse", label: "Ledger", color: "teal", placement: { kind: "near", target: "checkout", direction: "below" } }),
      op({ op: "add_edge", id: "e-web", from: "web", to: "checkout", label: "POST /orders" }),
      op({ op: "add_edge", id: "e-fraud", from: "checkout", to: "fraud", label: "score" }),
      op({ op: "add_edge", id: "e-pay", from: "fraud", to: "payments", label: "if clear" }),
      op({ op: "add_edge", id: "e-ledger", from: "checkout", to: "ledger", label: "record" }),
      say("The fraud check is the slow hop, so I'd make it async."),
      op({ op: "update", id: "fraud", color: "orange" }),
    ],
  },
];

function fallbackScript(text: string, bridge: BoardBridge): Step[] {
  const items = bridge.getSummary().items.filter((item) => item.kind !== "edge");
  const last = items.at(-1);
  const id = `note-${Date.now().toString(36)}`;
  return [
    say("Got it. I put that on the board."),
    op({
      op: "add_shape",
      id,
      shape: "sticky",
      label: text.slice(0, 200),
      color: "yellow",
      placement: last === undefined ? { kind: "auto" } : { kind: "near", target: last.id, direction: "below" },
    }),
  ];
}

type Listener = (level: number) => void;

let entrySeq = 0;
const entryId = () => `t${Date.now().toString(36)}${(entrySeq++).toString(36)}`;

export function useMockConversation(bridge: BoardBridge): Conversation {
  const [phase, setPhase] = useState<ConversationPhase>({ kind: "idle" });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [partial, setPartial] = useState("");
  const voiceAvailable = useMemo(() => !new URLSearchParams(window.location.search).has("novoice"), []);

  const micListeners = useRef(new Set<Listener>());
  const outListeners = useRef(new Set<Listener>());
  const timers = useRef(new Set<number>());
  const turnToken = useRef(0);
  const voiceOn = useRef(false);
  const speaking = useRef(0);
  const userTalking = useRef(false);
  const scriptCursor = useRef(0);
  const bridgeRef = useRef(bridge);
  useEffect(() => {
    bridgeRef.current = bridge;
  }, [bridge]);

  const later = useCallback((ms: number, fn: () => void) => {
    const handle = window.setTimeout(() => {
      timers.current.delete(handle);
      fn();
    }, ms);
    timers.current.add(handle);
  }, []);

  const clearTimers = useCallback(() => {
    for (const handle of timers.current) window.clearTimeout(handle);
    timers.current.clear();
  }, []);

  const restingPhase = useCallback((): ConversationPhase => (voiceOn.current ? { kind: "listening" } : { kind: "idle" }), []);

  // Synthesized levels, about 30 per second, only while someone is "talking".
  useEffect(() => {
    let t = 0;
    const handle = window.setInterval(() => {
      t += 1;
      if (voiceOn.current) {
        const base = userTalking.current ? 0.35 + 0.4 * Math.abs(Math.sin(t / 3.1)) * Math.random() + 0.15 * Math.random() : 0.03 * Math.random();
        for (const listener of micListeners.current) listener(Math.min(1, base));
      }
      if (speaking.current > 0) {
        const level = 0.25 + 0.45 * Math.abs(Math.sin(t / 2.3)) * (0.6 + 0.4 * Math.random());
        for (const listener of outListeners.current) listener(level);
      }
    }, 33);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const runTurn = useCallback(
    (text: string) => {
      const token = ++turnToken.current;
      const live = () => token === turnToken.current;
      setTranscript((prev) => [...prev, { id: entryId(), role: "user", text, final: true }]);
      setPhase({ kind: "thinking" });
      const script = SCRIPTS.find((s) => s.match.test(text));
      const steps = script === undefined ? fallbackScript(text, bridgeRef.current) : script.steps(bridgeRef.current);
      const assistantId = entryId();
      let spoken = "";
      let started = false;

      const speak = (sentence: string) => {
        const words = sentence.split(" ");
        speaking.current += 1;
        setPhase({ kind: "speaking" });
        const prefix = spoken.length > 0 ? " " : "";
        words.forEach((word, index) => {
          later(index * 95, () => {
            if (!live()) return;
            spoken += (index === 0 ? prefix : " ") + word;
            const snapshot = spoken;
            const append = !started;
            started = true;
            setTranscript((prev) => {
              const entry: TranscriptEntry = { id: assistantId, role: "assistant", text: snapshot, final: false };
              return append ? [...prev, entry] : prev.map((e) => (e.id === assistantId ? entry : e));
            });
          });
        });
        // Audio trails the text a little, as TTS playback would.
        later(words.length * 95 + 650, () => {
          speaking.current = Math.max(0, speaking.current - 1);
          if (live() && speaking.current === 0) setPhase({ kind: "thinking" });
        });
      };

      let clock = 700;
      for (const step of steps) {
        switch (step.kind) {
          case "say": {
            const at = clock;
            later(at, () => live() && speak(step.text));
            clock += 260;
            break;
          }
          case "op":
            later(clock, () => live() && bridgeRef.current.apply(step.op));
            clock += step.op.op === "add_mockup" ? 900 : 420;
            break;
          case "wait":
            clock += step.ms;
            break;
          case "pending":
            later(clock, () => live() && bridgeRef.current.showPending({ id: step.id, label: step.label }));
            clock += 300;
            break;
          case "pending_done":
            later(clock, () => live() && bridgeRef.current.clearPending(step.id));
            clock += 100;
            break;
          default: {
            const _exhaustive: never = step;
            return _exhaustive;
          }
        }
      }
      const finish = () => {
        if (!live()) return;
        if (speaking.current > 0) {
          later(200, finish);
          return;
        }
        setTranscript((prev) => prev.map((e) => (e.id === assistantId ? { ...e, final: true } : e)));
        setPhase(restingPhase());
      };
      later(clock + 300, finish);
    },
    [later, restingPhase],
  );

  const sendText = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (clean.length === 0) return;
      // A new turn interrupts whatever the partner was doing.
      turnToken.current += 1;
      speaking.current = 0;
      clearTimers();
      setTranscript((prev) => prev.map((e) => (e.final ? e : { ...e, final: true })));
      runTurn(clean);
    },
    [clearTimers, runTurn],
  );

  const interrupt = useCallback(() => {
    turnToken.current += 1;
    speaking.current = 0;
    userTalking.current = false;
    clearTimers();
    setPartial("");
    setTranscript((prev) => prev.map((e) => (e.final ? e : { ...e, final: true })));
    setPhase(restingPhase());
  }, [clearTimers, restingPhase]);

  const startVoice = useCallback(async () => {
    if (!voiceAvailable || voiceOn.current) return;
    setPhase({ kind: "connecting" });
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    voiceOn.current = true;
    setPhase({ kind: "listening" });
    // Pretend the user says the next scripted line.
    const script = SCRIPTS[scriptCursor.current % SCRIPTS.length];
    scriptCursor.current += 1;
    if (script === undefined) return;
    const words = script.utterance.split(" ");
    const token = turnToken.current;
    later(900, () => {
      userTalking.current = true;
    });
    words.forEach((_, index) => {
      later(900 + index * 210, () => {
        if (token !== turnToken.current || !voiceOn.current) return;
        setPartial(words.slice(0, index + 1).join(" "));
      });
    });
    later(900 + words.length * 210 + 500, () => {
      userTalking.current = false;
      if (token !== turnToken.current || !voiceOn.current) return;
      setPartial("");
      runTurn(script.utterance);
    });
  }, [later, runTurn, voiceAvailable]);

  const stopVoice = useCallback(() => {
    voiceOn.current = false;
    userTalking.current = false;
    setPartial("");
    setPhase((prev) => (prev.kind === "listening" || prev.kind === "connecting" ? { kind: "idle" } : prev));
  }, []);

  const subscribeLevel = useCallback((listener: Listener) => {
    micListeners.current.add(listener);
    return () => {
      micListeners.current.delete(listener);
    };
  }, []);

  const subscribeOutputLevel = useCallback((listener: Listener) => {
    outListeners.current.add(listener);
    return () => {
      outListeners.current.delete(listener);
    };
  }, []);

  return useMemo(
    () => ({ phase, transcript, partial, voiceAvailable, subscribeLevel, subscribeOutputLevel, startVoice, stopVoice, sendText, interrupt }),
    [phase, transcript, partial, voiceAvailable, subscribeLevel, subscribeOutputLevel, startVoice, stopVoice, sendText, interrupt],
  );
}
