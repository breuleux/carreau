// Workspace state: layout + selection + maximization + navigation memory.
// No keyboard shortcuts live here: commands are exposed by name and the host binds them.

import {
  applyDropForest,
  DragSubject,
  DropTarget,
  FloatingWindow,
  ForestResult,
  WorkspaceData,
  axisOf,
  computeRects,
  find,
  LayoutNode,
  Located,
  normalize,
  opposite,
  PaneNode,
  pathTo,
  panes,
  Rect,
  Side,
  sideAxis,
  sideIsStart,
  SplitNode,
  swapNodes,
} from "./model";

/** A single node, or a contiguous range of children of a split. */
export interface Selection {
  id: string;
  range?: [number, number];
}

export type Command =
  | "nextTab"
  | "prevTab"
  | "parent"
  | "child"
  | "focusLeft"
  | "focusRight"
  | "focusUp"
  | "focusDown"
  | "expandLeft"
  | "expandRight"
  | "expandUp"
  | "expandDown"
  | "unexpand"
  | "swapLeft"
  | "swapRight"
  | "swapUp"
  | "swapDown"
  | "maximize"
  | "restore";

export const COMMANDS: Command[] = [
  "nextTab",
  "prevTab",
  "parent",
  "child",
  "focusLeft",
  "focusRight",
  "focusUp",
  "focusDown",
  "expandLeft",
  "expandRight",
  "expandUp",
  "expandDown",
  "unexpand",
  "swapLeft",
  "swapRight",
  "swapUp",
  "swapDown",
  "maximize",
  "restore",
];

const EPS = 1e-6;

function sameSel(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && a.range?.[0] === b.range?.[0] && a.range?.[1] === b.range?.[1];
}

export class Workspace {
  root: LayoutNode;
  /** Panes pulled out of the hierarchy, shown as floating windows (last is frontmost). */
  floating: FloatingWindow[] = [];
  selection: Selection;
  maximized: Selection | null = null;
  private maxHistory: (Selection | null)[] = [];
  /** container id -> id of the child last focused in it */
  private lastChild = new Map<string, string>();
  /** `${nodeId}:${side}` -> selection we came from through that side */
  private boundary = new Map<string, Selection>();
  /** selections preceding each expand, so that they can be undone */
  private expandStack: Selection[] = [];
  private listeners: (() => void)[] = [];

