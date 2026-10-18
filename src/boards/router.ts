// Board URLs: `/b/<id>` opens a board, `/` opens the most recent one. History API only; the query string
// (for example `?mock`) is kept across navigation so dev switches survive.
import { BoardId } from "./schema";

export type Route = { kind: "root" } | { kind: "board"; id: BoardId } | { kind: "unknown" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { kind: "root" };
  const match = /^\/b\/([^/]+)\/?$/.exec(pathname);
  if (match === null) return { kind: "unknown" };
  const id = BoardId.safeParse(match[1]);
  return id.success ? { kind: "board", id: id.data } : { kind: "unknown" };
}

export function boardPath(id: BoardId): string {
  return `/b/${id}`;
}

export function currentRoute(): Route {
  return parseRoute(window.location.pathname);
}

export function navigateToBoard(id: BoardId, options: { replace?: boolean } = {}): void {
  const url = `${boardPath(id)}${window.location.search}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  if (options.replace === true) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function subscribeRoute(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
