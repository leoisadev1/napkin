import { describe, expect, test } from "bun:test";
import { EMPTY_MEMORY } from "../conversation/memory";
import { parseRoute } from "./router";
import type { BoardMeta } from "./schema";
import type { BoardData } from "./schema";
import { BoardId, SceneElement, StoredFile } from "./schema";
import type { BoardStore } from "./store";
import { createBoardStore, memoryKeyValue, normalizeTitle, sortBoards } from "./store";

function setup(options: { meta?: [string, unknown][]; data?: [string, unknown][]; thumbs?: [string, unknown][] } = {}) {
  let clock = 1_000;
  let seq = 0;
  const meta = memoryKeyValue(options.meta);
  const data = memoryKeyValue(options.data);
  const thumbs = memoryKeyValue(options.thumbs);
  const corrupt: string[] = [];
  const store = createBoardStore({
    meta,
    data,
    thumbs,
    now: () => clock,
    newId: () => BoardId.parse(`board${(seq++).toString().padStart(4, "0")}`),
    onCorrupt: ({ store: kind, key }) => corrupt.push(`${kind}:${key ?? "?"}`),
  });
  return { store, meta, data, thumbs, corrupt, tick: (ms: number) => (clock += ms) };
}

const rect = {
  id: "el-1",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  version: 3,
  versionNonce: 7,
  isDeleted: false,
  customData: { rtw: { kind: "shape", nodeId: "pay", role: "root", shape: "box", color: "blue" } },
};

function boardsOf(store: BoardStore): readonly BoardMeta[] {
  const snapshot = store.getSnapshot();
  return snapshot.status === "ready" ? snapshot.boards : [];
}

