import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { BoardsApp } from "./boards/BoardsApp";
import { idbStorage } from "./boards/idb";
import { createBoardStore } from "./boards/store";

function reportBoardsError(error: unknown) {
  console.error("[boards]", error);
}

const store = createBoardStore({
  ...idbStorage(),
  onCorrupt: ({ store: kind, key, error }) => console.warn("[boards] skipped unreadable record", { kind, key, error }),
});

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <BoardsApp store={store} Screen={App} onError={reportBoardsError} />
    </StrictMode>,
  );
}
