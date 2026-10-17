// A scripted stand-in for the real conversation engine, so the UI can be built and demoed with no backend.
// It follows the live-drawing contract: while the mic is open the user's words stream into `partial`, every few
// words a phrase commits, and the board gets one to three ops for it about 0.8 s later while the user keeps
// talking. Nothing is spoken back. Suggestions arrive at pauses. Typed messages and tapped suggestions run as
// "turn" requests. Add ?novoice to the URL to simulate a server without Gradium. Heard phrases show as pending
// ("queued", then "drawing") until their first op lands. Muting drops what is said while muted, like the real mic.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardOp } from "../../shared/board";
import type { BoardBridge, Conversation, ConversationPhase, TranscriptEntry } from "./types";

type Step =
  | { kind: "op"; op: BoardOp }
  /** Several ops in the same tick, the way a refine or a multi-line reply arrives. */
  | { kind: "burst"; ops: BoardOp[] }
  | { kind: "wait"; ms: number }
  | { kind: "pending"; id: string; label: string }
  | { kind: "pending_done"; id: string };

/** One spoken phrase and what the partner draws for it. */
type Phrase = { text: string; steps: Step[] };
/** Phrases said in one breath, then a pause where suggestions show up. */
type Segment = { phrases: Phrase[]; suggestions: string[] };

type TurnScript = { match: RegExp; steps: (bridge: BoardBridge) => Step[]; suggestions: string[]; refine?: boolean };

const op = (value: unknown): Step => ({ kind: "op", op: BoardOp.parse(value) });
const burst = (values: readonly unknown[]): Step => ({ kind: "burst", ops: values.map((v) => BoardOp.parse(v)) });
const wait = (ms: number): Step => ({ kind: "wait", ms });

/** Draws a small badge illustration so the image path (pending card, then image) can be demoed offline. */
function badgeDataUrl(): string {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return "data:image/png;base64,";
  ctx.fillStyle = "#fff4e6";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#f76707";
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
  return canvas.toDataURL("image/png");
}

/** What the mock "hears" when the mic opens: a habit-tracker brainstorm in two breaths. */
const MONOLOGUE: readonly Segment[] = [
  {
    phrases: [
      {
        text: "So I'm thinking about a habit tracker app",
        steps: [op({ op: "set_title", title: "Habit tracker" }), op({ op: "add_frame", id: "core-loop", title: "Core loop", placement: { kind: "auto" } })],
      },
      {
        text: "where you pick one habit you want to build",
        steps: [op({ op: "add_shape", id: "pick-habit", shape: "box", label: "Pick a habit", color: "blue", placement: { kind: "inside", frame: "core-loop" } })],
      },
      {
        text: "then every day you check in once",
        steps: [
          op({ op: "add_shape", id: "check-in", shape: "box", label: "Daily check-in", color: "green", placement: { kind: "inside", frame: "core-loop" } }),
          op({ op: "add_edge", id: "e-pick-check", from: "pick-habit", to: "check-in", label: "every day" }),
        ],
      },
      {
        text: "and your streak grows the longer you keep it going",
        steps: [
          op({ op: "add_shape", id: "streak", shape: "ellipse", label: "Streak grows", color: "yellow", placement: { kind: "inside", frame: "core-loop" } }),
          op({ op: "add_edge", id: "e-check-streak", from: "check-in", to: "streak", label: "" }),
        ],
      },
    ],
    suggestions: ["Add a reminder", "Sketch the home screen", "What breaks a streak?"],
  },
  {
    phrases: [
      {
        text: "the main screen should really just show today",
        steps: [
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
        ],
      },
      {
        text: "maybe a gentle nudge at eight if you forgot",
        steps: [
          op({ op: "add_shape", id: "reminder", shape: "sticky", label: "Gentle nudge at 8pm if not checked in", color: "yellow", placement: { kind: "near", target: "check-in", direction: "below" } }),
        ],
      },
      {
        text: "and friends could see each other's streaks",
        steps: [
          op({ op: "add_frame", id: "social", title: "Social", placement: { kind: "near", target: "core-loop", direction: "below" } }),
          op({ op: "add_shape", id: "friends", shape: "box", label: "Friends list", color: "purple", placement: { kind: "inside", frame: "social" } }),
        ],
      },
      {
        text: "like a little weekly leaderboard",
        steps: [
          op({ op: "add_shape", id: "leaderboard", shape: "box", label: "Weekly leaderboard", color: "pink", placement: { kind: "inside", frame: "social" } }),
          op({ op: "add_edge", id: "e-friends-board", from: "friends", to: "leaderboard", label: "" }),
        ],
      },
    ],
    suggestions: ["Draw a streak badge", "Map onboarding", "Compare with Duolingo"],
  },
];