describe("board store", () => {
  test("create, reload from storage, and keep scene, files, view and memory", async () => {
    const { store, meta, data, thumbs } = setup();
    await store.init();
    const board = await store.create();
    const record: BoardData = {
      version: 1,
      id: board.id,
      scene: {
        // Stored elements come back through zod; these are the shapes Excalidraw hands us.
        elements: [SceneElement.parse(rect)],
        files: [StoredFile.parse({ id: "file-1", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 5 })],
        view: { scrollX: -40, scrollY: 12, zoom: 0.8, theme: "dark", viewBackgroundColor: "#ffffff" },
      },
      memory: {
        ...EMPTY_MEMORY,
        history: [{ role: "user", text: "Draw a payment service" }],
        transcript: [{ id: "t1", role: "user", text: "Draw a payment service", final: true }],
        suggestions: ["Add fraud checks"],
        imageAttempted: true,
      },
    };
    await store.save(record, { touched: true });
    await store.saveThumb(board.id, "data:image/png;base64,BBBB");

    // A fresh store over the same storage is what a page reload sees.
    const reloaded = createBoardStore({ meta, data, thumbs });
    await reloaded.init();
    expect(boardsOf(reloaded).map((b) => b.id)).toEqual([board.id]);
    const loaded = await reloaded.load(board.id);
    expect(loaded.scene.view).toEqual(record.scene.view);
    expect(loaded.scene.files.map((f) => String(f.id))).toEqual(["file-1"]);
    expect(loaded.scene.elements.map((el) => el.id)).toEqual(["el-1"]);
    expect(loaded.memory).toEqual(record.memory);
    const snapshot = reloaded.getSnapshot();
    expect(snapshot.status === "ready" && snapshot.thumbs.get(board.id)).toBe("data:image/png;base64,BBBB");
  });

  test("skips unreadable meta records and opens unreadable data as an empty board", async () => {
    const good = { version: 1, id: "goodboard1", title: "Good", createdAt: 1, updatedAt: 2 };
    const { store, corrupt } = setup({
      meta: [
        ["goodboard1", good],
        ["old", { title: "From an old build" }],
        ["bad-id", { ...good, id: "NOT VALID!" }],
        ["nan", { ...good, id: "nanboard12", updatedAt: Number.NaN }],
        ["junk", "not even an object"],
      ],
      data: [["goodboard1", { version: 2, id: "goodboard1", scene: "from the future" }]],
    });
    await store.init();
    expect(boardsOf(store).map((b) => b.id)).toEqual([BoardId.parse("goodboard1")]);
    expect(corrupt.filter((entry) => entry.startsWith("meta:"))).toHaveLength(4);
    const loaded = await store.load(BoardId.parse("goodboard1"));
    expect(loaded.scene.elements).toEqual([]);
    expect(loaded.memory).toEqual(EMPTY_MEMORY);
    expect(corrupt).toContain("data:goodboard1");
  });

  test("drops junk elements, non-image files and broken memory but keeps the rest of the board", async () => {
    const { store } = setup({
      meta: [["goodboard2", { version: 1, id: "goodboard2", title: "G", createdAt: 1, updatedAt: 1 }]],
      data: [
        [
          "goodboard2",
          {
            version: 1,
            id: "goodboard2",
            scene: {
              elements: [rect, { ...rect, id: "x", type: "spaceship" }, { ...rect, id: "y", width: "wide" }, null],
              files: [
                { id: "img", mimeType: "image/png", dataURL: "data:image/png;base64,AA", created: 1 },
                { id: "exe", mimeType: "application/x-msdownload", dataURL: "data:application/x-msdownload;base64,AA", created: 1 },
              ],
              view: { scrollX: "nope" },
            },
            memory: { history: "corrupted" },
          },
        ],
      ],
    });
    await store.init();
    const loaded = await store.load(BoardId.parse("goodboard2"));
    expect(loaded.scene.elements.map((el) => el.id)).toEqual(["el-1"]);
    expect(loaded.scene.files.map((file) => String(file.id))).toEqual(["img"]);
    expect(loaded.scene.view).toBeNull();
    expect(loaded.memory).toEqual(EMPTY_MEMORY);
  });

  test("orders by last edit, newest first, and only real edits move a board up", async () => {
    const { store, tick } = setup();
    await store.init();
    const a = await store.create({ title: "A" });
    tick(10);
    const b = await store.create({ title: "B" });
    tick(10);
    const c = await store.create({ title: "C" });
    expect(boardsOf(store).map((x) => x.title)).toEqual(["C", "B", "A"]);

    tick(10);
    await store.save({ ...(await store.load(a.id)) }, { touched: true });
    expect(boardsOf(store).map((x) => x.title)).toEqual(["A", "C", "B"]);

    tick(10);
    // A camera move saves but does not count as an edit.
    await store.save({ ...(await store.load(b.id)) }, { touched: false });
    expect(boardsOf(store).map((x) => x.title)).toEqual(["A", "C", "B"]);
    expect(store.latest()?.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });

  test("same-millisecond writes still order", async () => {
    const { store } = setup();
    await store.init();
    const first = await store.create();
    const second = await store.create();
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(boardsOf(store)[0]?.id).toBe(second.id);
  });

  test("rename normalizes, ignores no-ops, and survives reload", async () => {
    const { store, meta, data, thumbs } = setup();
    await store.init();
    const board = await store.create();
    let notified = 0;
    store.subscribe(() => notified++);
    await store.rename(board.id, "   Launch   plan  ");
    expect(store.get(board.id)?.title).toBe("Launch plan");
    await store.rename(board.id, "Launch plan");
    expect(notified).toBe(1);
    await store.rename(board.id, "   ");
    expect(store.get(board.id)?.title).toBe("Untitled board");
    await store.rename(board.id, "x".repeat(200));
    expect(store.get(board.id)?.title).toHaveLength(80);
    const reloaded = createBoardStore({ meta, data, thumbs });
    await reloaded.init();
    expect(reloaded.get(board.id)?.title).toBe("x".repeat(80));
  });

  test("delete removes every record and restore brings it all back", async () => {
    const { store, meta, data, thumbs } = setup();
    await store.init();
    const keep = await store.create({ title: "Keep" });
    const gone = await store.create({ title: "Gone" });
    await store.save({ ...(await store.load(gone.id)), memory: { ...EMPTY_MEMORY, suggestions: ["hi"] } }, { touched: true });
    await store.saveThumb(gone.id, "data:image/png;base64,CCCC");

    const removed = await store.remove(gone.id);
    expect(removed?.meta.title).toBe("Gone");
    expect(boardsOf(store).map((b) => b.id)).toEqual([keep.id]);
    expect([meta.entries.has(gone.id), data.entries.has(gone.id), thumbs.entries.has(gone.id)]).toEqual([false, false, false]);
    expect(await store.remove(gone.id)).toBeNull();

    // A late autosave from the closing board must not resurrect it.
    await store.save({ ...(await store.load(gone.id)) }, { touched: true });
    expect(data.entries.has(gone.id)).toBe(false);

    if (removed === null) throw new Error("expected a removed board");
    await store.restore(removed);
    expect(boardsOf(store).map((b) => b.title).sort()).toEqual(["Gone", "Keep"]);
    expect((await store.load(gone.id)).memory.suggestions).toEqual(["hi"]);
    const snapshot = store.getSnapshot();
    expect(snapshot.status === "ready" && snapshot.thumbs.get(gone.id)).toBe("data:image/png;base64,CCCC");
  });

  test("reads queue behind writes", async () => {
    const { store } = setup();
    await store.init();
    const board = await store.create();
    const empty = await store.load(board.id);
    void store.save({ ...empty, memory: { ...EMPTY_MEMORY, suggestions: ["queued"] } }, { touched: false });
    // Not awaited above: the load must still see that save.
    expect((await store.load(board.id)).memory.suggestions).toEqual(["queued"]);
  });
});

describe("helpers", () => {
  test("normalizeTitle", () => {
    expect(normalizeTitle(" a \n b ")).toBe("a b");
    expect(normalizeTitle("")).toBe("Untitled board");
  });

  test("sortBoards breaks ties by creation then id", () => {
    const base = { version: 1 as const, title: "t", updatedAt: 5 };
    const rows: BoardMeta[] = [
      { ...base, id: BoardId.parse("bbbbbb"), createdAt: 1 },
      { ...base, id: BoardId.parse("aaaaaa"), createdAt: 1 },
      { ...base, id: BoardId.parse("cccccc"), createdAt: 2 },
    ];
    expect(sortBoards(rows).map((r) => r.id)).toEqual(["cccccc", "aaaaaa", "bbbbbb"].map((id) => BoardId.parse(id)));
  });

  test("parseRoute", () => {
    expect(parseRoute("/")).toEqual({ kind: "root" });
    expect(parseRoute("/b/abc123def")).toEqual({ kind: "board", id: BoardId.parse("abc123def") });
    expect(parseRoute("/b/abc123def/")).toEqual({ kind: "board", id: BoardId.parse("abc123def") });
    expect(parseRoute("/b/../etc")).toEqual({ kind: "unknown" });
    expect(parseRoute("/settings")).toEqual({ kind: "unknown" });
  });
});
