// IndexedDB storage for the board store, via idb-keyval. One database per record kind keeps listing boards cheap:
// the sidebar reads only the meta database and never pulls a scene.
import { createStore, del, get, set, values } from "idb-keyval";
import { memoryKeyValue } from "./store";
import type { Journal, KeyValue } from "./store";

/**
 * Private windows and strict privacy settings can block IndexedDB, which made the app hang on a blank board.
 * The first failure switches this database to memory for the session, so boards still work, just without saving.
 */
function idbKeyValue(dbName: string): KeyValue {
  let store: ReturnType<typeof createStore> | null = null;
  try {
    store = createStore(dbName, "records");
  } catch {
    store = null;
  }
  const memory = memoryKeyValue();
  const guarded =
    <A extends unknown[], R>(idb: (target: ReturnType<typeof createStore>, ...args: A) => Promise<R>, fallback: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (store === null) return fallback(...args);
      try {
        return await idb(store, ...args);
      } catch {
        store = null;
        return fallback(...args);
      }
    };
  return {
    get: guarded((target, key: string) => get<unknown>(key, target), memory.get),
    set: guarded((target, key: string, value: unknown) => set(key, value, target), memory.set),
    del: guarded((target, key: string) => del(key, target), memory.del),
    values: guarded((target) => values<unknown>(target), memory.values),
  };
}

export function idbStorage(): { meta: KeyValue; data: KeyValue; thumbs: KeyValue } {
  return { meta: idbKeyValue("rtw-boards-meta"), data: idbKeyValue("rtw-boards-data"), thumbs: idbKeyValue("rtw-boards-thumbs") };
}

const JOURNAL_PREFIX = "rtw:board-journal:";

/** localStorage journal for saves forced at pagehide; see Journal in store.ts. */
export function localJournal(): Journal {
  return {
    keys: () => safeStorageKeys().flatMap((key) => (key.startsWith(JOURNAL_PREFIX) ? [key.slice(JOURNAL_PREFIX.length)] : [])),
    get(key) {
      let raw: string | null;
      try {
        raw = window.localStorage.getItem(JOURNAL_PREFIX + key);
      } catch {
        return undefined;
      }
      if (raw === null) return undefined;
      try {
        const value: unknown = JSON.parse(raw);
        return value;
      } catch {
        return undefined;
      }
    },
    set: (key, value) => {
      try {
        window.localStorage.setItem(JOURNAL_PREFIX + key, JSON.stringify(value));
      } catch {
        // Storage blocked or full: the IndexedDB (or memory) save still runs.
      }
    },
    del: (key) => {
      try {
        window.localStorage.removeItem(JOURNAL_PREFIX + key);
      } catch {
        // Nothing was journaled if storage is blocked.
      }
    },
  };
}

function safeStorageKeys(): string[] {
  try {
    return Object.keys(window.localStorage);
  } catch {
    return [];
  }
}
