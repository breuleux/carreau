// Generic tree queries (through node kinds), and the LayoutIndex: everything about where each
// node is, computed in one pass, so that nobody re-derives it.

import { Ctx, activeGroup, isSplit, kind, rootCtx } from "./kinds";
import { LayoutNode, PaneNode, Rect, SplitNode } from "./types";

export interface Located {
  node: LayoutNode;
  parent: LayoutNode | null;
  /** index in the parent's children (for a slot in a pane: the tab's index) */
  index: number;
}

export function* walk(node: LayoutNode, parent: LayoutNode | null = null, index = 0): Generator<Located> {
  yield { node, parent, index };
  const kids = kind(node).children(node);
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c) yield* walk(c, node, i);
  }
}

export function find(root: LayoutNode, id: string): Located | null {
  for (const loc of walk(root)) if (loc.node.id === id) return loc;
  return null;
}

/** Path of nodes from the root to the node with the given id (inclusive). */
export function pathTo(root: LayoutNode, id: string): LayoutNode[] | null {
  if (root.id === id) return [root];
  for (const c of kind(root).children(root)) {
    const p = c && pathTo(c, id);
    if (p) return [root, ...p];
  }
  return null;
}

export function panes(root: LayoutNode): PaneNode[] {
  return [...walk(root)].map((l) => l.node).filter((n): n is PaneNode => n.type === "pane");
}

export function findTab(root: LayoutNode, tabId: string): { pane: PaneNode; index: number } | null {
  for (const p of panes(root)) {
    const i = p.tabs.findIndex((t) => t.id === tabId);
    if (i >= 0) return { pane: p, index: i };
  }
  return null;
}

/** Logical rectangles of every visible node, from the weights alone. */
export function computeRects(root: LayoutNode, frame: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()) {
  out.set(root.id, frame);
  if (root.type === "pane") {
    // A pane showing a group: the group's layout takes its place (inactive groups: no rects).
    const g = activeGroup(root);
    if (g?.children[0]) computeRects(g.children[0], frame, out);
    return out;
  }
  if (!isSplit(root)) return out;
  const kids = root.children;
  const total = kids.reduce((s, c) => s + c.weight, 0) || 1;
  let offset = 0;
  for (const c of kids) {
    const f = c.weight / total;
    const r =
      kind(root).axis === "row"
        ? { x: frame.x + offset * frame.w, y: frame.y, w: f * frame.w, h: frame.h }
        : { x: frame.x, y: frame.y + offset * frame.h, w: frame.w, h: f * frame.h };
    computeRects(c, r, out);
    offset += f;
  }
  return out;
}

export interface Entry {
  node: LayoutNode;
  /** structural parent (a slot's parent is the pane holding it) */
  parent: LayoutNode | null;
  index: number;
  /** which tree: 0 is the main one, then floating windows */
  tree: number;
  ctx: Ctx;
}

/** Where every node of a set of trees is. Build it, use it, throw it away. */
export class LayoutIndex {
  private entries = new Map<string, Entry>();

  constructor(readonly trees: LayoutNode[]) {
    trees.forEach((t, i) => this.add(t, null, 0, i, rootCtx(i > 0)));
  }

  private add(node: LayoutNode, parent: LayoutNode | null, index: number, tree: number, ctx: Ctx): void {
    this.entries.set(node.id, { node, parent, index, tree, ctx });
    const k = kind(node);
    const childCtx = k.childContext(node, ctx);
    k.children(node).forEach((c, i) => c && this.add(c, node, i, tree, childCtx));
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  node(id: string): LayoutNode | null {
    return this.entries.get(id)?.node ?? null;
  }

  parent(id: string): LayoutNode | null {
    return this.entries.get(id)?.parent ?? null;
  }

  root(id: string): LayoutNode | null {
    const e = this.entries.get(id);
    return e ? this.trees[e.tree] : null;
  }

  /** For a group's root (or anything in a slot): the pane holding the slot. */
  holder(id: string): PaneNode | null {
    const p = this.parent(id);
    return p && p.type === "slot" ? (this.parent(p.id) as PaneNode | null) : null;
  }

  /**
   * The parent for navigation (and for walking boundaries outward): slots are transparent
   * (above a group's root is its holder pane), and a split that is a group's root is skipped
   * (it is the same area as its holder's body).
   */
  navParent(id: string): LayoutNode | null {
    let p = this.parent(id);
    while (p && !isNavStep(this, p)) p = this.parent(p.id);
    return p;
  }

  /** A navigation child: through slots and groups' root splits, to the first real step. */
  navChild(n: LayoutNode, pick: (split: SplitNode) => LayoutNode): LayoutNode | null {
    const down = (x: LayoutNode): LayoutNode | null => (x.type === "pane" ? activeGroup(x) : isSplit(x) ? pick(x) : null);
    let c = down(n);
    while (c && !isNavStep(this, c)) c = down(c);
    return c;
  }
}

/** Navigation steps: not slots, and not a split that is a group's root (its holder is). */
function isNavStep(idx: LayoutIndex, n: LayoutNode): boolean {
  if (!kind(n).navStep) return false;
  return !(isSplit(n) && idx.parent(n.id)?.type === "slot");
}