/** Diagram ops the mock can draw, one per kind, so every layout can be seen without a backend. */
const node = (id: string, label: string, color: string, extra: { shape?: string; parent?: string | null } = {}) => ({
  id,
  label,
  color,
  shape: extra.shape ?? "box",
  parent: extra.parent ?? null,
});

const DIAGRAMS = {
  cycle: {
    op: "add_diagram",
    id: "growth-loop",
    kind: "cycle",
    title: "Growth loop",
    nodes: [
      node("new-user", "New user signs up", "blue"),
      node("first-win", "Gets a first win", "green"),
      node("shares", "Shares their board", "yellow"),
      node("friend-sees", "A friend sees it", "orange"),
      node("friend-joins", "Friend joins", "purple"),
    ],
    links: [{ from: "shares", to: "friend-sees", label: "public link" }],
    axes: [],
    placement: { kind: "auto" },
  },
  mindmap: {
    op: "add_diagram",
    id: "trip-ideas",
    kind: "mindmap",
    title: "Weekend in Lisbon",
    nodes: [
      node("lisbon", "Lisbon weekend", "purple", { shape: "ellipse" }),
      node("food", "Food", "orange", { parent: "lisbon" }),
      node("pasteis", "Pastéis de nata in Belém", "orange", { parent: "food" }),
      node("time-out", "Time Out Market", "orange", { parent: "food" }),
      node("sights", "Sights", "blue", { parent: "lisbon" }),
      node("tram-28", "Tram 28", "blue", { parent: "sights" }),
      node("alfama", "Alfama at sunset", "blue", { parent: "sights" }),
      node("day-trip", "Day trip", "green", { parent: "lisbon" }),
      node("sintra", "Sintra palaces", "green", { parent: "day-trip" }),
      node("cascais", "Beach in Cascais", "green", { parent: "day-trip" }),
      node("night", "Nights out", "pink", { parent: "lisbon" }),
      node("fado", "Fado bar", "pink", { parent: "night" }),
    ],
    links: [],
    axes: [],
    placement: { kind: "auto" },
  },
  flow: {
    op: "add_diagram",
    id: "order-flow",
    kind: "flow",
    title: "Order flow",
    nodes: [
      node("placed", "Order placed", "gray", { shape: "ellipse" }),
      node("in-stock", "In stock?", "yellow", { shape: "diamond" }),
      node("charge", "Charge card", "blue"),
      node("paid-ok", "Payment ok?", "yellow", { shape: "diamond" }),
      node("ship", "Ship it", "green"),
      node("backorder", "Backorder and email the customer", "orange"),
      node("retry-card", "Ask for another card", "red"),
    ],
    links: [
      { from: "placed", to: "in-stock", label: "" },
      { from: "in-stock", to: "charge", label: "yes" },
      { from: "in-stock", to: "backorder", label: "no" },
      { from: "charge", to: "paid-ok", label: "" },
      { from: "paid-ok", to: "ship", label: "yes" },
      { from: "paid-ok", to: "retry-card", label: "no" },
      { from: "retry-card", to: "charge", label: "new card" },
    ],
    axes: [],
    placement: { kind: "auto" },
  },
  tree: {
    op: "add_diagram",
    id: "team-tree",
    kind: "tree",
    title: "Who owns what",
    nodes: [
      node("founder", "Founder", "purple"),
      node("eng", "Engineering", "blue", { parent: "founder" }),
      node("design", "Design", "pink", { parent: "founder" }),
      node("growth", "Growth", "green", { parent: "founder" }),
      node("web", "Web app", "blue", { parent: "eng" }),
      node("api", "API and infra", "blue", { parent: "eng" }),
      node("brand", "Brand", "pink", { parent: "design" }),
      node("seo", "SEO", "green", { parent: "growth" }),
      node("ads", "Paid ads", "green", { parent: "growth" }),
      node("workers", "Edge workers", "teal", { parent: "api" }),
      node("database", "Database", "teal", { parent: "api" }),
    ],
    links: [],
    axes: [],
    placement: { kind: "auto" },
  },
  timeline: {
    op: "add_diagram",
    id: "roadmap",
    kind: "timeline",
    title: "Roadmap",
    nodes: [
      node("kickoff", "Jan: Kickoff", "gray"),
      node("interviews", "Feb: Customer interviews", "blue"),
      node("prototype", "Mar: Clickable prototype", "blue"),
      node("beta", "Q2: Private beta with 50 teams", "purple"),
      node("pricing", "Jul: Pricing", "yellow"),
      node("launch", "Sep: Public launch", "green"),
      node("retro", "Dec: First retro", "gray"),
    ],
    links: [],
    axes: [],
    placement: { kind: "auto" },
  },
  funnel: {
    op: "add_diagram",
    id: "signup-funnel",
    kind: "funnel",
    title: "Signup funnel",
    nodes: [
      node("visit", "Visitors", "blue"),
      node("signup", "Sign ups", "teal"),
      node("activate", "Activated in week one", "green"),
      node("pay", "Paying teams", "yellow"),
      node("refer", "Champions who refer", "orange"),
    ],
    links: [],
    axes: [],
    placement: { kind: "auto" },
  },
  quadrant: {
    op: "add_diagram",
    id: "priorities",
    kind: "quadrant",
    title: "What to build next",
    nodes: [
      node("quick-wins", "Quick wins", "green"),
      node("big-bets", "Big bets", "blue"),
      node("fill-ins", "Fill-ins", "gray"),
      node("money-pits", "Money pits", "red"),
      node("dark-mode", "Dark mode", "yellow", { shape: "sticky", parent: "quick-wins" }),
      node("pdf-export", "Export to PDF", "yellow", { shape: "sticky", parent: "quick-wins" }),
      node("ai-drafts", "Agent that drafts for you", "yellow", { shape: "sticky", parent: "big-bets" }),
      node("emoji", "Custom emoji", "yellow", { shape: "sticky", parent: "fill-ins" }),
      node("rust", "Rewrite in Rust", "yellow", { shape: "sticky", parent: "money-pits" }),
    ],
    links: [],
    axes: ["Effort", "Impact"],
    placement: { kind: "auto" },
  },
} as const;