  constructor(root: LayoutNode) {
    this.root = normalize(root) ?? root;
    this.selection = { id: panes(root)[0].id };
    this.select(this.selection);
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  node(id: string): LayoutNode | null {
    return find(this.root, id)?.node ?? null;
  }

  // -------------------------------------------------------------------------
  // Layout replacement (after drops, resizes, deserialization)

  setRoot(root: LayoutNode, select?: string): void {
    this.root = normalize(root) ?? this.root;
    const valid = (s: Selection | null) => {
      if (!s) return null;
      const n = this.node(s.id);
      if (!n) return null;
      if (s.range && (n.type === "pane" || s.range[1] >= n.children.length)) return { id: s.id };
      return s;
    };
    if (select) this.selection = { id: select };
    this.selection = valid(this.selection) ?? { id: panes(root)[0].id };
    this.maximized = valid(this.maximized);
    this.maxHistory = this.maxHistory.map(valid);
    this.select(this.selection, false);
    this.emit();
  }

  /** Serializable state: the tree and the floating windows. */
  data(): WorkspaceData {
    return { root: this.root, floating: this.floating };
  }

  load(data: WorkspaceData): void {
    this.floating = data.floating;
    this.setRoot(data.root);
  }

  // -------------------------------------------------------------------------
  // Floating windows

  /** Pull a pane out of the hierarchy into a floating window. The last pane can't float. */
  float(paneId: string, rect: Rect): boolean {
    const loc = find(this.root, paneId);
    if (!loc || loc.node.type !== "pane" || !loc.parent) return false;
    const pane = loc.node;
    loc.parent.children.splice(loc.index, 1);
    this.floating.push({ root: pane, rect });
    this.setRoot(this.root);
    return true;
  }

  /** All trees: the main one first, then the floating windows' (minus `exclude`). */
  trees(exclude?: FloatingWindow): LayoutNode[] {
    return [this.root, ...this.floating.filter((w) => w !== exclude).map((w) => w.root)];
  }

  /** The tree (main or floating) containing a node. */
  treeOf(id: string): LayoutNode | null {
    return this.trees().find((t) => find(t, id)) ?? null;
  }

  /** Compute a drop across all trees. `exclude`: a window being docked (it is the subject). */
  tryDrop(subject: DragSubject, target: DropTarget, exclude?: FloatingWindow): ForestResult | null {
    return applyDropForest(this.trees(exclude), subject, target);
  }

  /**
   * Commit a drop computed by tryDrop. `consumed`: the window that was excluded (docked).
   * `floatRect`: where to show the new window, for `float` drops.
   */
  commitDrop(result: ForestResult, consumed?: FloatingWindow, floatRect?: Rect): void {
    const others = this.floating.filter((w) => w !== consumed);
    const next: FloatingWindow[] = [];
    others.forEach((w, i) => {
      const t = result.trees[i + 1];
      if (t) next.push({ root: t, rect: w.rect }); // emptied windows close
    });
    if (result.floated && floatRect) next.push({ root: result.floated, rect: floatRect });
    this.floating = next;
    const main = result.trees[0]!;
    this.setRoot(main, find(main, result.paneId) ? result.paneId : undefined);
  }

  // -------------------------------------------------------------------------
  // Selection

  select(sel: Selection, emit = true): void {
    const n = this.node(sel.id);
    if (!n) return;
    if (sel.range && n.type !== "pane") {
      if (sel.range[0] === 0 && sel.range[1] === n.children.length - 1) sel = { id: sel.id };
    }
    this.selection = sel;
    this.expandStack = [];
    const path = pathTo(this.root, sel.id)!;
    for (let i = 0; i < path.length - 1; i++) this.lastChild.set(path[i].id, path[i + 1].id);
    if (emit) this.emit();
  }

  /** Ids of the nodes covered by a selection (one node, or the nodes in the range). */
  selectedNodes(sel: Selection = this.selection): LayoutNode[] {
    const n = this.node(sel.id);
    if (!n) return [];
    if (!sel.range || n.type === "pane") return [n];
    return n.children.slice(sel.range[0], sel.range[1] + 1);
  }

  selectionRect(sel: Selection, rects: Map<string, Rect>): Rect {
    const rs = this.selectedNodes(sel).map((n) => rects.get(n.id)!);
    const x0 = Math.min(...rs.map((r) => r.x));
    const y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w));
    const y1 = Math.max(...rs.map((r) => r.y + r.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** The pane that is "current": the selection if it is a pane, else the last focused descendant. */
  currentPane(): PaneNode {
    let n = this.selectedNodes()[0];
    while (n.type !== "pane") {
      const last = this.lastChild.get(n.id);
      n = n.children.find((c) => c.id === last) ?? n.children[0];
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Commands

  run(cmd: Command): void {
    switch (cmd) {
      case "nextTab":
        return this.cycleTab(1);
      case "prevTab":
        return this.cycleTab(-1);
      case "parent":
        return this.goParent();
      case "child":
        return this.goChild();
      case "focusLeft":
        return this.focus("left");
      case "focusRight":
        return this.focus("right");
      case "focusUp":
        return this.focus("top");
      case "focusDown":
        return this.focus("bottom");
      case "expandLeft":
        return this.expand("left");
      case "expandRight":
        return this.expand("right");
      case "expandUp":
        return this.expand("top");
      case "expandDown":
        return this.expand("bottom");
      case "unexpand":
        return this.unexpand();
      case "swapLeft":
        return this.swap("left");
      case "swapRight":
        return this.swap("right");
      case "swapUp":
        return this.swap("top");
      case "swapDown":
        return this.swap("bottom");
      case "maximize":
        return this.maximize();
      case "restore":
        return this.restore();
    }
  }

  cycleTab(delta: number): void {
    const n = this.node(this.selection.id);
    if (!n || n.type !== "pane" || n.tabs.length < 2) return;
    n.active = (n.active + delta + n.tabs.length) % n.tabs.length;
    this.emit();
  }

  goParent(): void {
    const s = this.selection;
    if (s.range) {
      this.select({ id: s.id }, false);
    } else {
      const loc = find(this.root, s.id);
      if (!loc?.parent) return;
      this.select({ id: loc.parent.id }, false);
    }
    this.followMaximized(true);
    this.emit();
  }

  goChild(): void {
    const s = this.selection;
    const n = this.node(s.id);
    if (!n || n.type === "pane") return;
    const [lo, hi] = s.range ?? [0, n.children.length - 1];
    const allowed = n.children.slice(lo, hi + 1);
    const last = this.lastChild.get(n.id);
    const child = allowed.find((c) => c.id === last) ?? allowed[0];
    this.select({ id: child.id }, false);
    this.emit();
  }

  focus(side: Side): void {
    const sel = this.selection;
    const target = this.neighbour(side);
    if (!target) return;
    this.boundary.set(`${target.id}:${opposite[side]}`, sel);
    this.select(target, false);
    this.followMaximized(false);
    this.emit();
  }

  /**
   * Swap the selected pane with the pane touching the given side. The selection moves
   * with the pane, and the boundary memory makes the opposite swap undo this one.
   */
  swap(side: Side): void {
    const sel = this.selection;
    const me = this.node(sel.id);
    if (sel.range || !me || me.type !== "pane") return;
    const target = this.neighbour(side, true);
    if (!target) return;
    swapNodes(this.root, me.id, target.id);
    this.boundary.set(`${me.id}:${opposite[side]}`, target);
    this.boundary.set(`${target.id}:${side}`, { id: me.id });
    this.select({ id: me.id }, false);
    this.emit();
  }

  /** The pane (or remembered selection) touching the given side of the selection. */
  private neighbour(side: Side, panesOnly = false): Selection | null {
    const rects = computeRects(this.root);
    const sel = this.selection;
    const S = this.selectionRect(sel, rects);
    const key = (id: string, s: Side) => `${id}:${s}`;

    const adjacent = (r: Rect) => {
      switch (side) {
        case "left":
          return Math.abs(r.x + r.w - S.x) < EPS;
        case "right":
          return Math.abs(S.x + S.w - r.x) < EPS;
        case "top":
          return Math.abs(r.y + r.h - S.y) < EPS;
        case "bottom":
          return Math.abs(S.y + S.h - r.y) < EPS;
      }
    };
    const horizontal = sideAxis[side] === "row";
    const overlap = (r: Rect) =>
      horizontal
        ? Math.min(r.y + r.h, S.y + S.h) - Math.max(r.y, S.y)
        : Math.min(r.x + r.w, S.x + S.w) - Math.max(r.x, S.x);

    let target: Selection | null = null;

    // 1. Go back where we came from through this boundary, if still valid.
    const remembered = this.boundary.get(key(sel.id, side));
    const rememberedNode = remembered && this.node(remembered.id);
    if (remembered && rememberedNode && (!panesOnly || (rememberedNode.type === "pane" && !remembered.range))) {
      const r = this.selectionRect(remembered, rects);
      if (adjacent(r) && overlap(r) > EPS) target = remembered;
    }

    // 2. Otherwise, the pane touching that side, preferring the one facing our center.
    if (!target) {
      const center = horizontal ? S.y + S.h / 2 : S.x + S.w / 2;
      let best: { id: string; score: number } | null = null;
      for (const p of panes(this.root)) {
        const r = rects.get(p.id)!;
        if (!adjacent(r)) continue;
        const ov = overlap(r);
        if (ov <= EPS) continue;
        const lo = horizontal ? r.y : r.x;
        const hi = horizontal ? r.y + r.h : r.x + r.w;
        const score = ov + (lo <= center && center < hi ? 10 : 0);
        if (!best || score > best.score) best = { id: p.id, score };
      }
      if (best) target = { id: best.id };
    }
    return target;
  }

  expand(side: Side): void {
    const axis = sideAxis[side];
    const start = sideIsStart[side];
    const s = this.selection;
    let x: LayoutNode | null = this.node(s.id);
    if (!x) return;

    if (s.range && x.type !== "pane" && axisOf(x.type) === axis) {
      const [lo, hi] = s.range;
      if (start && lo > 0) return this.commitExpand({ id: x.id, range: [lo - 1, hi] });
      if (!start && hi < x.children.length - 1)
        return this.commitExpand({ id: x.id, range: [lo, hi + 1] });
    }

    while (x) {
      const loc: Located = find(this.root, x.id)!;
      const parent: SplitNode | null = loc.parent;
      if (!parent) return;
      if (axisOf(parent.type) === axis) {
        const j = start ? loc.index - 1 : loc.index + 1;
        if (j >= 0 && j < parent.children.length) {
          const range: [number, number] = start ? [j, loc.index] : [loc.index, j];
          return this.commitExpand({ id: parent.id, range });
        }
      }
      x = parent;
    }
  }

  private commitExpand(sel: Selection): void {
    const prev = this.selection;
    const stack = this.expandStack;
    this.select(sel, false);
    this.expandStack = [...stack, prev];
    this.followMaximized(true);
    this.emit();
  }

  /** Undo the last expansion. Only meaningful right after one or more expand commands. */
  unexpand(): void {
    const prev = this.expandStack.pop();
    if (!prev || !this.node(prev.id)) return;
    const stack = this.expandStack;
    const maxFollows = sameSel(this.maximized, this.selection);
    this.select(prev, false);
    this.expandStack = stack;
    if (maxFollows) this.maximized = { ...prev };
    this.emit();
  }

  maximize(): void {
    if (sameSel(this.maximized, this.selection)) return;
    this.maxHistory.push(this.maximized);
    this.maximized = { ...this.selection };
    this.emit();
  }

  restore(): void {
    if (!this.maximized) return;
    this.maximized = this.maxHistory.pop() ?? null;
    this.emit();
  }

  /**
   * While maximized, keep the maximized region in sync with the selection.
   * `grow`: the selection grew (parent/expand) so the maximized region follows it.
   * Otherwise, follow only when the selection left the maximized region.
   */
  private followMaximized(grow: boolean): void {
    if (!this.maximized) return;
    if (grow) {
      this.maximized = { ...this.selection };
      return;
    }
    const inside = this.selectedNodes(this.maximized).some((m) =>
      pathTo(m, this.selection.id),
    );
    if (!inside) this.maximized = { ...this.selection };
  }
}
