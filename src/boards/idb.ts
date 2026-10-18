// IndexedDB storage for the board store, via idb-keyval. One database per record kind keeps listing boards cheap:
// the sidebar reads only the meta database and never pulls a scene.
import { createStore, del, get, set, values } from "idb-keyval";
import type { Journal, KeyValue } from "./store";

function idbKeyValue(dbName: string): KeyValue {
  const store = createStore(dbName, "records");
  return {
    get: (key) => get<unknown>(key, store),
    set: (key, value) => set(key, value, store),
    del: (key) => del(key, store),
    values: () => values<unknown>(store),
  };
}

export function idbStorage(): { meta: KeyValue; data: KeyValue; thumbs: KeyValue } {
  return { meta: idbKeyValue("rtw-boards-meta"), data: idbKeyValue("rtw-boards-data"), thumbs: idbKeyValue("rtw-boards-thumbs") };
}

const JOURNAL_PREFIX = "rtw:board-journal:";

/** localStorage journal for saves forced at pagehide; see Journal in store.ts. */
export function localJournal(): Journal {
  return {
    keys: () => Object.keys(window.localStorage).flatMap((key) => (key.startsWith(JOURNAL_PREFIX) ? [key.slice(JOURNAL_PREFIX.length)] : [])),
    get(key) {
      const raw = window.localStorage.getItem(JOURNAL_PREFIX + key);
      if (raw === null) return undefined;
      try {
        const value: unknown = JSON.parse(raw);
        return value;
      } catch {
        return undefined;
      }
    },
    set: (key, value) => window.localStorage.setItem(JOURNAL_PREFIX + key, JSON.stringify(value)),
    del: (key) => window.localStorage.removeItem(JOURNAL_PREFIX + key),
  };
}
