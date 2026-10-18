// Stored board records. IndexedDB hands back whatever an older build (or a broken one) wrote, so every read goes
// through these schemas and anything that fails is skipped rather than trusted.
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import { z } from "zod";
import { ConversationMemory, EMPTY_MEMORY } from "../conversation/memory";

export const BoardId = z
  .string()
  .regex(/^[a-z0-9]{6,32}$/)
  .brand<"BoardId">();
export type BoardId = z.infer<typeof BoardId>;

export const TITLE_MAX = 80;

/** The light part of a board, loaded for every board to draw the sidebar. */
export const BoardMeta = z.object({
  version: z.literal(1),
  id: BoardId,
  title: z.string().max(TITLE_MAX),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});
export type BoardMeta = z.infer<typeof BoardMeta>;

/**
 * Excalidraw elements are a large, versioned union that Excalidraw's own restore() repairs on load. We check the
 * fields every element has so junk never reaches it, and leave the rest to restore().
 */
const ELEMENT_TYPES = new Set(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "image", "frame", "magicframe", "embeddable", "iframe", "selection"]);
function isElementLike(value: unknown): value is ExcalidrawElement {
  if (typeof value !== "object" || value === null) return false;
  const fields: Record<string, unknown> = { ...value };
  return (
    typeof fields.id === "string" &&
    typeof fields.type === "string" &&
    ELEMENT_TYPES.has(fields.type) &&
    ["x", "y", "width", "height", "version"].every((key) => typeof fields[key] === "number" && Number.isFinite(fields[key]))
  );
}
export const SceneElement = z.custom<ExcalidrawElement>(isElementLike, { message: "Not an Excalidraw element" });

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/gif", "image/webp", "image/bmp", "image/x-icon", "image/avif", "image/jfif"]);
function isImageMime(value: unknown): value is BinaryFileData["mimeType"] {
  return typeof value === "string" && IMAGE_MIMES.has(value);
}
function isFileId(value: unknown): value is FileId {
  return typeof value === "string" && value.length > 0;
}
function isDataURL(value: unknown): value is DataURL {
  return typeof value === "string" && value.startsWith("data:");
}

/** A generated or pasted image. Keyed by its Excalidraw file id. */
export const StoredFile = z.object({
  id: z.custom<FileId>(isFileId),
  mimeType: z.custom<BinaryFileData["mimeType"]>(isImageMime),
  dataURL: z.custom<DataURL>(isDataURL),
  created: z.number().finite(),
});
export type StoredFile = z.infer<typeof StoredFile>;

/** The parts of Excalidraw's app state worth bringing back: where you were looking and how the board looks. */
export const StoredView = z.object({
  scrollX: z.number().finite(),
  scrollY: z.number().finite(),
  zoom: z.number().min(0.1).max(30),
  theme: z.enum(["light", "dark"]),
  viewBackgroundColor: z.string().max(64),
});
export type StoredView = z.infer<typeof StoredView>;

/** Keeps the items that parse and drops the rest, so one bad element or file never costs the whole board. */
function lenientArray<T extends z.ZodType>(item: T) {
  return z.array(z.unknown()).transform((items) =>
    items.flatMap((raw): z.output<T>[] => {
      const parsed = item.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}

export const StoredScene = z.object({
  elements: lenientArray(SceneElement),
  files: lenientArray(StoredFile),
  view: StoredView.nullable().catch(null),
});
export type StoredScene = z.infer<typeof StoredScene>;

/** The heavy part of a board, loaded only when it is opened. */
export const BoardData = z.object({
  version: z.literal(1),
  id: BoardId,
  scene: StoredScene,
  /** Losing the conversation is better than losing the drawing. */
  memory: ConversationMemory.catch(EMPTY_MEMORY),
});
export type BoardData = z.infer<typeof BoardData>;

export const EMPTY_SCENE: StoredScene = { elements: [], files: [], view: null };

export function emptyData(id: BoardId): BoardData {
  return { version: 1, id, scene: EMPTY_SCENE, memory: EMPTY_MEMORY };
}

/** Small preview image, generated after saves. */
export const BoardThumb = z.object({ version: z.literal(1), id: BoardId, dataUrl: z.string().startsWith("data:image/").max(400_000) });
export type BoardThumb = z.infer<typeof BoardThumb>;
