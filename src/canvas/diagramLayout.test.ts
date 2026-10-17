/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { DiagramNode } from "../../shared/board";
import type { DiagramLayout, DiagramSpec } from "./diagramLayout";
import { boundTextRoom, estimateText, layoutDiagram, lineCount, splitDate } from "./diagramLayout";
import type { Rect } from "./geometry";
import { contains, inflate, overlaps, segmentHitsRect } from "./geometry";

type NodeIn = Partial<DiagramNode> & { id: string };
const node = (n: NodeIn): DiagramNode => ({ label: n.id.replace(/-/g, " "), color: "blue", shape: "box", parent: null, ...n });

function spec(kind: DiagramSpec["kind"], nodes: NodeIn[], extra: Partial<DiagramSpec> = {}): DiagramSpec {
  return { kind, title: `A ${kind} diagram`, nodes: nodes.map(node), links: [], axes: [], ...extra };
}

const LONG = [
  "Notice the problem in daily work",
  "Talk to five customers this week",
  "Sketch the smallest possible fix",
  "Build it behind a feature flag",
  "Ship to ten percent of users",
  "Measure retention and support load",
  "Write down what we learned",
  "Decide the next bet together",
];

/** The real agent output Leo called rough: long labels everywhere, the center longest of all. */
const HABIT = [
  "Underserved audience: tailor to overlooked needs",
  "Unexpected pairing: combine two useful ideas",
  "Reverse a norm: challenge the default approach",
  "Useful constraint: faster, simpler, or offline",
  "One painful task — make it dramatically easier",
  "Seasonal habits: switch to travel or busy-week plans without treating reduced goals as failure",
];
const COMEBACK = "Comeback-first: after a miss, offer a 2-minute restart; measure return speed, not streaks";

const STRESS: Record<string, DiagramSpec> = {
  mindmapLong: spec("mindmap", [
    { id: "hub", label: COMEBACK, shape: "ellipse", color: "green" },
    ...HABIT.map((label, i) => ({ id: `arm${i}`, label, parent: "hub", color: "orange" as const })),
  ]),
  cycleLong: spec("cycle", HABIT.slice(0, 5).map((label, i) => ({ id: `c${i}`, label, shape: "ellipse" as const }))),
  flowLong: spec("flow", HABIT.slice(0, 4).map((label, i) => ({ id: `l${i}`, label }))),
  treeLong: spec("tree", [{ id: "root", label: COMEBACK }, ...HABIT.slice(0, 4).map((label, i) => ({ id: `t${i}`, label, parent: "root" }))]),
  cycle8: spec("cycle", LONG.map((label, i) => ({ id: `s${i}`, label }))),
  cycle3: spec("cycle", [{ id: "plan" }, { id: "do" }, { id: "review" }]),
  mindmap12: spec("mindmap", [
    { id: "core", label: "Cat Simulator progression", color: "purple" },
    { id: "coins", label: "Earn coins", parent: "core", color: "yellow" },
    { id: "tasks", label: "Daily cat tasks and quests", parent: "coins" },
    { id: "streaks", label: "Streak bonus", parent: "coins" },
    { id: "upgrades", label: "Upgrade your cat", parent: "core", color: "green" },
    { id: "abilities", label: "Stronger abilities", parent: "upgrades" },
    { id: "skins", label: "Rare skins and evolutions", parent: "upgrades" },
    { id: "areas", label: "Unlock new areas", parent: "core", color: "blue" },
    { id: "rooftops", label: "Rooftops", parent: "areas" },
    { id: "sewers", label: "Sewers with tougher tasks", parent: "areas" },
    { id: "social", label: "Play with friends", parent: "core", color: "pink" },
    { id: "trading", label: "Trade items", parent: "social" },
  ]),
  flow2decisions: spec(
    "flow",
    [
      { id: "start", label: "Order placed", shape: "ellipse" },
      { id: "stock", label: "In stock?", shape: "diamond", color: "yellow" },
      { id: "pay", label: "Charge card" },
      { id: "paid", label: "Payment ok?", shape: "diamond", color: "yellow" },
      { id: "ship", label: "Ship order", color: "green" },
      { id: "backorder", label: "Backorder and email customer", color: "orange" },
      { id: "retry", label: "Ask for another card", color: "red" },
    ],
    {
      links: [
        { from: "start", to: "stock", label: "" },
        { from: "stock", to: "pay", label: "yes" },
        { from: "stock", to: "backorder", label: "no" },
        { from: "pay", to: "paid", label: "" },
        { from: "paid", to: "ship", label: "yes" },
        { from: "paid", to: "retry", label: "no" },
        { from: "retry", to: "pay", label: "new card" },
      ],
    },
  ),
  flowChain8: spec("flow", LONG.map((label, i) => ({ id: `f${i}`, label }))),
  tree3: spec("tree", [
    { id: "ceo", label: "Founder" },
    { id: "eng", label: "Engineering", parent: "ceo" },
    { id: "design", label: "Design", parent: "ceo" },
    { id: "growth", label: "Growth and marketing", parent: "ceo" },
    { id: "web", label: "Web app", parent: "eng" },
    { id: "api", label: "API and infra", parent: "eng" },
    { id: "brand", label: "Brand", parent: "design" },
    { id: "seo", label: "SEO", parent: "growth" },
    { id: "ads", label: "Paid ads", parent: "growth" },
    { id: "edge", label: "Edge workers", parent: "api" },
    { id: "db", label: "Database", parent: "api" },
  ]),
  timeline7: spec(
    "timeline",
    ["Jan: Kickoff", "Feb: Research interviews", "Mar: Prototype", "Q2 2027: Private beta with 50 teams", "Jul: Pricing", "Sep - Public launch", "Dec: First retro"].map((label, i) => ({ id: `m${i}`, label })),
  ),
  funnel5: spec(
    "funnel",
    ["Visitors from search and social", "Sign ups", "Activated in first week", "Paying teams", "Champions who refer others"].map((label, i) => ({ id: `b${i}`, label })),
  ),
  quadrant: spec(
    "quadrant",
    [
      { id: "quick-wins", label: "Quick wins", color: "green" },
      { id: "big-bets", label: "Big bets", color: "blue" },
      { id: "fill-ins", label: "Fill-ins", color: "gray" },
      { id: "money-pits", label: "Money pits", color: "red" },
      { id: "dark-mode", label: "Dark mode", parent: "quick-wins", color: "yellow" },
      { id: "export", label: "Export to PDF", parent: "quick-wins", color: "yellow" },
      { id: "ai-agent", label: "AI agent that drafts for you", parent: "big-bets", color: "yellow" },
      { id: "rewrite", label: "Rewrite in Rust", parent: "money-pits", color: "yellow" },
    ],
    { axes: ["Effort", "Impact"] },
  ),
  quadrantBare: spec("quadrant", [{ id: "a" }, { id: "b" }]),
};

