// Workspace state: layout trees + selection + maximization + navigation memory + undo.
// No keyboard shortcuts live here: commands are exposed by name and the host binds them.

import {
  DragSubject,
  DropTarget,
  Entry,
  FloatingWindow,
  ForestResult,
  LayoutIndex,
  LayoutNode,
  PaneNode,
  Rect,
  Side,
  SplitNode,
  WorkspaceData,
  activeGroup,
  applyDropForest,
  closeTabWith,
  instantLifecycle,
  Lifecycle,
  canCollapse,
  collapseGroup,
  computeRects,
  find,
  findTab,
  genId,
  groupPane,
  inForest,
  isScroll,
  kind,
  normalizeTree,
  opposite,
  panes,
  pathTo,
  removeNode,
  replaceNode,
  sideAxis,
  sideIsStart,
  swapNodes,
  union,
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
  | "child"
  | "undo"
  | "redo"
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

const EPS = 1e-6;
/** How many layout changes can be undone. */
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

/** A pending close: of a tab, or of a pane (with all its tabs). */
interface CloseOp {
  kind: "tab" | "pane";
  id: string;
  tabIds: string[];
}

function sameSel(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && a.range?.[0] === b.range?.[0] && a.range?.[1] === b.range?.[1];
}

export class Workspace {
  root: LayoutNode;
  /** Layout trees pulled out of the hierarchy, shown as floating windows (last: frontmost). */
  floating: FloatingWindow[] = [];
  selection: Selection;
  maximized: Selection | null = null;
  private maxHistory: (Selection | null)[] = [];
  /**
   * Activation order, most recent first: container id -> child ids (focus moving through
   * them); `tabs:<pane id>` -> tab ids (tabs becoming active); "" -> pane ids (panes selected).
   */
  private recent = new Map<string, string[]>();
  /** `${nodeId}:${side}` -> selection we came from through that side */
  private boundary = new Map<string, Selection>();
  /** The latest single pane selected (multi-selections don't stick). */
  private lastPane: string | null = null;
  /** selections preceding each expand, so that they can be undone */
  private expandStack: Selection[] = [];
  private listeners: (() => void)[] = [];
  /** How tab contents close (set by the host). */
  lifecycle: Lifecycle = instantLifecycle;
  /** Pending closes, by tab id (a pane's covers all its tabs). Not part of the layout. */
  private closing = new Map<string, CloseOp>();

  constructor(root: LayoutNode) {
    this.root = normalizeTree(root) ?? root;
    this.selection = { id: panes(this.root)[0].id };
    this.selectImpl(this.selection, false);
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  emit(): void {
    // Tabs can become active in many ways (clicks, commands, drops): record them all here.
    for (const t of this.trees()) for (const p of panes(t)) if (p.tabs[p.active]) this.touch(`tabs:${p.id}`, p.tabs[p.active].id);
    for (const fn of this.listeners) fn();
  }

  /** Record `id` as the most recently activated under `key`. */
  private touch(key: string, id: string): void {
    const l = this.recent.get(key) ?? [];
    const i = l.indexOf(id);
    if (i === 0) return;
    if (i > 0) l.splice(i, 1);
    l.unshift(id);
    if (l.length > 64) l.length = 64;
    this.recent.set(key, l);
  }

  /** The most recently activated of `candidates` under `key`, if any was. */
  private mostRecent<T extends { id: string }>(key: string, candidates: T[]): T | undefined {
    const l = this.recent.get(key) ?? [];
    let best: T | undefined;
    let bi = Infinity;
    for (const c of candidates) {
      const i = l.indexOf(c.id);
      if (i >= 0 && i < bi) [best, bi] = [c, i];
    }
    return best;
  }

  /** All trees: the main one first, then the floating windows' (minus `exclude`). */
  trees(exclude?: FloatingWindow): LayoutNode[] {
    return [this.root, ...this.floating.filter((w) => w !== exclude).map((w) => w.root)];
  }

  /** Where everything is, right now. (Cheap: build one whenever needed.) */
  index(): LayoutIndex {
    return new LayoutIndex(this.trees());
  }

  /** Look a node up in any tree (main or floating window). */
  node(id: string): LayoutNode | null {
    for (const t of this.trees()) {
      const n = find(t, id)?.node;
      if (n) return n;
    }
    return null;
  }

  /** The tree (main or floating) containing a node. */
  treeOf(id: string): LayoutNode | null {
    return this.trees().find((t) => find(t, id)) ?? null;
  }

  /** The tree holding the selection: navigation commands work within it. */
  private tree(): LayoutNode {
    return this.treeOf(this.selection.id) ?? this.root;
  }

  private inMain(id: string): boolean {
    return !!find(this.root, id);
  }

  // -------------------------------------------------------------------------
  // Layout changes

  /** Serializable state: the tree and the floating windows. */
  data(): WorkspaceData {
    return { root: this.root, floating: this.floating };
  }

  load(data: WorkspaceData): void {
    this.undoStack = [];
    this.redoStack = [];
    this.floating = data.floating.map((w) => ({ ...w, root: w.root }));
    this.setTrees([data.root, ...data.floating.map((w) => w.root)]);
  }

  /**
   * Install new trees (normalized; null: emptied), in the order of `trees()`. Emptied windows
   * close; the main tree can't be emptied. Then make the selection valid again.
   */
  private setTrees(trees: (LayoutNode | null)[], windows = this.floating, select?: string): void {
    this.root = (trees[0] && normalizeTree(trees[0])) ?? this.root;
    this.floating = windows.flatMap((w, i) => {
      const t = trees[i + 1] && normalizeTree(trees[i + 1]!);
      return t ? [{ root: t, rect: w.rect }] : [];
    });
    const valid = (s: Selection | null) => {
      const n = s && this.node(s.id);
      if (!n) return null;
      return s.range && (n.type === "pane" || s.range[1] >= n.children.length) ? { id: s.id } : s;
    };
    if (select) this.selection = { id: select };
    this.selection = valid(this.selection) ?? { id: panes(this.root)[0].id };
    // Maximization only applies to the main tree.
    const validMain = (s: Selection | null) => (s && this.inMain(s.id) ? valid(s) : null);
    this.maximized = validMain(this.maximized);
    this.maxHistory = this.maxHistory.map(validMain);
    this.selectImpl(this.selection, false);
    this.emit();
  }

  /**
   * A structural change across all trees (each in a root slot, so every node has a parent).
   * Refused (returns false) if it would empty the main tree.
   */
  private change(fn: (forest: SplitNode) => boolean | void, select?: () => string | undefined): boolean {
    return this.record(() => {
      const { trees, value } = inForest(structuredClone(this.trees()), fn);
      if (value === false || !trees[0]) return false;
      this.setTrees(trees, this.floating, select?.());
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Undo / redo of layout changes (moves, swaps, resizes, floating, docking, grouping,
  // closing tabs). Navigation is not recorded, but each step restores the selection.

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private recording = 0;
  /** Kind of the latest recorded step: consecutive resizes of one splitter coalesce. */
  private lastKind: string | null = null;

  /** What counts as "the layout": trees, tabs and sizes; not the active tabs nor rects. */
  private layoutKey(): string {
    return JSON.stringify(this.trees(), (k, v) => (k === "active" ? undefined : v));
  }

  private pushUndo(before: Snapshot, kind: string): void {
    this.undoStack.push(before);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.lastKind = kind;
  }

  private snapshot(): Snapshot {
    const { root, floating, selection, maximized, maxHistory, expandStack, lastPane } = this;
    return structuredClone({ root, floating, selection, maximized, maxHistory, expandStack, lastPane });
  }

  private restoreSnapshot(snap: Snapshot): void {
    const s = structuredClone(snap);
    Object.assign(this, { root: s.root, floating: s.floating, maximized: s.maximized, maxHistory: s.maxHistory, lastPane: s.lastPane });
    this.selectImpl(s.selection, false);
    this.expandStack = s.expandStack; // after selectImpl, which clears it
    this.emit();
  }

  /**
   * Run a user action, recording the state before it if it changes the layout. Nested
   * actions record once (the outermost).
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
      if (this.layoutKey() !== key) this.pushUndo(before, "action");
    }
  }

  /** Splitter resizes: consecutive resizes of the same splitter (`key`) are one step. */
  beginResize(key: string): { key: string; before: Snapshot; layout: string } {
    return { key, before: this.snapshot(), layout: this.layoutKey() };
  }

  endResize(token: { key: string; before: Snapshot; layout: string }): void {
    if (this.layoutKey() === token.layout) return;
    const kind = `resize:${token.key}`;
    if (this.lastKind === kind && this.undoStack.length) this.redoStack = [];
    else this.pushUndo(token.before, kind);
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
  // Structural operations

  /** Pull a pane of the main tree out into a floating window (not the last pane). */
  float(paneId: string, rect: Rect): boolean {
    if (!this.inMain(paneId) || this.node(paneId)?.type !== "pane") return false;
    let pane: LayoutNode | null = null;
    return this.record(() => {
      const ok = this.change((forest) => {
        pane = find(forest, paneId)!.node;
        removeNode(forest, paneId);
      });
      if (ok && pane) {
        this.floating.push({ root: pane, rect });
        this.setTrees(this.trees());
      }
      return ok;
    });
  }

  /** Whether a tab can be closed: anything but the very last tab of the main tree. */
  canCloseTab(tabId: string): boolean {
    const main = panes(this.root);
    return !(main.length === 1 && main[0].tabs.length === 1 && main[0].tabs[0].id === tabId);
  }

  /** Whether a pane can be closed: anything but the main tree's last pane. */
  canClosePane(paneId: string): boolean {
    const main = panes(this.root);
    return this.node(paneId)?.type === "pane" && !(main.length === 1 && main[0].id === paneId);
  }

  /** Whether a tab is being closed (its close() hasn't returned yet). */
  isClosing(tabId: string): boolean {
    return this.closing.has(tabId);
  }

  /**
   * Close a tab, wherever it is: its contents close first (`kind.close`, through the host's
   * `lifecycle`; a group closes everything in it). Meanwhile the tab shows as closing; it is
   * then removed. If closing is refused (rejected), the tab stays. Resolves to whether it closed.
   */
  closeTab(tabId: string): Promise<boolean> {
    const ft = this.findTab(tabId);
    if (!ft || !this.canCloseTab(tabId) || this.closing.has(tabId)) return Promise.resolve(false);
    return this.runClose({ kind: "tab", id: tabId, tabIds: [tabId] }, closeTabWith(ft.pane.tabs[ft.index], this.lifecycle));
  }

  /** Close a pane and all its tabs, like `closeTab`. */
  closePane(paneId: string): Promise<boolean> {
    const p = this.node(paneId);
    if (p?.type !== "pane" || !this.canClosePane(paneId)) return Promise.resolve(false);
    return this.runClose({ kind: "pane", id: paneId, tabIds: p.tabs.map((t) => t.id) }, kind(p).close(p, this.lifecycle));
  }

  /**
   * Close what a tab's pending close is about (the tab, or its whole pane) right away: call
   * the forceful close without waiting for it, and remove it.
   */
  forceClose(tabId: string): boolean {
    const op = this.closing.get(tabId) ?? { kind: "tab" as const, id: tabId, tabIds: [tabId] };
    const n = op.kind === "pane" ? this.node(op.id) : null;
    const ft = op.kind === "tab" ? this.findTab(op.id) : null;
    if (!n && !ft) return false;
    (n ? kind(n).forceClose(n, this.lifecycle) : closeTabWith(ft!.pane.tabs[ft!.index], this.lifecycle, true)).catch(() => {});
    this.endClose(op);
    return this.remove(op);
  }

  private async runClose(op: CloseOp, closed: Promise<void>): Promise<boolean> {
    for (const id of op.tabIds) this.closing.set(id, op);
    this.emit();
    try {
      await closed;
    } catch {
      // refused: the tab stays
      if (this.endClose(op)) this.emit();
      return false;
    }
    if (!this.endClose(op)) return false; // forced meanwhile
    if (!this.remove(op)) {
      this.emit();
      return false;
    }
    return true;
  }

  /** Forget a pending close; returns whether it was still pending. */
  private endClose(op: CloseOp): boolean {
    let pending = false;
    for (const id of op.tabIds)
      if (this.closing.get(id) === op) {
        this.closing.delete(id);
        pending = true;
      }
    return pending;
  }

  /**
   * Remove a closed tab or pane. Emptied panes disappear, emptied windows close. If the focus
   * was in it, it moves where the parents decide (see `focusAfterClose`); otherwise it stays.
   */
  private remove(op: CloseOp): boolean {
    const next = this.hasFocus(op) ? this.focusAfterClose(op) : null;
    return this.change(
      (forest) => {
        if (op.kind === "pane") {
          if (!removeNode(forest, op.id)) return false;
        } else {
          const ft = findTab(forest, op.id);
          if (!ft) return false;
          ft.pane.tabs.splice(ft.index, 1);
          if (ft.index < ft.pane.active || ft.pane.active >= ft.pane.tabs.length) ft.pane.active = Math.max(0, ft.pane.active - 1);
        }
        const a = next?.activate;
        const p = a && find(forest, a.paneId)?.node;
        if (p?.type === "pane") p.active = Math.max(0, p.tabs.findIndex((t) => t.id === a!.tabId));
      },
      () => next?.select,
    );
  }

  private findTab(tabId: string) {
    return this.trees().map((t) => findTab(t, tabId)).find(Boolean) ?? null;
  }

  /** Whether the focus is in what closes: the selected pane's active tab (or the pane), or a
   *  group in it holding the selection. */
  private hasFocus(op: CloseOp): boolean {
    if (op.kind === "pane") {
      const p = this.node(op.id);
      return !!p && !!find(p, this.selection.id);
    }
    const n = this.node(this.selection.id);
    if (n?.type === "pane" && !this.selection.range && n.tabs[n.active]?.id === op.id) return true;
    const ft = this.findTab(op.id);
    const g = ft?.pane.tabs[ft.index].group;
    return !!g && !!find(g, this.selection.id);
  }

  /**
   * Where the focus goes when a tab that has it closes. Walking up from what disappears, the
   * first parent with something left decides:
   *  - a pane (tab group): its most recently activated other tab (else the one before);
   *  - a plain split: its most recently focused other child (else a neighbour);
   *  - a scroll split: the neighbour that moves into the closed one's place, i.e. the one
   *    further from its sticky end (after it, or before it if it sticks to its end);
   *  - a group's slot: its tab disappears from the holder pane, which decides in turn;
   *  - a tree's root (a window closing): the most recently selected pane left elsewhere.
   * The focus then goes down to a pane, through what was last focused in what was picked.
   */
  private focusAfterClose(op: CloseOp): { select: string; activate?: { paneId: string; tabId: string } } | null {
    const idx = this.index();
    let pane: PaneNode;
    let gone: string | null;
    if (op.kind === "pane") {
      pane = this.node(op.id) as PaneNode;
      gone = null; // the whole pane
    } else {
      const ft = this.findTab(op.id);
      if (!ft) return null;
      pane = ft.pane;
      gone = op.id;
    }
    for (;;) {
      const others = gone === null ? [] : pane.tabs.filter((t) => t.id !== gone);
      if (others.length) {
        const i = pane.tabs.findIndex((t) => t.id === gone);
        const tab = this.mostRecent(`tabs:${pane.id}`, others) ?? others[Math.max(0, i - 1)];
        const inner = tab.group?.children[0];
        return { select: inner ? this.descend(inner) : pane.id, activate: { paneId: pane.id, tabId: tab.id } };
      }
      // The pane disappears: up until a parent has something left.
      let x: LayoutNode = pane;
      let holder: PaneNode | null = null;
      for (;;) {
        const parent = idx.parent(x.id);
        if (!parent) {
          const p = this.mostRecent("", panes(this.root).concat(...this.floating.map((w) => panes(w.root))).filter((p) => !find(x, p.id)));
          return p ? { select: p.id } : null;
        }
        if (parent.type === "slot") {
          holder = idx.parent(parent.id) as PaneNode;
          gone = holder.tabs.find((t) => t.group?.id === parent.id)!.id;
          break;
        }
        const kids = (parent as SplitNode).children;
        const i = kids.indexOf(x);
        if (kids.length > 1) {
          const k = kind(parent);
          const order = k.scroll ? (parent.type !== "pane" && parent.reverse ? [i - 1, i + 1] : [i + 1, i - 1]) : [i - 1, i + 1];
          const near = order.map((j) => kids[j]).find(Boolean)!;
          const pick = k.scroll ? near : (this.mostRecent(parent.id, kids.filter((c) => c !== x)) ?? near);
          return { select: this.descend(pick) };
        }
        x = parent;
      }
      pane = holder;
    }
  }

  /** Down to a pane, through what was last focused (a pane showing a group: into the group). */
  private descend(n: LayoutNode): string {
    if (n.type === "pane") {
      const g = activeGroup(n)?.children[0];
      return g ? this.descend(g) : n.id;
    }
    return this.descend(this.mostRecent(n.id, n.children) ?? n.children[0]);
  }

  /** Rename a tab (wherever it is): replaces its title and any HTML `short`. */
  renameTab(tabId: string, title: string): void {
    this.change((forest) => {
      const ft = findTab(forest, tabId);
      if (!ft) return false;
      ft.pane.tabs[ft.index].title = title;
      delete ft.pane.tabs[ft.index].short;
    });
  }

  /**
   * Group the selection into a new pane holding a single group tab named `name`, taking the
   * selection's place and size. A range is wrapped in a split of the same axis.
   */
  group(name: string, selection?: Selection): boolean {
    const sel = selection && this.node(selection.id) ? selection : this.selection;
    let holderId: string | undefined;
    return this.change(
      (forest) => {
        const n = find(forest, sel.id)?.node;
        if (!n || n.type === "slot") return false;
        let holder: PaneNode;
        if (sel.range && n.type !== "pane") {
          const [lo, hi] = sel.range;
          const kids = n.children.slice(lo, hi + 1);
          const type = kind(n).axis ?? "column";
          const inner: SplitNode = { type, id: genId(type[0]), weight: 1, children: kids };
          holder = groupPane(name, inner, kids.reduce((s, k) => s + k.weight, 0));
          n.children.splice(lo, kids.length, holder);
        } else {
          holder = groupPane(name, n, n.weight);
          replaceNode(forest, n.id, holder);
        }
        holderId = holder.id;
      },
      () => holderId,
    );
  }

  /** A pane can collapse if its only tab is a group (not a scroll split's). */
  /** The scroll split a pane shows (as its active group's root), if any. */
  scrollOf(paneId: string): SplitNode | null {
    const p = this.node(paneId);
    const root = p?.type === "pane" ? activeGroup(p)?.children[0] : undefined;
    return root && isScroll(root) ? root : null;
  }

  /** Make a scroll split stick to its end, or back to its start. Undoable. */
  toggleReverse(scrollId: string): boolean {
    return this.change((forest) => {
      const n = find(forest, scrollId)?.node;
      if (!n || !isScroll(n)) return false;
      if (n.reverse) delete n.reverse;
      else n.reverse = true;
    });
  }

  canCollapse(paneId: string): boolean {
    const p = this.node(paneId);
    return p?.type === "pane" && canCollapse(p);
  }

  /**
   * Collapse a group: replace its holder pane by the group's layout. Without an argument:
   * the selected pane if it can collapse, else the innermost holder around the selection.
   */
  collapse(paneId?: string): boolean {
    const target =
      paneId ?? [...(pathTo(this.tree(), this.selection.id) ?? [])].reverse().find((n) => this.canCollapse(n.id))?.id;
    if (!target || !this.canCollapse(target)) return false;
    let innerId: string | undefined;
    return this.change(
      (forest) => {
        innerId = collapseGroup(forest, target)?.id;
        if (!innerId) return false;
      },
      () => innerId,
    );
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
    this.record(() => {
      const windows = this.floating.filter((w) => w !== consumed);
      const trees = [...result.trees];
      if (result.floated && floatRect) {
        windows.push({ root: result.floated, rect: floatRect });
        trees.push(result.floated);
      }
      const main = result.trees[0]!;
      this.setTrees(trees, windows, find(main, result.paneId) ? result.paneId : undefined);
    });
  }

  // -------------------------------------------------------------------------
  // Selection

  /** Select a node (a user action when `emit`). */
  select(sel: Selection, emit = true): void {
    this.selectImpl(sel, emit);
  }

  /** Activate a pane's tab and select the pane. */
  activateTab(paneId: string, index: number): void {
    const n = this.node(paneId);
    if (n?.type === "pane" && index >= 0 && index < n.tabs.length) n.active = index;
    this.selectImpl({ id: paneId }, true);
  }

  private selectImpl(sel: Selection, emit: boolean): void {
    let n = this.node(sel.id);
    if (!n) return;
    // Slots are wrappers, never selected: select what they hold.
    if (n.type === "slot") {
      n = n.children[0];
      if (!n) return;
      sel = { id: n.id };
    }
    if (sel.range && n.type !== "pane" && sel.range[0] === 0 && sel.range[1] === n.children.length - 1)
      sel = { id: sel.id };
    this.selection = sel;
    this.expandStack = [];
    if (!sel.range && n.type === "pane") {
      this.lastPane = sel.id;
      this.touch("", sel.id);
    }
    // At the top level, maximization is cleared unconditionally.
    if (sel.id === this.root.id && !sel.range) this.clearMaximization();
    const path = pathTo(this.treeOf(sel.id)!, sel.id)!;
    for (let i = 0; i < path.length - 1; i++) this.touch(path[i].id, path[i + 1].id);
    if (emit) this.emit();
  }

  /** The nodes covered by a selection (one node, or the nodes in the range). */
  selectedNodes(sel: Selection = this.selection): LayoutNode[] {
    const n = this.node(sel.id);
    if (!n) return [];
    if (!sel.range || n.type === "pane") return [n];
    return n.children.slice(sel.range[0], sel.range[1] + 1);
  }

  private selectionRect(sel: Selection, rects: Map<string, Rect>): Rect {
    return union(this.selectedNodes(sel).map((n) => rects.get(n.id)!))!;
  }

  // -------------------------------------------------------------------------
  // Commands

  run(cmd: Command): void {
    if (cmd === "undo") return this.undo();
    if (cmd === "redo") return this.redo();
    {
      const sides: Record<string, Side> = { Left: "left", Right: "right", Up: "top", Down: "bottom" };
      const m = /^(focus|expand|swap)(Left|Right|Up|Down)$/.exec(cmd);
      if (m) return this[m[1] as "focus" | "expand" | "swap"](sides[m[2]]);
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
        case "unexpand":
          return this.unexpand();
        case "maximize":
          return this.maximize();
        case "restore":
          return this.restore();
      }
    }
  }

  private cycleTab(delta: number): void {
    const n = this.node(this.selection.id);
    if (n?.type !== "pane" || n.tabs.length < 2) return;
    n.active = (n.active + delta + n.tabs.length) % n.tabs.length;
    this.emit();
  }

  /** Up one navigation step (slots and groups' root splits are skipped, see LayoutIndex). */
  private goParent(): void {
    const s = this.selection;
    const idx = this.index();
    // From a range: its split (or the split's holder, if the split is a group's root).
    const up = s.range ? (idx.holder(s.id) ?? idx.node(s.id)) : idx.navParent(s.id);
    if (!up) return;
    this.select({ id: up.id }, false);
    this.widenMaximized();
    this.emit();
  }

  /** Select the root of the tree holding the selection (main, or a floating window's). */
  private goRoot(): void {
    const root = this.tree();
    if (this.selection.id === root.id && !this.selection.range) return;
    this.select({ id: root.id }, false);
    this.widenMaximized(); // (the main root clears the maximization: top level)
    this.emit();
  }

  /** Down one navigation step, to the last-focused child (within the range, if any). */
  private goChild(): void {
    const s = this.selection;
    const n = this.node(s.id);
    if (!n) return;
    const pick = (split: SplitNode, range = [0, split.children.length - 1]) => {
      const allowed = split.children.slice(range[0], range[1] + 1);
      return this.mostRecent(split.id, allowed) ?? allowed[0];
    };
    const child =
      n.type !== "pane" && s.range ? pick(n, s.range) : this.index().navChild(n, (split) => pick(split));
    if (!child) return;
    this.select({ id: child.id }, false);
    this.emit();
  }

  /**
   * If the selection is a row, column or range, go back to the latest single pane. Returns
   * whether it did (that is then the whole effect, so that the user sees what's going on).
   */
  clearMultiSelection(): boolean {
    const n = this.node(this.selection.id);
    if (n?.type === "pane" && !this.selection.range) return false;
    if (!this.lastPane || this.node(this.lastPane)?.type !== "pane") return false;
    this.select({ id: this.lastPane }, false);
    this.emit();
    return true;
  }

  private focus(side: Side): void {
    if (this.clearMultiSelection()) return;
    const sel = this.selection;
    const target = this.neighbour(side);
    if (!target) return;
    this.boundary.set(`${target.id}:${opposite[side]}`, sel);
    this.select(target, false);
    this.followMaximized();
    this.emit();
  }

  /** Swap the selected pane with the one on a side. The opposite swap undoes it exactly. */
  private swap(side: Side): void {
    if (this.clearMultiSelection()) return;
    const me = this.node(this.selection.id);
    if (this.selection.range || me?.type !== "pane") return;
    const target = this.neighbour(side, true);
    if (!target) return;
    this.change((forest) => swapNodes(forest, me.id, target.id), () => me.id);
    this.boundary.set(`${me.id}:${opposite[side]}`, target);
    this.boundary.set(`${target.id}:${side}`, { id: me.id });
  }

  /** The pane (or remembered selection) touching a side of the selection. */
  private neighbour(side: Side, panesOnly = false): Selection | null {
    const rects = computeRects(this.tree());
    const sel = this.selection;
    const S = this.selectionRect(sel, rects);
    const horizontal = sideAxis[side] === "row";
    const adjacent = (r: Rect) => {
      const [a, b] = sideIsStart[side] ? [horizontal ? r.x + r.w : r.y + r.h, horizontal ? S.x : S.y] : [horizontal ? S.x + S.w : S.y + S.h, horizontal ? r.x : r.y];
      return Math.abs(a - b) < EPS;
    };
    const overlap = (r: Rect) =>
      horizontal ? Math.min(r.y + r.h, S.y + S.h) - Math.max(r.y, S.y) : Math.min(r.x + r.w, S.x + S.w) - Math.max(r.x, S.x);

    // 1. Back where we came from through this boundary, if still valid.
    const remembered = this.boundary.get(`${sel.id}:${side}`);
    const rn = remembered && this.node(remembered.id);
    if (remembered && rn && (!panesOnly || (rn.type === "pane" && !remembered.range))) {
      const r = this.selectionRect(remembered, rects);
      if (adjacent(r) && overlap(r) > EPS) return remembered;
    }
    // 2. Otherwise, the pane touching that side, preferring the one facing our center. Panes
    // without a rect are hidden (inactive groups); a pane showing a group is a container.
    const center = horizontal ? S.y + S.h / 2 : S.x + S.w / 2;
    let best: { id: string; score: number } | null = null;
    for (const p of panes(this.tree())) {
      const r = rects.get(p.id);
      if (!r || p.tabs[p.active]?.group || !adjacent(r)) continue;
      const ov = overlap(r);
      if (ov <= EPS) continue;
      const [lo, hi] = horizontal ? [r.y, r.y + r.h] : [r.x, r.x + r.w];
      const score = ov + (lo <= center && center < hi ? 10 : 0);
      if (!best || score > best.score) best = { id: p.id, score };
    }
    return best && { id: best.id };
  }

  private expand(side: Side): void {
    const axis = sideAxis[side];
    const start = sideIsStart[side];
    const s = this.selection;
    let x = this.node(s.id);
    if (!x) return;
    if (s.range && x.type !== "pane" && kind(x).axis === axis) {
      const [lo, hi] = s.range;
      if (start && lo > 0) return this.commitExpand({ id: x.id, range: [lo - 1, hi] });
      if (!start && hi < x.children.length - 1) return this.commitExpand({ id: x.id, range: [lo, hi + 1] });
    }
    const idx = this.index();
    while (x) {
      const e: Entry = idx.get(x.id)!;
      const parent: LayoutNode | null = e.parent;
      if (!parent) return;
      if (kind(parent).axis === axis) {
        const j = start ? e.index - 1 : e.index + 1;
        if (j >= 0 && j < (parent as SplitNode).children.length)
          return this.commitExpand({ id: parent.id, range: start ? [j, e.index] : [e.index, j] });
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

  /** Undo the last expansion. */
  private unexpand(): void {
    const prev = this.expandStack.pop();
    if (!prev || !this.node(prev.id)) return;
    const stack = this.expandStack;
    this.select(prev, false);
    this.expandStack = stack;
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Maximization (main tree only)

  /** Toggle if the selection is the maximized group; else maximize the selection. */
  toggleMaximize(): void {
    if (this.maximized && sameSel(this.maximized, this.selection)) this.restore();
    else this.maximize();
  }

  maximize(): void {
    if (!this.inMain(this.selection.id)) return;
    // Maximizing the whole tree is no maximization at all.
    if (this.selection.id === this.root.id && !this.selection.range) this.clearMaximization();
    else if (!sameSel(this.maximized, this.selection)) {
      this.maxHistory.push(this.maximized);
      this.maximized = { ...this.selection };
    }
    this.emit();
  }

  private clearMaximization(): void {
    this.maximized = null;
    this.maxHistory = [];
  }

  restore(): void {
    if (!this.maximized) return;
    this.maximized = this.maxHistory.pop() ?? null;
    this.emit();
  }

  /**
   * Parent/expand may *widen* the maximization: when the new selection contains the whole
   * maximized area. They never narrow it (only the maximize command zooms in further).
   */
  private widenMaximized(): void {
    const max = this.maximized;
    if (!max || !this.inMain(this.selection.id) || sameSel(max, this.selection)) return;
    const sel = this.selectedNodes();
    if (this.selectedNodes(max).every((m) => sel.some((n) => pathTo(n, m.id)))) this.maximized = { ...this.selection };
  }

  /** When focus moves outside the maximized area, the maximization follows it. */
  private followMaximized(): void {
    if (!this.maximized || !this.inMain(this.selection.id)) return;
    if (!this.selectedNodes(this.maximized).some((m) => pathTo(m, this.selection.id))) this.maximized = { ...this.selection };
  }
}
