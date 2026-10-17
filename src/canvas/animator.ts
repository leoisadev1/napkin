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
import { metaData, readMeta } from "./meta";

const FADE_MS = 280;
const CURSOR_MS = 560;
const CURSOR_LINGER_MS = 2600;
const PULSE_MS = 1600;
/** How long the partner's outline stays on a new item after the cursor arrives. */
const HIGHLIGHT_MS = 1500;
/** Neighbours making room and frames growing: quick enough to keep up with speech, slow enough to follow. */
const GLIDE_MS = 340;
/** Deleted things fade a little slower than new ones arrive, so a refine reads as a transformation. */
const EXIT_MS = 360;
/** A connector drawing itself from its start to its end. */
const DRAW_MS = 360;

type Points = readonly LocalPoint[];
/** The part of an element that a glide moves. */
type Geometry = { x: number; y: number; width: number; height: number; points: Points | null };
type Glide = { from: Geometry; to: Geometry; start: number; ms: number };
/** A ghost copy of something deleted, fading out before it is removed for good. */
type Exit = { start: number; from: number };

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
  const exits = new Map<string, Exit>();
  let ghostSeq = 0;
  let cursor: CursorState | null = null;
  /** Shown beside the partner's name ("…", "Tidying up…"). While set, the cursor stays instead of fading away. */
  let status: string | null = null;
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
    const t = Math.min(1, Math.max(0, (now - glide.start) / glide.ms));
    if (t >= 1) glides.delete(el.id);
    return between(glide.from, glide.to, easeOut(t));
  }

  function withGeometry(el: ExcalidrawElement, g: Geometry): ExcalidrawElement {
    const base = { x: g.x, y: g.y, width: g.width, height: g.height };
    return el.type === "arrow" || el.type === "line" ? newElementWith(el, { ...base, points: [...(g.points ?? el.points)] }) : newElementWith(el, base);
  }

  const busy = () => fades.size > 0 || pulses.size > 0 || glides.size > 0 || exits.size > 0;

  function tick(now: number) {
    frame = null;
    if (busy()) {
      let changed = false;
      const elements = api.getSceneElementsIncludingDeleted().map((el) => {
        const exit = exits.get(el.id);
        if (exit !== undefined) {
          changed = true;
          const t = Math.min(1, Math.max(0, (now - exit.start) / EXIT_MS));
          if (t >= 1) {
            exits.delete(el.id);
            return newElementWith(el, { isDeleted: true });
          }
          return newElementWith(el, { opacity: Math.round(exit.from * (1 - easeOut(t))) });
        }
        const opacity = opacityAt(el, now);
        const geometry = geometryAt(el, now);
        if ((opacity === null || opacity === el.opacity) && geometry === null) return el;
        changed = true;
        const moved = geometry === null ? el : withGeometry(el, geometry);
        return opacity === null || opacity === el.opacity ? moved : newElementWith(moved, { opacity });
      });
      // Drop ids that vanished (deleted by the user mid-fade).
      const live = new Set(elements.filter((el) => !el.isDeleted).map((el) => el.id));
      for (const id of fades.keys()) if (!live.has(id)) fades.delete(id);
      for (const id of pulses) if (!live.has(id)) pulses.delete(id);
      for (const id of glides.keys()) if (!live.has(id)) glides.delete(id);
      for (const id of exits.keys()) if (!live.has(id)) exits.delete(id);
      if (changed) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (cursor !== null) renderCursor(now);
    if (busy() || cursor !== null) schedule();
  }

  /**
   * Call right after committing a change. Every element that already existed in `before` (or in `extra`, copies of
   * things deleted a moment ago that came back under the same id) and changed place or size is put back where it was
   * and glides to the committed spot. The committed state stays the real one: undo, other transactions (after
   * finishMotion) and the camera (through finalGeometry) all see the end positions.
   */
  function glideFrom(before: readonly ExcalidrawElement[], extra: readonly ExcalidrawElement[] = [], ms: number = GLIDE_MS) {
    if (reduced()) return;
    const prior = new Map([...extra, ...before.filter((el) => !el.isDeleted)].map((el) => [el.id, el]));
    const now = performance.now();
    let any = false;
    const elements = api.getSceneElementsIncludingDeleted().map((el) => {
      const old = prior.get(el.id);
      if (el.isDeleted || old === undefined) return el;
      const from = geometryOf(old);
      const to = geometryOf(el);
      if (sameGeometry(from, to)) return el;
      glides.set(el.id, { from, to, start: now, ms });
      any = true;
      return withGeometry(el, from);
    });
    if (!any) return;
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    schedule();
  }

  /**
   * Choreographed entrance: each step's elements fade in at its delay; "draw" steps also grow their lines from the
   * first point to the last, like a pen stroke.
   */
  function enter(steps: readonly { elementIds: readonly string[]; delay: number; draw: boolean }[]) {
    if (reduced() || steps.length === 0) return;
    const now = performance.now();
    const plan = new Map<string, { delay: number; draw: boolean }>();
    for (const step of steps) for (const id of step.elementIds) plan.set(id, { delay: step.delay, draw: step.draw });
    const elements = api.getSceneElementsIncludingDeleted().map((el) => {
      const p = plan.get(el.id);
      if (p === undefined || el.isDeleted) return el;
      fades.set(el.id, { start: now + p.delay, target: el.opacity });
      if (p.draw && (el.type === "arrow" || el.type === "line") && el.points.length >= 2) {
        const to = geometryOf(el);
        const first = el.points[0] ?? localPoint(0, 0);
        const from: Geometry = { ...to, width: 0, height: 0, points: el.points.map(() => localPoint(first[0], first[1])) };
        glides.set(el.id, { from, to, start: now + p.delay, ms: DRAW_MS });
        return newElementWith(withGeometry(el, from), { opacity: 0 });
      }
      return newElementWith(el, { opacity: 0 });
    });
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    schedule();
  }

  /**
   * Fading copies of elements that were just deleted, added outside undo history. Bound labels stay attached to their
   * copied container; arrows lose their bindings.
   */
  function fadeOutCopies(removed: readonly ExcalidrawElement[]) {
    if (reduced() || removed.length === 0) return;
    const now = performance.now();
    const stamp = (ghostSeq++).toString(36);
    const ghostId = (id: string) => `ghost~${stamp}~${id}`;
    const ids = new Set(removed.map((el) => el.id));
    const copies = removed.map((el): ExcalidrawElement => {
      const base = {
        ...el,
        id: ghostId(el.id),
        groupIds: [],
        frameId: null,
        locked: true,
        isDeleted: false,
        customData: metaData({ kind: "ghost", role: "part", source: el.id }),
        boundElements: (el.boundElements ?? []).filter((b) => b.type === "text" && ids.has(b.id)).map((b) => ({ ...b, id: ghostId(b.id) })),
      };
      exits.set(base.id, { start: now, from: el.opacity });
      if (base.type === "text") return { ...base, containerId: base.containerId !== null && ids.has(base.containerId) ? ghostId(base.containerId) : null };
      if (base.type === "arrow") return { ...base, startBinding: null, endBinding: null };
      return base;
    });
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...copies], captureUpdate: CaptureUpdateAction.NEVER });
    schedule();
  }

  /** Removes the fading copies of `sourceIds` at once, for things that are about to come back under the same id. */
  function dropGhosts(sourceIds: ReadonlySet<string>) {
    let any = false;
    const elements = api.getSceneElementsIncludingDeleted().map((el) => {
      const meta = readMeta(el);
      if (el.isDeleted || meta === null || meta.kind !== "ghost" || !sourceIds.has(meta.source)) return el;
      exits.delete(el.id);
      any = true;
      return newElementWith(el, { isDeleted: true });
    });
    if (any) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
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
    if (status === null && now - cursor.lastMove > CURSOR_LINGER_MS) {
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
      username: status === null ? "Partner" : `Partner ${status}`,
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

  /** Glides the cursor toward where the next drawing will likely land, before anything is drawn. */
  function anticipate(to: Point) {
    const now = performance.now();
    if (cursor !== null) {
      const at = currentCursor(now);
      // Already there or close: stay put rather than twitch.
      if (Math.hypot(at.x - to.x, at.y - to.y) < 24) {
        cursor = { ...cursor, lastMove: now };
        schedule();
        return;
      }
    }
    pointAt(to, []);
  }

  /** Sets or clears the label beside the cursor. Clearing lets an idle cursor fade after the usual linger. */
  function setStatus(next: string | null) {
    if (next === status) return;
    status = next;
    if (cursor !== null) cursor = { ...cursor, lastMove: performance.now() };
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
    exits.clear();
    cursor = null;
    status = null;
  }

  return { anticipate, setStatus, fadeIn, pulse, stopPulse, pointAt, glideFrom, enter, fadeOutCopies, dropGhosts, finishMotion, finalGeometry, dispose };
}
