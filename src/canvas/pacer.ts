// Paces bursts of board ops so the board grows one item at a time instead of all at once. A lone op applies right
// away; ops that arrive while others are still waiting line up and apply with a short beat between them. Within the
// waiting line, deletes move ahead of adds (a refine's "remove the old boxes" lands before "draw the diagram") unless
// the delete is about something still waiting to be added.
import type { BoardOp, Placement } from "../../shared/board";

export type PacedTask = { kind: "op"; op: BoardOp } | { kind: "task"; run: () => void };

/** Ids an op creates or depends on, other than an `at` target (a delete may run before a replacement lands there). */
export function mentions(op: BoardOp): Set<string> {
  const placementIds = (p: Placement): string[] => {
    switch (p.kind) {
      case "auto":
      case "at_pointer":
      case "at":
        return [];
      case "near":
        return [p.target];
      case "inside":
        return [p.frame];
      default: {
        const _exhaustive: never = p;
        return _exhaustive;
      }
    }
  };
  switch (op.op) {
    case "add_shape":
    case "add_frame":
    case "add_mockup":
    case "add_image":
      return new Set([op.id, ...placementIds(op.placement)]);
    case "add_diagram":
      return new Set([op.id, ...op.nodes.map((n) => n.id), ...placementIds(op.placement)]);
    case "add_edge":
      return new Set([op.id, op.from, op.to]);
    case "update":
      return new Set([op.id]);
    case "move":
      return new Set([op.id, ...placementIds(op.placement)]);
    case "delete":
      return new Set(op.ids);
    case "set_title":
    case "clear":
      return new Set();
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

/** Where `incoming` joins the waiting line. Deletes slip ahead of unrelated adds, never past a clear or another delete. */
export function enqueue(waiting: readonly PacedTask[], incoming: PacedTask): PacedTask[] {
  if (incoming.kind !== "op" || incoming.op.op !== "delete") return [...waiting, incoming];
  const doomed = mentions(incoming.op);
  let at = waiting.length;
  while (at > 0) {
    const before = waiting[at - 1];
    if (before === undefined || before.kind !== "op") break;
    const op = before.op;
    if (op.op === "delete" || op.op === "clear") break;
    if ([...mentions(op)].some((id) => doomed.has(id))) break;
    at -= 1;
  }
  return [...waiting.slice(0, at), incoming, ...waiting.slice(at)];
}

/** The beat after an op: long enough for its entrance to read, shorter when a long line is waiting. */
export function beatAfter(task: PacedTask, waiting: number): number {
  const base = (() => {
    if (task.kind === "task") return 0;
    switch (task.op.op) {
      case "add_diagram":
        return 560;
      case "add_mockup":
        return 420;
      case "add_image":
      case "add_frame":
        return 260;
      case "delete":
        return 240;
      case "add_shape":
      case "move":
        return 210;
      case "add_edge":
      case "update":
        return 170;
      case "set_title":
        return 0;
      case "clear":
        return 300;
      default: {
        const _exhaustive: never = task.op;
        return _exhaustive;
      }
    }
  })();
  return waiting > 10 ? Math.round(base * 0.6) : base;
}

export type Pacer = {
  push(task: PacedTask): void;
  /** Ops still waiting to apply. */
  waiting(): number;
  dispose(): void;
};

export function createPacer(args: {
  run: (task: PacedTask) => void;
  schedule: (fn: () => void, ms: number) => number;
  cancel: (handle: number) => void;
  now: () => number;
}): Pacer {
  let line: PacedTask[] = [];
  let timer: number | null = null;
  /** When the next task may run. */
  let readyAt = 0;

  function step() {
    timer = null;
    const next = line[0];
    if (next === undefined) return;
    line = line.slice(1);
    args.run(next);
    readyAt = args.now() + beatAfter(next, line.length);
    if (line.length > 0) timer = args.schedule(step, Math.max(0, readyAt - args.now()));
  }

  return {
    push(task) {
      line = enqueue(line, task);
      if (timer !== null) return;
      const wait = readyAt - args.now();
      if (wait <= 0) step();
      else timer = args.schedule(step, wait);
    },
    waiting: () => line.length,
    dispose() {
      if (timer !== null) args.cancel(timer);
      timer = null;
      line = [];
    },
  };
}