/** Loose ideas first, then a refine pass that turns them into a cycle: the "make it a diagram" moment. */
const PROGRESSION_BOXES = [
  { id: "tasks", label: "Complete cat tasks to earn coins and XP", color: "yellow" },
  { id: "spend", label: "Spend coins on stronger cat abilities", color: "green" },
  { id: "unlock", label: "Reach milestones to unlock new areas", color: "purple" },
  { id: "harder", label: "Tougher tasks, bigger rewards", color: "orange" },
] as const;

const TURNS: readonly TurnScript[] = [
  ...Object.entries(DIAGRAMS).map(
    ([kind, diagram]): TurnScript => ({
      match: new RegExp(`\\b${kind}\\b`, "i"),
      steps: () => [op(diagram)],
      suggestions: ["Make it a cycle", "Turn this into a timeline"],
    }),
  ),
  {
    match: /progression|roblox/i,
    steps: () => [
      op({ op: "set_title", title: "Cat Simulator" }),
      ...PROGRESSION_BOXES.map((b, i) =>
        op({
          op: "add_shape",
          id: b.id,
          shape: "box",
          label: b.label,
          color: b.color,
          placement: i === 0 ? { kind: "auto" } : { kind: "near", target: PROGRESSION_BOXES[i - 1]?.id ?? b.id, direction: i % 2 === 1 ? "right" : "below" },
        }),
      ),
    ],
    suggestions: ["Refine it into a loop", "Add daily quests"],
  },
  {
    // "Clean up my sketch", "make this a box": the user's drawing under the mouse (or selected, or the latest one)
    // becomes a clean shape in exactly its spot.
    match: /my (sketch|drawing|scribble)|clean up (this|that)|make (this|that) (a|an|into)\b/i,
    steps: (bridge) => {
      const summary = bridge.getSummary();
      const sketches = summary.items.filter((item) => item.kind === "sketch");
      const target =
        sketches.find((item) => item.id === summary.pointer?.over) ?? sketches.find((item) => summary.selection.includes(item.id)) ?? sketches.at(-1);
      if (target === undefined) return [op({ op: "add_shape", id: `hint-${Date.now().toString(36)}`, shape: "sticky", label: "Draw something first, then ask me to clean it up", color: "yellow", placement: { kind: "at_pointer" } })];
      const wide = target.bounds.w > target.bounds.h * 1.3;
      return [
        burst([
          { op: "add_shape", id: `clean-${target.id}`, shape: wide ? "box" : "ellipse", label: target.label.length > 0 ? target.label : "Your idea", color: "blue", placement: { kind: "at", target: target.id } },
          { op: "delete", ids: [target.id] },
        ]),
      ];
    },
    suggestions: ["Label it", "Connect it to the loop"],
  },
  {
    match: /\b(here|this spot|right there)\b/i,
    steps: () => [op({ op: "add_shape", id: `here-${Date.now().toString(36)}`, shape: "sticky", label: "Right here", color: "pink", placement: { kind: "at_pointer" } })],
    suggestions: ["Label this", "Make it a box"],
  },
  {
    // Ten ideas in one breath: the board takes them in one at a time.
    match: /brainstorm|ideas|burst/i,
    steps: () => [
      burst(
        ["Daily quests", "Cat skins", "Guilds", "Trading", "Pet hotel", "Fishing", "Seasons", "Leaderboards", "Mini-games", "Cat cafe"].map((label, i) => ({
          op: "add_shape",
          id: `idea-${i + 1}`,
          shape: "sticky",
          label,
          color: (["yellow", "green", "blue", "pink", "purple"] as const)[i % 5],
          placement: i === 0 ? { kind: "auto" } : { kind: "near", target: `idea-${i}`, direction: i % 4 === 3 ? "below" : "right" },
        })),
      ),
    ],
    suggestions: ["Group these", "Pick the top three"],
  },
  {
    match: /refine|clean ?up|tidy/i,
    refine: true,
    steps: () => [
      burst([
        { op: "delete", ids: PROGRESSION_BOXES.map((b) => b.id) },
        {
          op: "add_diagram",
          id: "core-loop",
          kind: "cycle",
          title: "Core loop",
          nodes: [...PROGRESSION_BOXES.map((b) => node(b.id, b.label, b.color)), node("new-areas", "New areas and cat skins", "blue")],
          links: [],
          axes: [],
          placement: { kind: "auto" },
        },
      ]),
    ],
    suggestions: ["Add daily quests", "Map the first session"],
  },
  {
    match: /habit/i,
    steps: () => [
      op({ op: "set_title", title: "Habit tracker" }),
      op({ op: "add_frame", id: "core-loop", title: "Core loop", placement: { kind: "auto" } }),
      op({ op: "add_shape", id: "pick-habit", shape: "box", label: "Pick a habit", color: "blue", placement: { kind: "inside", frame: "core-loop" } }),
      op({ op: "add_shape", id: "check-in", shape: "box", label: "Daily check-in", color: "green", placement: { kind: "inside", frame: "core-loop" } }),
      op({ op: "add_shape", id: "streak", shape: "ellipse", label: "Streak grows", color: "yellow", placement: { kind: "inside", frame: "core-loop" } }),
      op({ op: "add_edge", id: "e-pick-check", from: "pick-habit", to: "check-in", label: "every day" }),
      op({ op: "add_edge", id: "e-check-streak", from: "check-in", to: "streak", label: "" }),
      wait(400),
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
          { kind: "tabbar", label: "Today, Stats, Profile" },
        ],
        placement: { kind: "near", target: "core-loop", direction: "right" },
      }),
    ],
    suggestions: ["Add a reminder", "Draw a streak badge", "Who is this for?"],
  },
  {
    match: /badge/i,
    steps: () => [
      { kind: "pending", id: "streak-badge", label: "Generating image…" },
      wait(2400),
      op({ op: "add_image", id: "streak-badge", caption: "Streak badge concept", dataUrl: badgeDataUrl(), placement: { kind: "auto" } }),
      { kind: "pending_done", id: "streak-badge" },
    ],
    suggestions: ["Try a calmer style", "Add a 100-day badge"],
  },
  {
    match: /podcast|launch/i,
    steps: () => [
      op({ op: "set_title", title: "Podcast launch" }),
      op({ op: "add_shape", id: "trailer", shape: "box", label: "Record a 60s trailer", color: "purple", placement: { kind: "auto" } }),
      op({ op: "add_shape", id: "guests", shape: "box", label: "Book 3 launch guests", color: "blue", placement: { kind: "near", target: "trailer", direction: "right" } }),
      op({ op: "add_shape", id: "clips", shape: "box", label: "Cut social clips", color: "pink", placement: { kind: "near", target: "guests", direction: "right" } }),
      op({ op: "add_shape", id: "launch-day", shape: "diamond", label: "Launch day", color: "orange", placement: { kind: "near", target: "clips", direction: "right" } }),
      op({ op: "add_edge", id: "e1", from: "trailer", to: "guests", label: "week 1" }),
      op({ op: "add_edge", id: "e2", from: "guests", to: "clips", label: "weeks 2-4" }),
      op({ op: "add_edge", id: "e3", from: "clips", to: "launch-day", label: "week 6" }),
      op({ op: "add_shape", id: "idea-swap", shape: "sticky", label: "Swap promos with a show your size", color: "green", placement: { kind: "near", target: "guests", direction: "below" } }),
    ],
    suggestions: ["Pick launch guests", "Plan week one", "Where do listeners come from?"],
  },
  {
    match: /checkout|payment/i,
    steps: () => [
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
    ],
    suggestions: ["Make fraud async", "Add retries", "Where can it fail?"],
  },
];

