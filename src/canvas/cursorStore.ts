// Where the partner's cursor is, in scene coordinates, for the shell to draw. Excalidraw's collaborator pointer would
// draw it on the canvas in Excalidraw's style; publishing it here lets the shell draw its own.
export type PartnerCursor = {
  x: number;
  y: number;
  /** What it is doing, shown beside the arrow; null when it just points. */
  status: "thinking" | "tidying" | null;
};

export type CursorStore = {
  get(): PartnerCursor | null;
  set(next: PartnerCursor | null): void;
  subscribe(listener: (cursor: PartnerCursor | null) => void): () => void;
};

export function createCursorStore(): CursorStore {
  let current: PartnerCursor | null = null;
  const listeners = new Set<(cursor: PartnerCursor | null) => void>();
  return {
    get: () => current,
    set(next) {
      if (next === current) return;
      if (next !== null && current !== null && next.x === current.x && next.y === current.y && next.status === current.status) return;
      current = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
