// Board store: the list of boards (light records, always in memory) plus each board's scene and conversation
// (heavy records, read on open). Storage is a tiny key-value interface so tests run on a Map and the app on IndexedDB.
// Every operation runs through one queue, so a read always sees the writes issued before it.
import type { BoardData, BoardThumb } from "./schema";
import { BoardData as BoardDataSchema, BoardId, BoardMeta, BoardThumb as BoardThumbSchema, emptyData, TITLE_MAX } from "./schema";

export const UNTITLED = "Untitled board";

export interface KeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  values(): Promise<unknown[]>;
}

export type BoardsSnapshot =
  | { status: "loading" }
  | { status: "ready"; boards: readonly BoardMeta[]; thumbs: ReadonlyMap<BoardId, string> };

/** Everything needed to put a deleted board back. */
export type RemovedBoard = { meta: BoardMeta; data: BoardData; thumb: BoardThumb | null };

export type BoardStore = ReturnType<typeof createBoardStore>;

export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || UNTITLED;
}

/** Most recently edited first; ties go to the newer board, then to id so the order is total. */
export function sortBoards(boards: Iterable<BoardMeta>): BoardMeta[] {
  return [...boards].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function randomBoardId(): BoardId {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return BoardId.parse(Array.from(bytes, (byte) => (byte % 36).toString(36)).join(""));
}

export function createBoardStore(options: {
  meta: KeyValue;
  data: KeyValue;
  thumbs: KeyValue;
  now?: () => number;
  newId?: () => BoardId;
  /** Called for each stored record that failed to parse and was skipped. */
  onCorrupt?: (info: { store: "meta" | "data" | "thumbs"; key: string | null; error: unknown }) => void;
}) {
  const { meta, data, thumbs, now = Date.now, newId = randomBoardId, onCorrupt } = options;
  const boards = new Map<BoardId, BoardMeta>();
  const thumbUrls = new Map<BoardId, string>();
  const listeners = new Set<() => void>();
  let snapshot: BoardsSnapshot = { status: "loading" };
  let queue: Promise<unknown> = Promise.resolve();
  let lastStamp = 0;

  /** Strictly increasing timestamps, so two saves in the same millisecond still order. */
  function stamp(): number {
    lastStamp = Math.max(now(), lastStamp + 1);
    return lastStamp;
  }

  function publish() {
    snapshot = { status: "ready", boards: sortBoards(boards.values()), thumbs: new Map(thumbUrls) };
    for (const listener of listeners) listener();
  }

  function run<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function init(): Promise<void> {
    await run(async () => {
      for (const raw of await meta.values()) {
        const parsed = BoardMeta.safeParse(raw);
        if (!parsed.success) {
          onCorrupt?.({ store: "meta", key: null, error: parsed.error });
          continue;
        }
        boards.set(parsed.data.id, parsed.data);
        lastStamp = Math.max(lastStamp, parsed.data.updatedAt);
      }
      for (const raw of await thumbs.values()) {
        const parsed = BoardThumbSchema.safeParse(raw);
        if (parsed.success && boards.has(parsed.data.id)) thumbUrls.set(parsed.data.id, parsed.data.dataUrl);
      }
    });
    publish();
  }

  function create(args: { title?: string } = {}): Promise<BoardMeta> {
    return run(async () => {
      const at = stamp();
      const board: BoardMeta = { version: 1, id: newId(), title: normalizeTitle(args.title ?? UNTITLED), createdAt: at, updatedAt: at };
      await meta.set(board.id, board);
      await data.set(board.id, emptyData(board.id));
      boards.set(board.id, board);
      publish();
      return board;
    });
  }

  /** A board's scene and conversation. A missing or unreadable record opens as an empty board. */
  function load(id: BoardId): Promise<BoardData> {
    return run(async () => {
      const raw = await data.get(id);
      if (raw === undefined) return emptyData(id);
      const parsed = BoardDataSchema.safeParse(raw);
      if (parsed.success && parsed.data.id === id) return parsed.data;
      onCorrupt?.({ store: "data", key: id, error: parsed.success ? new Error("Board id mismatch") : parsed.error });
      return emptyData(id);
    });
  }

  /**
   * Writes a board's scene and conversation. `touched` marks a real edit and moves the board to the top; camera
   * moves and other incidental saves pass false. A board deleted meanwhile is not resurrected.
   */
  function save(record: BoardData, args: { touched: boolean }): Promise<void> {
    return run(async () => {
      const current = boards.get(record.id);
      if (current === undefined) return;
      await data.set(record.id, record);
      if (!args.touched) return;
      const next: BoardMeta = { ...current, updatedAt: stamp() };
      await meta.set(next.id, next);
      boards.set(next.id, next);
      publish();
    });
  }

  function rename(id: BoardId, title: string): Promise<void> {
    return run(async () => {
      const current = boards.get(id);
      const nextTitle = normalizeTitle(title);
      if (current === undefined || current.title === nextTitle) return;
      const next: BoardMeta = { ...current, title: nextTitle, updatedAt: stamp() };
      await meta.set(id, next);
      boards.set(id, next);
      publish();
    });
  }

  function saveThumb(id: BoardId, dataUrl: string): Promise<void> {
    return run(async () => {
      if (!boards.has(id)) return;
      const parsed = BoardThumbSchema.safeParse({ version: 1, id, dataUrl });
      if (!parsed.success) return;
      await thumbs.set(id, parsed.data);
      thumbUrls.set(id, dataUrl);
      publish();
    });
  }

  /** Deletes a board and returns what restore() needs to bring it back, or null if it was already gone. */
  function remove(id: BoardId): Promise<RemovedBoard | null> {
    return run(async () => {
      const current = boards.get(id);
      if (current === undefined) return null;
      const rawData = BoardDataSchema.safeParse(await data.get(id));
      const rawThumb = BoardThumbSchema.safeParse(await thumbs.get(id));
      await Promise.all([meta.del(id), data.del(id), thumbs.del(id)]);
      boards.delete(id);
      thumbUrls.delete(id);
      publish();
      return { meta: current, data: rawData.success ? rawData.data : emptyData(id), thumb: rawThumb.success ? rawThumb.data : null };
    });
  }

  function restore(removed: RemovedBoard): Promise<void> {
    return run(async () => {
      await meta.set(removed.meta.id, removed.meta);
      await data.set(removed.meta.id, removed.data);
      if (removed.thumb !== null) await thumbs.set(removed.meta.id, removed.thumb);
      boards.set(removed.meta.id, removed.meta);
      if (removed.thumb !== null) thumbUrls.set(removed.meta.id, removed.thumb.dataUrl);
      publish();
    });
  }

  return {
    init,
    create,
    load,
    save,
    rename,
    saveThumb,
    remove,
    restore,
    get: (id: BoardId): BoardMeta | undefined => boards.get(id),
    /** Most recently edited board, if any. */
    latest: (): BoardMeta | undefined => sortBoards(boards.values())[0],
    getSnapshot: (): BoardsSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Resolves once every queued write has landed. */
    settled: (): Promise<void> => run(async () => undefined),
  };
}

/** In-memory storage for tests. */
export function memoryKeyValue(initial: Iterable<[string, unknown]> = []): KeyValue & { entries: Map<string, unknown> } {
  const entries = new Map(initial);
  return {
    entries,
    get: async (key) => entries.get(key),
    set: async (key, value) => {
      entries.set(key, structuredClone(value));
    },
    del: async (key) => {
      entries.delete(key);
    },
    values: async () => [...entries.values()],
  };
}