function fallbackSteps(text: string): Step[] {
  // Auto lands where the user is looking: beside the last thing, or by the mouse if it moved.
  return [op({ op: "add_shape", id: `note-${Date.now().toString(36)}`, shape: "sticky", label: text.slice(0, 200), color: "yellow", placement: { kind: "auto" } })];
}

type Listener = (level: number) => void;

const WORD_MS = 230;
const PHRASE_GAP_MS = 260;
const DRAW_DELAY_MS = 800;
const OP_GAP_MS = 260;
const PAUSE_MS = 3200;

let entrySeq = 0;
const entryId = () => `t${Date.now().toString(36)}${(entrySeq++).toString(36)}`;

export function useMockConversation(bridge: BoardBridge): Conversation {
  const [phase, setPhase] = useState<ConversationPhase>({ kind: "idle" });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [partial, setPartial] = useState("");
  const [sketchJobs, setSketchJobs] = useState(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [pendingPhrases, setPendingPhrases] = useState<Conversation["pendingPhrases"]>([]);
  const [refineJobs, setRefineJobs] = useState(0);
  const [muted, setMutedState] = useState(false);
  const mutedRef = useRef(false);
  const voiceAvailable = useMemo(() => !new URLSearchParams(window.location.search).has("novoice"), []);

  const micListeners = useRef(new Set<Listener>());
  const timers = useRef(new Set<number>());
  /** Bumped by interrupt and stopVoice; scheduled work checks it before running. */
  const epoch = useRef(0);
  const voiceOn = useRef(false);
  const userTalking = useRef(false);
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

  // Synthesized mic level, about 30 per second while the mic is open.
  useEffect(() => {
    let t = 0;
    const handle = window.setInterval(() => {
      t += 1;
      if (!voiceOn.current) return;
      const level = mutedRef.current
        ? 0
        : userTalking.current ? 0.3 + 0.45 * Math.abs(Math.sin(t / 3.1)) * Math.random() + 0.15 * Math.random() : 0.03 * Math.random();
      for (const listener of micListeners.current) listener(Math.min(1, level));
    }, 33);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  /** Applies steps in order from `startMs`, holding `sketching` on while they run. Returns when the last one lands. */
  const draw = useCallback(
    (steps: readonly Step[], startMs: number, options: { phrase?: string; refine?: boolean; then?: () => void } = {}): void => {
      const run = epoch.current;
      const live = () => run === epoch.current;
      const { phrase, refine = false, then } = options;
      let clock = startMs;
      // The request goes out a beat after the phrase is heard; until the first op lands it shows as drawing.
      if (phrase !== undefined) later(Math.min(250, startMs), () => live() && setPendingPhrases((list) => list.map((p) => (p.id === phrase ? { ...p, status: "drawing" } : p))));
      const landed = () => {
        if (phrase !== undefined) setPendingPhrases((list) => list.filter((p) => p.id !== phrase));
      };
      later(startMs, () => {
        if (!live()) return;
        setSketchJobs((n) => n + 1);
        if (refine) setRefineJobs((n) => n + 1);
      });
      for (const step of steps) {
        switch (step.kind) {
          case "op":
            later(clock, () => {
              if (!live()) return;
              landed();
              bridgeRef.current.apply(step.op);
            });
            clock += step.op.op === "add_mockup" ? 700 : OP_GAP_MS;
            break;
          case "burst":
            later(clock, () => {
              if (!live()) return;
              landed();
              for (const o of step.ops) bridgeRef.current.apply(o);
            });
            clock += OP_GAP_MS;
            break;
          case "wait":
            clock += step.ms;
            break;
          case "pending":
            later(clock, () => live() && bridgeRef.current.showPending({ id: step.id, label: step.label }));
            clock += 200;
            break;
          case "pending_done":
            later(clock, () => live() && bridgeRef.current.clearPending(step.id));
            break;
          default: {
            const _exhaustive: never = step;
            return _exhaustive;
          }
        }
      }
      later(clock + 120, () => {
        if (!live()) return;
        landed();
        setSketchJobs((n) => Math.max(0, n - 1));
        if (refine) setRefineJobs((n) => Math.max(0, n - 1));
        then?.();
      });
    },
    [later],
  );

  /** Adds a final user turn and marks it heard but not drawn yet. Returns its id. */
  const commitUser = useCallback((text: string): string => {
    const id = entryId();
    setTranscript((prev) => [...prev, { id, role: "user", text, final: true }]);
    setPendingPhrases((list) => [...list, { id, text, status: "queued" }]);
    return id;
  }, []);

  /** Speaks the monologue: words stream into `partial`, phrases commit and draw while the next one is spoken. */
  const speak = useCallback(
    (segmentIndex: number, startMs: number) => {
      const segment = MONOLOGUE[segmentIndex];
      if (segment === undefined) return;
      const run = epoch.current;
      const live = () => run === epoch.current && voiceOn.current && !mutedRef.current;
      let clock = startMs;
      later(clock, () => {
        if (!live()) return;
        userTalking.current = true;
        setSuggestions([]);
      });
      for (const phrase of segment.phrases) {
        const words = phrase.text.split(" ");
        for (let i = 0; i < words.length; i++) {
          const shown = words.slice(0, i + 1).join(" ");
          later(clock + i * WORD_MS, () => live() && setPartial(shown));
        }
        clock += words.length * WORD_MS + PHRASE_GAP_MS;
        later(clock, () => {
          if (!live()) return;
          setPartial("");
          draw(phrase.steps, DRAW_DELAY_MS, { phrase: commitUser(phrase.text) });
        });
      }
      later(clock + 40, () => {
        if (live()) userTalking.current = false;
      });
      // The pause: drawing for the last phrase finishes, then ideas arrive.
      later(clock + DRAW_DELAY_MS + 1300, () => live() && setSuggestions(segment.suggestions));
      speakNext.current(segmentIndex + 1, clock + PAUSE_MS + 2600);
    },
    [commitUser, draw, later],
  );
  const speakNext = useRef<(index: number, startMs: number) => void>(() => undefined);
  useEffect(() => {
    speakNext.current = speak;
  }, [speak]);

  const runTurn = useCallback(
    (text: string) => {
      const phrase = commitUser(text);
      setSuggestions([]);
      const script = TURNS.find((s) => s.match.test(text));
      const steps = script === undefined ? fallbackSteps(text) : script.steps(bridgeRef.current);
      const ideas = script?.suggestions ?? [];
      draw(steps, 500, { phrase, refine: script?.refine === true, then: () => setSuggestions(ideas) });
    },
    [commitUser, draw],
  );

  const sendText = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (clean.length > 0) runTurn(clean);
    },
    [runTurn],
  );

  const pickSuggestion = useCallback((text: string) => sendText(text), [sendText]);

  const cancelAll = useCallback(() => {
    epoch.current += 1;
    clearTimers();
    userTalking.current = false;
    setSketchJobs(0);
    setRefineJobs(0);
    setPendingPhrases([]);
    setPartial("");
  }, [clearTimers]);

  const interrupt = useCallback(() => {
    cancelAll();
    setPhase(voiceOn.current ? { kind: "listening" } : { kind: "idle" });
  }, [cancelAll]);

  const startVoice = useCallback(async () => {
    if (!voiceAvailable || voiceOn.current) return;
    setPhase({ kind: "connecting" });
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    voiceOn.current = true;
    setPhase({ kind: "listening" });
    speak(0, 700);
  }, [speak, voiceAvailable]);

  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    setMutedState(next);
    if (next) {
      userTalking.current = false;
      setPartial("");
    }
  }, []);

  const stopVoice = useCallback(() => {
    voiceOn.current = false;
    setMuted(false);
    userTalking.current = false;
    setPartial("");
    setPhase({ kind: "idle" });
  }, [setMuted]);

  const subscribeLevel = useCallback((listener: Listener) => {
    micListeners.current.add(listener);
    return () => {
      micListeners.current.delete(listener);
    };
  }, []);

  // Nothing is spoken back, so the output level never moves.
  const subscribeOutputLevel = useCallback(() => () => undefined, []);

  const sketching = sketchJobs > 0;
  const refining = refineJobs > 0;
  return useMemo(
    () => ({
      phase,
      sketching,
      refining,
      pendingPhrases,
      muted,
      setMuted,
      suggestions,
      pickSuggestion,
      transcript,
      partial,
      voiceAvailable,
      subscribeLevel,
      subscribeOutputLevel,
      startVoice,
      stopVoice,
      sendText,
      interrupt,
    }),
    [phase, sketching, refining, pendingPhrases, muted, setMuted, suggestions, pickSuggestion, transcript, partial, voiceAvailable, subscribeLevel, subscribeOutputLevel, startVoice, stopVoice, sendText, interrupt],
  );
}
