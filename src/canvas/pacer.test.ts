/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { BoardOp } from "../../shared/board";
import type { PacedTask } from "./pacer";
import { createPacer, enqueue } from "./pacer";

const shape = (id: string, placement: Extract<BoardOp, { op: "add_shape" }>["placement"] = { kind: "auto" }): PacedTask => ({
  kind: "op",
  op: { op: "add_shape", id, shape: "box", label: id, color: "blue", placement },
});
const del = (...ids: [string, ...string[]]): PacedTask => ({ kind: "op", op: { op: "delete", ids } });
const names = (tasks: readonly PacedTask[]) => tasks.map((t) => (t.kind === "task" ? "task" : t.op.op === "delete" ? `del:${t.op.ids.join(",")}` : t.op.op === "add_shape" ? t.op.id : t.op.op));

describe("enqueue", () => {
  test("a delete moves ahead of unrelated adds", () => {
    expect(names(enqueue([shape("a"), shape("b")], del("old")))).toEqual(["del:old", "a", "b"]);
  });

  test("a delete stays behind the add it is about", () => {
    expect(names(enqueue([shape("a"), shape("b")], del("a")))).toEqual(["a", "del:a", "b"]);
  });

  test("an add taking the doomed item's spot still waits for the delete", () => {
    expect(names(enqueue([shape("clean", { kind: "at", target: "sketch-1" })], del("sketch-1")))).toEqual(["del:sketch-1", "clean"]);
  });

  test("a delete never jumps a diagram that reuses its ids", () => {
    const diagram: PacedTask = {
      kind: "op",
      op: {
        op: "add_diagram",
        id: "loop",
        kind: "cycle",
        title: "Loop",
        nodes: [
          { id: "a", label: "A", color: "blue", shape: "box", parent: null },
          { id: "b", label: "B", color: "blue", shape: "box", parent: null },
        ],
        links: [],
        axes: [],
        placement: { kind: "auto" },
      },
    };
    expect(names(enqueue([diagram], del("a")))).toEqual(["add_diagram", "del:a"]);
  });

  test("deletes keep their own order and never pass a clear", () => {
    const clear: PacedTask = { kind: "op", op: { op: "clear" } };
    expect(names(enqueue([del("x"), shape("a")], del("y")))).toEqual(["del:x", "del:y", "a"]);
    expect(names(enqueue([clear, shape("a")], del("y")))).toEqual(["clear", "del:y", "a"]);
  });
});

describe("createPacer", () => {
  function harness() {
    let now = 0;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 1;
    const ran: string[] = [];
    const pacer = createPacer({
      run: (task) => ran.push(...names([task])),
      schedule: (fn, ms) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      cancel: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
      now: () => now,
    });
    const advance = (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (next === undefined || next.at > end) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = end;
    };
    return { pacer, ran, advance };
  }

  test("a lone op applies at once", () => {
    const { pacer, ran } = harness();
    pacer.push(shape("a"));
    expect(ran).toEqual(["a"]);
  });

  test("a burst lands one at a time, deletes first", () => {
    const { pacer, ran, advance } = harness();
    pacer.push(shape("a"));
    pacer.push(shape("b"));
    pacer.push(shape("c"));
    pacer.push(del("old"));
    expect(ran).toEqual(["a"]);
    expect(pacer.waiting()).toBe(3);
    advance(150);
    expect(ran).toEqual(["a"]);
    advance(100);
    expect(ran).toEqual(["a", "del:old"]);
    advance(2000);
    expect(ran).toEqual(["a", "del:old", "b", "c"]);
    expect(pacer.waiting()).toBe(0);
  });

  test("an op arriving after the beat runs immediately again", () => {
    const { pacer, ran, advance } = harness();
    pacer.push(shape("a"));
    advance(1000);
    pacer.push(shape("b"));
    expect(ran).toEqual(["a", "b"]);
  });
});