function nodeTextFits(layout: DiagramLayout) {
  for (const n of layout.nodes) {
    expect(contains(n.rect, n.text.rect)).toBe(true);
    if (n.shape === "band" || n.shape === "cell") continue;
    const room = boundTextRoom(n.shape, n.rect);
    expect(n.text.rect.w).toBeLessThanOrEqual(room.w);
    expect(n.text.rect.h).toBeLessThanOrEqual(room.h);
  }
}

function noNodeOverlaps(layout: DiagramLayout) {
  const solids = layout.nodes.filter((n) => n.shape !== "cell");
  for (const [i, a] of solids.entries()) {
    for (const b of solids.slice(i + 1)) expect(overlaps(inflate(a.rect, 6), b.rect)).toBe(false);
  }
  // Items sit inside their cell; cells never overlap each other.
  const cells = layout.nodes.filter((n) => n.shape === "cell");
  for (const [i, a] of cells.entries()) for (const b of cells.slice(i + 1)) expect(overlaps(a.rect, b.rect)).toBe(false);
}

function labelsClear(layout: DiagramLayout) {
  const solids = layout.nodes.filter((n) => n.shape !== "cell").map((n) => n.rect);
  const texts: Rect[] = [
    ...layout.connectors.flatMap((c) => (c.label === null ? [] : [c.label.rect])),
    ...layout.decos.flatMap((d) => (d.kind === "text" ? [d.text.rect] : [])),
  ];
  for (const t of texts) for (const s of solids) expect(overlaps(t, s)).toBe(false);
  for (const [i, a] of texts.entries()) for (const b of texts.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
  for (const n of layout.nodes) expect(overlaps(layout.title.rect, n.rect) && n.shape !== "cell").toBe(false);
}

function connectorsAvoidOtherNodes(layout: DiagramLayout) {
  for (const c of layout.connectors) {
    const others = layout.nodes.filter((n) => n.id !== c.from && n.id !== c.to && n.shape !== "cell").map((n) => inflate(n.rect, -2));
    for (let i = 0; i + 1 < c.points.length; i++) {
      const a = c.points[i];
      const b = c.points[i + 1];
      if (a === undefined || b === undefined) continue;
      for (const r of others) expect(segmentHitsRect(a, b, r)).toBe(false);
    }
  }
}

describe("layoutDiagram", () => {
  for (const [name, s] of Object.entries(STRESS)) {
    test(`${name}: every node laid out, no overlaps, labels fit`, () => {
      const layout = layoutDiagram(s, estimateText);
      expect(layout.nodes.map((n) => n.id).sort()).toEqual(s.nodes.map((n) => n.id).sort());
      noNodeOverlaps(layout);
      nodeTextFits(layout);
      labelsClear(layout);
      connectorsAvoidOtherNodes(layout);
      for (const n of layout.nodes) expect(contains(inflate(layout.bounds, 0.5), n.rect)).toBe(true);
    });
  }

  test("flow keeps yes on the main line and sends no below", () => {
    const layout = layoutDiagram(STRESS.flow2decisions ?? spec("flow", []), estimateText);
    const at = (id: string) => layout.nodes.find((n) => n.id === id)?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    const mid = (r: Rect) => r.y + r.h / 2;
    expect(mid(at("pay"))).toBeCloseTo(mid(at("stock")));
    expect(mid(at("backorder"))).toBeGreaterThan(mid(at("stock")));
    expect(at("pay").x).toBeGreaterThan(at("stock").x);
    expect(mid(at("ship"))).toBeCloseTo(mid(at("paid")));
  });

  test("a long chain wraps into rows instead of one wide ribbon", () => {
    const layout = layoutDiagram(STRESS.flowChain8 ?? spec("flow", []), estimateText);
    const rows = new Set(layout.nodes.map((n) => Math.round(n.rect.y + n.rect.h / 2)));
    expect(rows.size).toBe(2);
    expect(layout.bounds.w).toBeLessThan(1400);
  });

  test("cycle nodes sit evenly around one center, first at the top", () => {
    const layout = layoutDiagram(STRESS.cycle8 ?? spec("cycle", []), estimateText);
    const first = layout.nodes[0]?.rect;
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(Math.abs(first.x + first.w / 2)).toBeLessThan(1);
    expect(first.y + first.h / 2).toBeLessThan(0);
    expect(layout.connectors.length).toBe(8);
    for (const c of layout.connectors) expect(c.points.length).toBeGreaterThanOrEqual(3);
  });

  test("small cycle puts its title in the middle", () => {
    const layout = layoutDiagram(spec("cycle", [{ id: "plan" }, { id: "do" }, { id: "check" }, { id: "act" }], { title: "PDCA" }), estimateText);
    expect(layout.title.inside).toBe(true);
  });

  test("mindmap balances arms left and right of the center", () => {
    const layout = layoutDiagram(STRESS.mindmap12 ?? spec("mindmap", []), estimateText);
    const centerX = (layout.nodes.find((n) => n.role === "center")?.rect.x ?? 0) + 1;
    const arms = ["coins", "upgrades", "areas", "social"].map((id) => layout.nodes.find((n) => n.id === id)?.rect.x ?? 0);
    expect(arms.filter((x) => x > centerX).length).toBe(2);
    // Children share their arm's color.
    expect(layout.nodes.find((n) => n.id === "tasks")?.color).toBe("yellow");
  });

  test("a long mindmap center grows wide as a rounded box instead of a tall ellipse", () => {
    const layout = layoutDiagram(STRESS.mindmapLong ?? spec("mindmap", []), estimateText);
    const hub = layout.nodes.find((n) => n.role === "center");
    expect(hub).toBeDefined();
    if (hub === undefined) return;
    expect(hub.shape).toBe("box");
    expect(hub.rect.w).toBeLessThanOrEqual(320);
    expect(hub.rect.w).toBeGreaterThan(hub.rect.h);
    expect(lineCount(hub.text.text)).toBeLessThanOrEqual(4);
  });

  test("a short mindmap center stays an ellipse wider than it is tall", () => {
    const layout = layoutDiagram(spec("mindmap", [{ id: "hub", label: "Habit app" }, { id: "a", parent: "hub" }, { id: "b", parent: "hub" }]), estimateText);
    const hub = layout.nodes.find((n) => n.role === "center");
    expect(hub?.shape).toBe("ellipse");
    if (hub !== undefined) expect(hub.rect.w / hub.rect.h).toBeGreaterThanOrEqual(1.34);
  });

  test("mindmap links run from the center's edge to each child's edge", () => {
    const layout = layoutDiagram(STRESS.mindmapLong ?? spec("mindmap", []), estimateText);
    const rect = (id: string | null) => layout.nodes.find((n) => n.id === id)?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    const hub = layout.nodes.find((n) => n.role === "center");
    for (const c of layout.connectors) {
      const start = c.points[0];
      const end = c.points[c.points.length - 1];
      if (start === undefined || end === undefined || hub === undefined) throw new Error("empty connector");
      const from = rect(c.from);
      const to = rect(c.to);
      // Each end sits just outside its node's side, level with it: no stub hanging in the air.
      const nearSide = (p: { x: number; y: number }, r: Rect) =>
        Math.min(Math.abs(p.x - r.x), Math.abs(p.x - (r.x + r.w))) <= 10 && p.y >= r.y && p.y <= r.y + r.h;
      expect(nearSide(start, from)).toBe(true);
      expect(nearSide(end, to)).toBe(true);
    }
  });

  test("mindmap arms split evenly left and right, spaced evenly down each side", () => {
    const layout = layoutDiagram(STRESS.mindmapLong ?? spec("mindmap", []), estimateText);
    const hub = layout.nodes.find((n) => n.role === "center")?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    const arms = layout.nodes.filter((n) => n.role !== "center").map((n) => n.rect);
    const right = arms.filter((r) => r.x > hub.x).sort((a, b) => a.y - b.y);
    const left = arms.filter((r) => r.x < hub.x).sort((a, b) => a.y - b.y);
    expect(Math.abs(right.length - left.length)).toBeLessThanOrEqual(1);
    for (const side of [left, right]) {
      const gaps = side.slice(1).map((r, i) => r.y - ((side[i]?.y ?? 0) + (side[i]?.h ?? 0)));
      for (const g of gaps) expect(g).toBeCloseTo(gaps[0] ?? g, 0);
    }
  });

  test("long labels widen nodes before they grow tall, and long ellipses become boxes", () => {
    for (const name of ["cycleLong", "flowLong", "treeLong"]) {
      const layout = layoutDiagram(STRESS[name] ?? spec("flow", []), estimateText);
      for (const n of layout.nodes) {
        expect(lineCount(n.text.text)).toBeLessThanOrEqual(5);
        if (n.shape === "ellipse") expect(lineCount(n.text.text)).toBeLessThanOrEqual(3);
        expect(n.rect.h).toBeLessThan(n.rect.w);
      }
    }
  });

  test("tree levels go top-down and parents center over children", () => {
    const layout = layoutDiagram(STRESS.tree3 ?? spec("tree", []), estimateText);
    const r = (id: string) => layout.nodes.find((n) => n.id === id)?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    expect(r("eng").y).toBeGreaterThan(r("ceo").y);
    expect(r("edge").y).toBeGreaterThan(r("api").y);
    const cx = (x: Rect) => x.x + x.w / 2;
    expect(cx(r("api"))).toBeCloseTo((cx(r("edge")) + cx(r("db"))) / 2);
  });

  test("timeline alternates cards and splits dates off", () => {
    const layout = layoutDiagram(STRESS.timeline7 ?? spec("timeline", []), estimateText);
    const ys = layout.nodes.map((n) => n.rect.y < 0);
    expect(ys).toEqual([true, false, true, false, true, false, true]);
    expect(layout.decos.filter((d) => d.kind === "text").length).toBe(7);
    expect(splitDate("Q2 2027: Private beta")).toEqual({ date: "Q2 2027", rest: "Private beta" });
    expect(splitDate("Just a milestone")).toBeNull();
  });

  test("funnel narrows downward and labels fit the narrow edge", () => {
    const layout = layoutDiagram(STRESS.funnel5 ?? spec("funnel", []), estimateText);
    const widths = layout.nodes.map((n) => n.rect.w);
    for (let i = 1; i < widths.length; i++) expect(widths[i] ?? 0).toBeLessThan(widths[i - 1] ?? 0);
    for (const n of layout.nodes) {
      const bottom = n.polygon?.[2];
      expect(bottom).toBeDefined();
      if (bottom !== undefined) expect(n.text.rect.w).toBeLessThan(bottom.x * 2 - 40);
    }
  });

  test("quadrant puts items inside their cell", () => {
    const layout = layoutDiagram(STRESS.quadrant ?? spec("quadrant", []), estimateText);
    const cell = (id: string) => layout.nodes.find((n) => n.id === id)?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    const item = (id: string) => cell(id);
    expect(contains(cell("quick-wins"), item("dark-mode"))).toBe(true);
    expect(contains(cell("money-pits"), item("rewrite"))).toBe(true);
    expect(layout.decos.filter((d) => d.kind === "text").length).toBe(2);
  });
});
