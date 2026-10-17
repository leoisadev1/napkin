// Canvas motion that Excalidraw does not provide: staggered fade-in of new elements, a breathing
// pending card, and the partner's cursor gliding to whatever it just drew. All updates use
// CaptureUpdateAction.NEVER so they never enter undo history; the committed state is always the final one.
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types";
import type { Point } from "./geometry";

const FADE_MS = 280;
const CURSOR_MS = 560;
const CURSOR_LINGER_MS = 2600;
const PULSE_MS = 1600;

export const PARTNER_COLOR = { background: "#ff6a3d", stroke: "#ff6a3d" };
/**
 * Excalidraw ignores Collaborator.color for cursors and derives a pastel hue from a hash of the
 * collaborator id. This id hashes to hue 20, a peach that matches the partner's ember color.
 */
const PARTNER_ID = "partner-53";

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

  function tick(now: number) {
    frame = null;
    if (fades.size > 0 || pulses.size > 0) {
      let changed = false;
      const elements = api.getSceneElementsIncludingDeleted().map((el) => {
        const next = opacityAt(el, now);
        if (next === null || next === el.opacity) return el;
        changed = true;
        return newElementWith(el, { opacity: next });
      });
      // Drop ids that vanished (deleted by the user mid-fade).
      const live = new Set(elements.map((el) => el.id));
      for (const id of fades.keys()) if (!live.has(id)) fades.delete(id);
      for (const id of pulses) if (!live.has(id)) pulses.delete(id);
      if (changed) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (cursor !== null) renderCursor(now);
    if (fades.size > 0 || pulses.size > 0 || cursor !== null) schedule();
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
      selectedElementIds: t >= 1 ? cursor.selected : {},
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
    cursor = null;
  }

  return { fadeIn, pulse, stopPulse, pointAt, dispose };
}
