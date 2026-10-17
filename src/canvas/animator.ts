// Canvas motion that Excalidraw does not provide: staggered fade-in of new elements, a breathing
// pending card, things gliding aside when the board makes room, and the partner's cursor gliding to whatever it
// just drew. All updates use
// CaptureUpdateAction.NEVER so they never enter undo history; the committed state is always the final one.
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { LocalPoint } from "./builders";
import { localPoint } from "./builders";
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types";
import type { Point } from "./geometry";

const FADE_MS = 280;
const CURSOR_MS = 560;
const CURSOR_LINGER_MS = 2600;
const PULSE_MS = 1600;
/** How long the partner's outline stays on a new item after the cursor arrives. */
const HIGHLIGHT_MS = 1500;
/** Neighbours making room and frames growing: quick enough to keep up with speech, slow enough to follow. */
const GLIDE_MS = 340;

type Points = readonly LocalPoint[];
/** The part of an element that a glide moves. */
type Geometry = { x: number; y: number; width: number; height: number; points: Points | null };
type Glide = { from: Geometry; to: Geometry; start: number };

function geometryOf(el: ExcalidrawElement): Geometry {
  return { x: el.x, y: el.y, width: el.width, height: el.height, points: el.type === "arrow" || el.type === "line" ? el.points : null };
}

function sameGeometry(a: Geometry, b: Geometry): boolean {
  if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return false;
  if (a.points === null || b.points === null) return a.points === b.points;
  return a.points.length === b.points.length && a.points.every((p, i) => p[0] === b.points?.[i]?.[0] && p[1] === b.points?.[i]?.[1]);
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** Geometry part way from `a` to `b`. Arrows whose point count changed jump straight to the new shape. */
function between(a: Geometry, b: Geometry, k: number): Geometry {
  const points =
    a.points !== null && b.points !== null && a.points.length === b.points.length
      ? a.points.map((p, i) => {
          const q = b.points?.[i] ?? p;
          return localPoint(lerp(p[0], q[0], k), lerp(p[1], q[1], k));
        })
      : b.points;
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), width: lerp(a.width, b.width, k), height: lerp(a.height, b.height, k), points };
}

export const PARTNER_COLOR = { background: "#6965db", stroke: "#6965db" };
/**
 * Excalidraw ignores Collaborator.color for cursors and derives a pastel hue from a hash of the
 * collaborator id. This id hashes to hue 240, a lavender next to Excalidraw's own violet accent.
 */
const PARTNER_ID = "partner-7";

type Fade = { start: number; target: number };
type CursorState = {
  from: Point;
  to: Point;
  start: number;
  lastMove: number;
  selected: Record<string, true>;
};

function isSocketId(value: string): value is SocketId {
  return value.length > 0;
}
const PARTNER_SOCKET = "partner";

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export type Animator = ReturnType<typeof createAnimator>;

