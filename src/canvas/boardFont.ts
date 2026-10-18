// Loads the board font up front. Layout measures labels the moment an op arrives; if the face is not loaded yet the
// browser measures with a fallback (or a system font of the same name) and boxes come out too small for their words.
// Excalidraw registers the same face itself when it first draws text; a second identical face is harmless.
const BOARD_FONT_URL = "/fonts/Liberation/LiberationSans-Regular.woff2";

export function preloadBoardFont(): void {
  if (typeof FontFace === "undefined") return;
  const face = new FontFace("Liberation Sans", `url(${BOARD_FONT_URL}) format("woff2")`, { display: "block" });
  document.fonts.add(face);
  face.load().catch(() => {
    // Offline or blocked: Excalidraw falls back to its CDN copy and re-measures once a face loads.
  });
}
