// Keeps agent node ids unique. Excalidraw duplication (Ctrl+D, Alt-drag, copy and paste) copies customData, so a
// copy would otherwise share its original's NodeId and every agent edit to one would hit both.
import { NodeId } from "../../shared/board";
import type { NodeMeta } from "./meta";
import { metaData, nodeIdOf, readMeta } from "./meta";

/** The parts of an Excalidraw element that identity depends on; every ExcalidrawElement fits. */
export type IdentityElement = {
  readonly id: string;
  readonly type: string;
  readonly isDeleted: boolean;
  readonly groupIds: readonly string[];
  readonly customData?: Record<string, unknown>;
  readonly version: number;
  readonly versionNonce: number;
  readonly containerId?: string | null;
  readonly startBinding?: { readonly elementId: string } | null;
  readonly endBinding?: { readonly elementId: string } | null;
};

type Rewrite = { element: IdentityElement; meta: NodeMeta };

function freshId(base: NodeId, taken: Set<string>): NodeId {
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const parsed = NodeId.safeParse(`${base.slice(0, 48 - suffix.length)}${suffix}`);
    if (parsed.success && !taken.has(parsed.data)) {
      taken.add(parsed.data);
      return parsed.data;
    }
  }
}

function sharesGroup(a: IdentityElement, b: IdentityElement): boolean {
  return a.groupIds.some((g) => b.groupIds.includes(g));
}

function belongsTo(part: IdentityElement, root: IdentityElement): boolean {
  return part.id === root.id || (part.type === "text" && part.containerId === root.id) || sharesGroup(part, root);
}

/**
 * Gives every duplicated agent node its own id (`auth-service-2`) and points copied edges at the copies they are
 * bound to. The first root in scene order keeps the original id. Returns the input array when nothing changes.
 */
export function dedupeNodeIds<E extends IdentityElement>(elements: readonly E[]): readonly E[] {
  const roots = new Map<NodeId, E[]>();
  const parts = new Map<NodeId, E[]>();
  const taken = new Set<string>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const meta = readMeta(el);
    const id = nodeIdOf(meta);
    if (meta === null || id === null) continue;
    taken.add(id);
    const bucket = meta.role === "root" ? roots : parts;
    bucket.set(id, [...(bucket.get(id) ?? []), el]);
  }

  const rewrites = new Map<string, Rewrite>();
  const nodeOfRoot = new Map<string, NodeId>();
  for (const [id, list] of roots) {
    for (const [index, root] of list.entries()) {
      nodeOfRoot.set(root.id, id);
      const meta = readMeta(root);
      if (index === 0 || meta === null || meta.kind === "pending") continue;
      const next = freshId(id, taken);
      nodeOfRoot.set(root.id, next);
      for (const el of [root, ...(parts.get(id) ?? []).filter((p) => belongsTo(p, root))]) {
        const own = readMeta(el);
        if (own !== null && own.kind !== "pending") rewrites.set(el.id, { element: el, meta: { ...own, nodeId: next } });
      }
    }
  }

  // Edges follow their bindings, so a copied arrow between copied shapes links the copies.
  for (const list of roots.values()) {
    for (const root of list) {
      if (root.type !== "arrow") continue;
      const current = rewrites.get(root.id)?.meta ?? readMeta(root);
      if (current === null || current.kind !== "edge") continue;
      const from = nodeOfRoot.get(root.startBinding?.elementId ?? "") ?? current.from;
      const to = nodeOfRoot.get(root.endBinding?.elementId ?? "") ?? current.to;
      if (from === current.from && to === current.to) continue;
      const original = nodeIdOf(readMeta(root)) ?? current.nodeId;
      for (const el of [root, ...(parts.get(original) ?? []).filter((p) => belongsTo(p, root))]) {
        const own = rewrites.get(el.id)?.meta ?? readMeta(el);
        if (own !== null && own.kind === "edge") rewrites.set(el.id, { element: el, meta: { ...own, from, to } });
      }
    }
  }

  if (rewrites.size === 0) return elements;
  return elements.map((el) => {
    const rewrite = rewrites.get(el.id);
    if (rewrite === undefined || rewrite.element !== el) return el;
    return { ...el, customData: metaData(rewrite.meta), version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) };
  });
}
