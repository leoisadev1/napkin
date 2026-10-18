// IndexedDB storage for the board store, via idb-keyval. One database per record kind keeps listing boards cheap:
// the sidebar reads only the meta database and never pulls a scene.
import { createStore, del, get, set, values } from "idb-keyval";
import type { KeyValue } from "./store";

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
