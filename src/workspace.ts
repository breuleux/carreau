// Workspace state: layout + selection + maximization + navigation memory.
// No keyboard shortcuts live here: commands are exposed by name and the host binds them.

import {
  activeGroup,
  applyDropForest,
  genId,
  holderOf,
  DragSubject,
  DropTarget,
  FloatingWindow,
  ForestResult,
  WorkspaceData,
  axisOf,
  computeRects,
  find,
  findTab,
  LayoutNode,
  Located,
  normalize,
  normalizeTree,
  isScroll,
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
  | "root"
  | "undo"
  | "redo"
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
  "root",
  "undo",
  "redo",
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
/** How many user actions can be undone. */
const UNDO_LIMIT = 200;

interface Snapshot {
  root: LayoutNode;
  floating: FloatingWindow[];
  selection: Selection;
  maximized: Selection | null;
  maxHistory: (Selection | null)[];
  expandStack: Selection[];
  lastPane: string | null;
}

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
  /** The latest single pane selected: plain moves start from it (multi-selections don't stick). */
  private lastPane: string | null = null;
  /** selections preceding each expand, so that they can be undone */
  private expandStack: Selection[] = [];
  private listeners: (() => void)[] = [];

  constructor(root: LayoutNode) {
    this.root = normalizeTree(root) ?? root;
    this.selection = { id: panes(root)[0].id };
    this.selectImpl(this.selection, false);
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Look a node up in any tree (main or floating window). */
  node(id: string): LayoutNode | null {
    for (const t of this.trees()) {
      const n = find(t, id)?.node;
      if (n) return n;
    }
    return null;
  }

  /** The tree holding the selection: navigation commands work within it. */
  private tree(): LayoutNode {
    return this.treeOf(this.selection.id) ?? this.root;
  }

  private inMain(id: string): boolean {
    return !!find(this.root, id);
  }

  // -------------------------------------------------------------------------
  // Layout replacement (after drops, resizes, deserialization)

  setRoot(root: LayoutNode, select?: string): void {
    this.root = normalizeTree(root) ?? this.root;
    const valid = (s: Selection | null) => {
      if (!s) return null;
      const n = this.node(s.id);
      if (!n) return null;
      if (s.range && (n.type === "pane" || s.range[1] >= n.children.length)) return { id: s.id };
      return s;
    };
    if (select) this.selection = { id: select };
    this.selection = valid(this.selection) ?? { id: panes(root)[0].id };
    // Maximization only applies to the main tree.
    const validMain = (s: Selection | null) => (s && this.inMain(s.id) ? valid(s) : null);
    this.maximized = validMain(this.maximized);
    this.maxHistory = this.maxHistory.map(validMain);
    this.select(this.selection, false);
    this.emit();
  }

  /** Serializable state: the tree and the floating windows. */
  data(): WorkspaceData {
    return { root: this.root, floating: this.floating };
  }

  load(data: WorkspaceData): void {
    this.undoStack = [];
    this.redoStack = [];
    this.floating = data.floating
      .map((w) => ({ ...w, root: normalizeTree(w.root) }))
      .filter((w): w is FloatingWindow => !!w.root);
    this.setRoot(data.root);
  }

  // -------------------------------------------------------------------------
  // Undo / redo of actions that change the layout (moves, swaps, resizes, floating, docking,
  // closing tabs). Simple navigation (selection, active tab, maximization) is not recorded,
  // although each step restores the selection that went with it.

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private recording = 0;
  /** Kind of the latest recorded step: consecutive resizes of one splitter coalesce. */
  private lastKind: string | null = null;

  /** What counts as "the layout": trees, tabs and sizes; not the active tabs nor rects. */
  private layoutKey(): string {
    return JSON.stringify(
      { root: this.root, floating: this.floating.map((w) => w.root) },
      (k, v) => (k === "active" ? undefined : v),
    );
  }

  private pushUndo(before: Snapshot, kind: string): void {
    this.undoStack.push(before);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.lastKind = kind;
  }

  private snapshot(): Snapshot {
    return structuredClone({
      root: this.root,
      floating: this.floating,
      selection: this.selection,
      maximized: this.maximized,
      maxHistory: this.maxHistory,
      expandStack: this.expandStack,
      lastPane: this.lastPane,
    });
  }

  private restoreSnapshot(snap: Snapshot): void {
    const s = structuredClone(snap);
    this.root = s.root;
    this.floating = s.floating;
    this.maximized = s.maximized;
    this.maxHistory = s.maxHistory;
    this.lastPane = s.lastPane;
    this.selectImpl(s.selection, false);
    this.expandStack = s.expandStack; // after selectImpl, which clears it
    this.emit();
  }

  /**
   * Run a user action, recording the state before it for undo. Nested actions only record
   * once (the outermost), and an action that changes nothing records nothing.
   */
  private record<T>(fn: () => T): T {
    if (this.recording > 0) return fn();
    const before = this.snapshot();
    const key = this.layoutKey();
    this.recording++;
    try {
      return fn();
    } finally {
      this.recording--;
      // Only layout changes are undoable steps.
      if (this.layoutKey() !== key) this.pushUndo(before, "action");
    }
  }

  /**
   * Resizing a splitter: call `beginResize` when the drag starts and `endResize` when it
   * ends. Consecutive resizes of the same splitter (same `key`) coalesce into one step.
   */
  beginResize(key: string): { key: string; before: Snapshot; layout: string } {
    return { key, before: this.snapshot(), layout: this.layoutKey() };
  }

  endResize(token: { key: string; before: Snapshot; layout: string }): void {
    if (this.layoutKey() === token.layout) return;
    const kind = `resize:${token.key}`;
    if (this.lastKind === kind && this.undoStack.length) {
      this.redoStack = []; // coalesced with the previous resize of this splitter
      return;
    }
    this.pushUndo(token.before, kind);
  }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.lastKind = null;
    this.redoStack.push(this.snapshot());
    this.restoreSnapshot(snap);
  }

  /** Revert the latest step and forget it (it can't be redone): for cancelled operations. */
  discardLastStep(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.lastKind = null;
    this.restoreSnapshot(snap);
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.lastKind = null;
    this.undoStack.push(this.snapshot());
    this.restoreSnapshot(snap);
  }

  // -------------------------------------------------------------------------
  // Floating windows

  /** Pull a pane out of the hierarchy into a floating window. The last pane can't float. */
  float(paneId: string, rect: Rect): boolean {
    return this.record(() => this.floatImpl(paneId, rect));
  }

  private floatImpl(paneId: string, rect: Rect): boolean {
    const loc = find(this.root, paneId);
    if (!loc || loc.node.type !== "pane" || !loc.parent) return false;
    const pane = loc.node;
    loc.parent.children.splice(loc.index, 1);
    this.floating.push({ root: pane, rect });
    this.setRoot(this.root);
    return true;
  }

  /** Whether a tab can be closed: anything but the very last tab of the main tree. */
  canCloseTab(tabId: string): boolean {
    const main = panes(this.root);
    return !(main.length === 1 && main[0].tabs.length === 1 && main[0].tabs[0].id === tabId);
  }

  /**
   * Close a tab, wherever it is. A pane left without tabs disappears; a floating window left
   * empty closes. The main tree can't be emptied (see canCloseTab).
   */
  closeTab(tabId: string): boolean {
    return this.record(() => this.closeTabImpl(tabId));
  }

  private closeTabImpl(tabId: string): boolean {
    if (!this.canCloseTab(tabId)) return false;
    for (const t of this.trees()) {
      const ft = findTab(t, tabId);
      if (!ft) continue;
      const { pane, index } = ft;
      pane.tabs.splice(index, 1);
      if (index < pane.active || pane.active >= pane.tabs.length) pane.active = Math.max(0, pane.active - 1);
      // Normalize the windows (dropping emptied ones); setRoot normalizes the main tree.
      this.floating = this.floating
        .map((w) => ({ ...w, root: normalizeTree(w.root) }))
        .filter((w): w is FloatingWindow => !!w.root);
      this.setRoot(this.root);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Groups

  /**
   * Group the selection into a new pane holding a single group tab named `name`. A single
   * node goes in as is; a range is wrapped in a split of the same axis. The new pane takes
   * the selection's place and size.
   */
  group(name: string, selection?: Selection): boolean {
    return this.record(() => {
      const sel = selection && this.node(selection.id) ? selection : this.selection;
      const tree = this.tree();
      const n = this.node(sel.id);
      if (!n || n.type === "group") return false;
      let inner: LayoutNode;
      let place: (p: PaneNode) => void;
      if (sel.range && n.type !== "pane") {
        const [lo, hi] = sel.range;
        const kids = n.children.slice(lo, hi + 1);
        const type = axisOf(n.type) === "row" ? "row" : "column";
        inner = { type, id: genId(type === "row" ? "r" : "c"), weight: 1, children: kids };
        const weight = kids.reduce((s, k) => s + k.weight, 0);
        place = (p) => {
          p.weight = weight;
          n.children.splice(lo, kids.length, p);
        };
      } else {
        inner = n;
        const loc = find(tree, n.id)!;
        place = (p) => {
          p.weight = n.weight;
          if (loc.parent) loc.parent.children[loc.index] = p;
          else this.replaceTreeRoot(tree, p);
        };
      }
      const holder: PaneNode = {
        type: "pane",
        id: genId("p"),
        weight: 1,
        active: 0,
        tabs: [{ id: genId("t"), title: name, group: { type: "group", id: genId("g"), weight: 1, children: [inner] } }],
      };
      inner.weight = 1;
      place(holder);
      this.normalizeAll();
      this.selectImpl({ id: holder.id }, false);
      this.emit();
      return true;
    });
  }

  /** Rename a tab (wherever it is). */
  renameTab(tabId: string, title: string): void {
    this.record(() => {
      for (const t of this.trees()) {
        const ft = findTab(t, tabId);
        if (ft) {
          ft.pane.tabs[ft.index].title = title;
          this.emit();
          return;
        }
      }
    });
  }

  /** A pane can collapse if its only tab is a group. */
  canCollapse(paneId: string): boolean {
    const p = this.node(paneId);
    const root = p?.type === "pane" && p.tabs.length === 1 ? p.tabs[0].group?.children[0] : undefined;
    // A scroll split always lives in a group tab: such a group can't be collapsed.
    return !!root && !isScroll(root.type);
  }

  /**
   * Collapse a group: replace the pane holding it (its only tab) by the group's layout.
   * Without an argument: the selected pane if it can collapse, else the innermost group
   * around the selection whose holder can.
   */
  collapse(paneId?: string): boolean {
    return this.record(() => {
      const target = paneId ?? this.collapsibleAroundSelection();
      if (!target || !this.canCollapse(target)) return false;
      const tree = this.treeOf(target)!;
      const loc = find(tree, target)!;
      const p = loc.node as PaneNode;
      const inner = p.tabs[0].group!.children[0];
      inner.weight = p.weight;
      if (loc.parent) loc.parent.children[loc.index] = inner;
      else this.replaceTreeRoot(tree, inner);
      this.normalizeAll();
      this.selectImpl({ id: this.node(inner.id) ? inner.id : this.lastPane ?? this.root.id }, false);
      this.emit();
      return true;
    });
  }

  private collapsibleAroundSelection(): string | null {
    const path = pathTo(this.tree(), this.selection.id) ?? [];
    for (let i = path.length - 1; i >= 0; i--) {
      const n = path[i];
      if (n.type === "pane" && this.canCollapse(n.id)) return n.id;
    }
    return null;
  }

  /** Replace the root of a tree (the main one or a floating window's). */
  private replaceTreeRoot(tree: LayoutNode, node: LayoutNode): void {
    if (tree === this.root) this.root = node;
    else for (const w of this.floating) if (w.root === tree) w.root = node;
  }

  private normalizeAll(): void {
    this.root = normalizeTree(this.root) ?? this.root;
    this.floating = this.floating
      .map((w) => ({ ...w, root: normalize(w.root) }))
      .filter((w): w is FloatingWindow => !!w.root);
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
    this.record(() => this.commitDropImpl(result, consumed, floatRect));
  }

  private commitDropImpl(result: ForestResult, consumed?: FloatingWindow, floatRect?: Rect): void {
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

  /** Select a node. As a user action (`emit`), this is recorded for undo. */
  select(sel: Selection, emit = true): void {
    if (emit) return this.record(() => this.selectImpl(sel, true));
    this.selectImpl(sel, false);
  }

  /** Activate a pane's tab and select the pane (a user action, recorded for undo). */
  activateTab(paneId: string, index: number): void {
    this.record(() => {
      const n = this.node(paneId);
      if (n?.type === "pane" && index >= 0 && index < n.tabs.length) n.active = index;
      this.selectImpl({ id: paneId }, true);
    });
  }

  private selectImpl(sel: Selection, emit: boolean): void {
    let n = this.node(sel.id);
    if (!n) return;
    // Group nodes are wrappers, never selected: select their root instead.
    if (n.type === "group") {
      n = n.children[0];
      if (!n) return;
      sel = { id: n.id };
    }
    if (sel.range && n.type !== "pane") {
      if (sel.range[0] === 0 && sel.range[1] === n.children.length - 1) sel = { id: sel.id };
    }
    this.selection = sel;
    this.expandStack = [];
    if (!sel.range && n.type === "pane") this.lastPane = sel.id;
    // At the top level, maximization is cleared unconditionally.
    if (sel.id === this.root.id && !sel.range) this.clearMaximization();
    const path = pathTo(this.treeOf(sel.id)!, sel.id)!;
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
    if (cmd === "undo") return this.undo();
    if (cmd === "redo") return this.redo();
    this.record(() => this.runImpl(cmd));
  }

  private runImpl(cmd: Command): void {
    switch (cmd) {
      case "nextTab":
        return this.cycleTab(1);
      case "prevTab":
        return this.cycleTab(-1);
      case "parent":
        return this.goParent();
      case "root":
        return this.goRoot();
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
      // From a range: its split, unless that split is a group's root (then its holder).
      this.select({ id: this.groupHolderOf(s.id)?.id ?? s.id }, false);
    } else {
      const up = this.upOf(s.id);
      if (!up) return;
      this.select({ id: up.id }, false);
    }
    this.widenMaximized();
    this.emit();
  }

  /** Select the root of the tree holding the selection (main, or a floating window's). */
  goRoot(): void {
    const root = this.tree();
    if (this.selection.id === root.id && !this.selection.range) return;
    this.select({ id: root.id }, false);
    this.widenMaximized(); // no-op for the main root: the top level clears the maximization
    this.emit();
  }

  goChild(): void {
    const s = this.selection;
    const n = this.node(s.id);
    if (!n) return;
    let child: LayoutNode;
    if (n.type === "pane") {
      // Into a pane showing a group. The group's root, when a split, fills the pane's body
      // exactly: a pointless step, skipped (go to its last-focused child).
      const g = activeGroup(n);
      const root = g?.children[0];
      if (!root) return;
      child = root.type === "pane" ? root : this.lastChildOf(root);
    } else {
      const [lo, hi] = s.range ?? [0, n.children.length - 1];
      const allowed = n.children.slice(lo, hi + 1);
      const last = this.lastChild.get(n.id);
      child = allowed.find((c) => c.id === last) ?? allowed[0];
    }
    this.select({ id: child.id }, false);
    this.emit();
  }

  private lastChildOf(split: SplitNode): LayoutNode {
    const last = this.lastChild.get(split.id);
    return split.children.find((c) => c.id === last) ?? split.children[0];
  }

  /** If `id` is a group's root, the pane holding the group. */
  private groupHolderOf(id: string): PaneNode | null {
    const tree = this.tree();
    const loc = find(tree, id);
    return loc?.parent?.type === "group" ? (holderOf(tree, loc.parent.id)?.pane ?? null) : null;
  }

  /**
   * The node above `id` for navigation. Above a group's root is the pane holding the group;
   * a group's root that is a split is skipped (it is the same area as its holder's body).
   */
  private upOf(id: string): LayoutNode | null {
    const tree = this.tree();
    const loc = find(tree, id);
    if (!loc?.parent) return null;
    if (loc.parent.type === "group") return holderOf(tree, loc.parent.id)?.pane ?? null;
    return this.groupHolderOf(loc.parent.id) ?? loc.parent;
  }

  /**
   * If the selection is a row, column or range, go back to the latest single pane.
   * Returns whether it did (the caller then does nothing else: clearing the multi-selection
   * is the whole effect, so that the user sees what's going on).
   */
  clearMultiSelection(): boolean {
    const n = this.node(this.selection.id);
    if (n?.type === "pane" && !this.selection.range) return false;
    if (!this.lastPane || this.node(this.lastPane)?.type !== "pane") return false;
    this.select({ id: this.lastPane }, false);
    this.emit();
    return true;
  }

  focus(side: Side): void {
    if (this.clearMultiSelection()) return;
    const sel = this.selection;
    const target = this.neighbour(side);
    if (!target) return;
    this.boundary.set(`${target.id}:${opposite[side]}`, sel);
    this.select(target, false);
    this.followMaximized();
    this.emit();
  }

  /**
   * Swap the selected pane with the pane touching the given side. The selection moves
   * with the pane, and the boundary memory makes the opposite swap undo this one.
   */
  swap(side: Side): void {
    if (this.clearMultiSelection()) return;
    const sel = this.selection;
    const me = this.node(sel.id);
    if (sel.range || !me || me.type !== "pane") return;
    const target = this.neighbour(side, true);
    if (!target) return;
    swapNodes(this.tree(), me.id, target.id);
    this.boundary.set(`${me.id}:${opposite[side]}`, target);
    this.boundary.set(`${target.id}:${side}`, { id: me.id });
    this.select({ id: me.id }, false);
    this.emit();
  }

  /** The pane (or remembered selection) touching the given side of the selection. */
  private neighbour(side: Side, panesOnly = false): Selection | null {
    const rects = computeRects(this.tree());
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
      for (const p of panes(this.tree())) {
        const r = rects.get(p.id);
        // Hidden panes (in inactive group tabs) have no rect; a pane showing a group acts as
        // a container: its group's panes are the targets.
        if (!r || activeGroup(p)) continue;
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
      const loc: Located = find(this.tree(), x.id)!;
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
    this.widenMaximized();
    this.emit();
  }

  /** Undo the last expansion. Only meaningful right after one or more expand commands. */
  unexpand(): void {
    const prev = this.expandStack.pop();
    if (!prev || !this.node(prev.id)) return;
    const stack = this.expandStack;
    this.select(prev, false);
    this.expandStack = stack;
    this.emit();
  }

  /**
   * The maximization command: toggles if the selection is the maximized group; otherwise
   * maximizes the selection (which may be wider or narrower than the current maximization).
   */
  toggleMaximize(): void {
    this.record(() => this.toggleMaximizeImpl());
  }

  private toggleMaximizeImpl(): void {
    if (this.maximized && sameSel(this.maximized, this.selection)) this.restore();
    else this.maximize();
  }

  maximize(): void {
    this.record(() => {
      if (!this.inMain(this.selection.id)) return; // not in floating windows
      // Maximizing the whole tree is no maximization at all.
      if (this.selection.id === this.root.id && !this.selection.range) {
        this.clearMaximization();
        this.emit();
        return;
      }
      if (sameSel(this.maximized, this.selection)) return;
      this.maxHistory.push(this.maximized);
      this.maximized = { ...this.selection };
      this.emit();
    });
  }

  private clearMaximization(): void {
    this.maximized = null;
    this.maxHistory = [];
  }

  restore(): void {
    this.record(() => {
      if (!this.maximized) return;
      this.maximized = this.maxHistory.pop() ?? null;
      this.emit();
    });
  }

  /**
   * While maximized, keep the maximized region in sync with the selection.
   * `grow`: the selection grew (parent/expand) so the maximized region follows it.
   * Otherwise, follow only when the selection left the maximized region.
   */
  /**
   * Parent/expand may *widen* the maximization: when the new selection contains the whole
   * maximized area, it becomes the maximization. They never narrow it (only the maximize
   * command zooms in further), so child → child → parent keeps the original group.
   */
  private widenMaximized(): void {
    const max = this.maximized;
    if (!max || !this.inMain(this.selection.id) || sameSel(max, this.selection)) return;
    const sel = this.selectedNodes();
    const contains = this.selectedNodes(max).every((m) => sel.some((n) => pathTo(n, m.id)));
    if (contains) this.maximized = { ...this.selection };
  }

  /**
   * When focus moves to a pane outside the maximized area, the maximization follows it
   * (otherwise the selection would be hidden).
   */
  private followMaximized(): void {
    if (!this.maximized || !this.inMain(this.selection.id)) return;
    const inside = this.selectedNodes(this.maximized).some((m) =>
      pathTo(m, this.selection.id),
    );
    if (!inside) this.maximized = { ...this.selection };
  }
}