export function createAnimator(api: ExcalidrawImperativeAPI) {
  const fades = new Map<string, Fade>();
  const pulses = new Set<string>();
  const glides = new Map<string, Glide>();
  let cursor: CursorState | null = null;
  let frame: number | null = null;
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function opacityAt(el: ExcalidrawElement, now: number): number | null {
    const fade = fades.get(el.id);
    if (fade !== undefined) {
      const t = Math.min(1, Math.max(0, (now - fade.start) / FADE_MS));
      if (t >= 1) fades.delete(el.id);
      return Math.round(fade.target * easeOut(t));
    }
    if (pulses.has(el.id)) {
      const wave = 0.5 + 0.5 * Math.cos(((now % PULSE_MS) / PULSE_MS) * Math.PI * 2);
      return Math.round(55 + 45 * wave);
    }
    return null;
  }

  function geometryAt(el: ExcalidrawElement, now: number): Geometry | null {
    const glide = glides.get(el.id);
    if (glide === undefined) return null;
    const t = Math.min(1, Math.max(0, (now - glide.start) / GLIDE_MS));
    if (t >= 1) glides.delete(el.id);
    return between(glide.from, glide.to, easeOut(t));
  }

  function withGeometry(el: ExcalidrawElement, g: Geometry): ExcalidrawElement {
    const base = { x: g.x, y: g.y, width: g.width, height: g.height };
    return el.type === "arrow" || el.type === "line" ? newElementWith(el, { ...base, points: [...(g.points ?? el.points)] }) : newElementWith(el, base);
  }

  function tick(now: number) {
    frame = null;
    if (fades.size > 0 || pulses.size > 0 || glides.size > 0) {
      let changed = false;
      const elements = api.getSceneElementsIncludingDeleted().map((el) => {
        const opacity = opacityAt(el, now);
        const geometry = geometryAt(el, now);
        if ((opacity === null || opacity === el.opacity) && geometry === null) return el;
        changed = true;
        const moved = geometry === null ? el : withGeometry(el, geometry);
        return opacity === null || opacity === el.opacity ? moved : newElementWith(moved, { opacity });
      });
      // Drop ids that vanished (deleted by the user mid-fade).
      const live = new Set(elements.map((el) => el.id));
      for (const id of fades.keys()) if (!live.has(id)) fades.delete(id);
      for (const id of pulses) if (!live.has(id)) pulses.delete(id);
      for (const id of glides.keys()) if (!live.has(id)) glides.delete(id);
      if (changed) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (cursor !== null) renderCursor(now);
    if (fades.size > 0 || pulses.size > 0 || glides.size > 0 || cursor !== null) schedule();
  }

  /**
   * Call right after committing a change. Every element that already existed in `before` and changed place or size
   * is put back where it was and glides to the committed spot. The committed state stays the real one: undo, other
   * transactions (after finishMotion) and the camera (through finalGeometry) all see the end positions.
   */
  function glideFrom(before: readonly ExcalidrawElement[]) {
    if (reduced()) return;
    const prior = new Map(before.filter((el) => !el.isDeleted).map((el) => [el.id, el]));
    const now = performance.now();
    let any = false;
    const elements = api.getSceneElementsIncludingDeleted().map((el) => {
      const old = prior.get(el.id);
      if (el.isDeleted || old === undefined) return el;
      const from = geometryOf(old);
      const to = geometryOf(el);
      if (sameGeometry(from, to)) return el;
      glides.set(el.id, { from, to, start: now });
      any = true;
      return withGeometry(el, from);
    });
    if (!any) return;
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    schedule();
  }

  /** Snaps every glide to its end, so the scene holds final positions before a transaction reads it. */
  function finishMotion() {
    if (glides.size === 0) return;
    const elements = api.getSceneElementsIncludingDeleted().map((el) => {
      const glide = glides.get(el.id);
      return glide === undefined ? el : withGeometry(el, glide.to);
    });
    glides.clear();
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
  }

  /** The elements as they will be once every glide lands. */
  function finalGeometry(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
    if (glides.size === 0) return [...elements];
    return elements.map((el) => {
      const glide = glides.get(el.id);
      return glide === undefined ? el : withGeometry(el, glide.to);
    });
  }

  function renderCursor(now: number) {
    if (cursor === null || !isSocketId(PARTNER_SOCKET)) return;
    if (now - cursor.lastMove > CURSOR_LINGER_MS) {
      cursor = null;
      api.updateScene({ collaborators: new Map(), captureUpdate: CaptureUpdateAction.NEVER });
      return;
    }
    const t = reduced() ? 1 : Math.min(1, (now - cursor.start) / CURSOR_MS);
    const k = easeInOut(t);
    const x = cursor.from.x + (cursor.to.x - cursor.from.x) * k;
    const y = cursor.from.y + (cursor.to.y - cursor.from.y) * k;
    const partner: Collaborator = {
      id: PARTNER_ID,
      username: "Partner",
      color: PARTNER_COLOR,
      pointer: { x, y, tool: "pointer" },
      // The outline shows once the cursor lands and clears after a beat, so it marks what is new without lingering.
      selectedElementIds: t >= 1 && now - cursor.start - CURSOR_MS < HIGHLIGHT_MS ? cursor.selected : {},
    };
    api.updateScene({ collaborators: new Map([[PARTNER_SOCKET, partner]]), captureUpdate: CaptureUpdateAction.NEVER });
  }

  function schedule() {
    if (frame === null) frame = requestAnimationFrame(tick);
  }

  /** Sets the new elements transparent right away (before paint), then fades them in with a stagger. */
  function fadeIn(groups: readonly (readonly ExcalidrawElement[])[], staggerMs: number) {
    if (reduced()) return;
    const now = performance.now();
    const ids = new Set<string>();
    for (const [index, group] of groups.entries()) {
      for (const el of group) {
        fades.set(el.id, { start: now + index * staggerMs, target: el.opacity });
        ids.add(el.id);
      }
    }
    const elements = api
      .getSceneElementsIncludingDeleted()
      .map((el) => (ids.has(el.id) ? newElementWith(el, { opacity: 0 }) : el));
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    schedule();
  }

  function pulse(ids: readonly string[]) {
    if (reduced()) return;
    for (const id of ids) pulses.add(id);
    schedule();
  }

  function stopPulse(ids: readonly string[]) {
    for (const id of ids) pulses.delete(id);
  }

  /** Glides the partner cursor to `to` and outlines `elementIds` once it arrives. */
  function pointAt(to: Point, elementIds: readonly string[]) {
    const now = performance.now();
    const from = cursor === null ? { x: to.x - 120, y: to.y + 90 } : currentCursor(now);
    cursor = { from, to, start: now, lastMove: now, selected: Object.fromEntries(elementIds.map((id) => [id, true] as const)) };
    schedule();
  }

  function currentCursor(now: number): Point {
    if (cursor === null) return { x: 0, y: 0 };
    const k = easeInOut(Math.min(1, (now - cursor.start) / CURSOR_MS));
    return { x: cursor.from.x + (cursor.to.x - cursor.from.x) * k, y: cursor.from.y + (cursor.to.y - cursor.from.y) * k };
  }

  function dispose() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    fades.clear();
    pulses.clear();
    glides.clear();
    cursor = null;
  }

  return { fadeIn, pulse, stopPulse, pointAt, glideFrom, finishMotion, finalGeometry, dispose };
}
