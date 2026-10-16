// Workspace state: layout trees + selection + maximization + navigation memory + undo.
// No keyboard shortcuts live here: commands are exposed by name and the host binds them.

import { Cell, Placer } from "./cells";
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
  Tab,
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
  walk,
  groupPane,
  inForest,
  isCell,
  isScroll,
  isSplit,
  isSticky,
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

/** A relative move, as the navigation shortcuts make it. */
export type Direction = "left" | "right" | "up" | "down" | "parent" | "child";
/** Where to go from a cell: a move, an explicit cell (or node), or a sequence of these. */
export type Path = Direction | { id: string } | Path[];
/** How to place something (see `Workspace.place`). */
export interface PlaceSpec {
  /** Beside the base, on that side; or into its tabs. */
  split: Side | "tab";
  /** The base: an explicit cell, or a path from the focused cell. Default: the focused cell. */
  base?: Path;
  /** If the base doesn't exist: put it where the base would be (see `place`). */
  force?: boolean;
  /** Focus what was placed (default: true). */
  focus?: boolean;
}
/** What can be placed: a tab or a pane, new or already in the layout (then it moves), or a new layout. */
export type Placeable = Tab | LayoutNode | { id: string };

const DIRECTION_SIDES: Record<string, Side> = { left: "left", right: "right", up: "top", down: "bottom" };

/** What cell operations act on when a node of some type is selected (see `Workspace.operand`). */
export type OperandOf = (ws: Workspace, node: LayoutNode) => Selection | null;
const OPERANDS: Record<string, OperandOf> = {};

/**
 * Make cell operations (close, swap, move, insert, float, rename, group, maximize) act on
 * something else than a selected node of this type. Null: on nothing.
 */
export function registerOperand(type: LayoutNode["type"], fn: OperandOf): void {
  OPERANDS[type] = fn;
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
      return s.range && (!isSplit(n) || s.range[1] >= n.children.length) ? { id: s.id } : s;
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

  // -------------------------------------------------------------------------
  // Relative addressing and placement (for hosts; see cells.ts for the handles)

  /** A handle on a node (null if there is none with that id). */
  cell(id: string): Cell | null {
    return this.node(id) ? new Cell(this, id) : null;
  }

  /** The focused cell: the selected node (for a range, its split). */
  focused(): Cell {
    return new Cell(this, this.selection.id);
  }

  /** Something that places things as `spec` says, relative to the focused cell. */
  placer(spec: PlaceSpec): Placer {
    return new Placer(this, spec);
  }

  /** The node a path leads to from a node, as the navigation shortcuts would go; or null. */
  cellAt(fromId: string, path: Path): string | null {
    return this.walk(fromId, path).id;
  }

  /** Follow a path; on failure, where it got to and the move that failed. */
  private walk(fromId: string, path: Path): { id: string | null; last: string; failed?: Direction } {
    if (Array.isArray(path)) {
      let at = fromId;
      for (const p of path) {
        const r = this.walk(at, p);
        if (!r.id) return r;
        at = r.id;
      }
      return { id: at, last: at };
    }
    if (typeof path !== "string") {
      const n = this.node(path.id);
      return n ? { id: n.id, last: n.id } : { id: null, last: fromId };
    }
    const sel = { id: fromId };
    const side = DIRECTION_SIDES[path];
    const to = side
      ? this.neighbour(side, "nodes", sel)?.id
      : path === "parent"
        ? this.parentOf(sel)?.id
        : this.childOf(sel)?.id;
    return to ? { id: to, last: to } : { id: null, last: fromId, failed: path };
  }

  /**
   * Place something (a tab or a pane, new or moved; or a new layout) relative to a base cell:
   * beside it (`split: side`), or into its tabs (`split: "tab"`; a split base: into its most
   * recently focused pane). Placing works like dropping: same rules, undoable.
   *
   * If the base doesn't exist (its path fails) and `force` is set, the thing goes where the
   * base would have been: walking up from where the path got to, the first parent that takes
   * insertions on the side of the failed move (or, if that move wasn't sideways, on
   * `split`'s side) gets a new pane on that side, holding it.
   * Returns the pane that ends up holding it, or null.
   */
  place(spec: PlaceSpec, what: Placeable): string | null {
    const from = this.selection.id;
    const r = spec.base === undefined ? { id: from, last: from } : this.walk(from, spec.base);
    let target: DropTarget | null = null;
    if (r.id) {
      if (spec.split === "tab") {
        const p = this.node(this.descend(this.node(r.id)!));
        if (p?.type === "pane") target = { kind: "tab", paneId: p.id, index: p.tabs.length };
      } else target = { kind: "side", targetId: r.id, side: spec.split };
    } else if (spec.force) {
      const side = (r.failed && DIRECTION_SIDES[r.failed]) ?? (spec.split !== "tab" ? spec.split : null);
      if (side) {
        const idx = this.index();
        let a: LayoutNode | null = idx.parent(r.last);
        while (a && (a.type === "slot" || !kind(a).sides.includes(side))) a = idx.parent(a.id);
        target = { kind: "side", targetId: (a ?? idx.node(r.last)!).id, side };
      }
    }
    const subject = target && this.subjectOf(what);
    const result = subject && this.tryDrop(subject, target!);
    if (!result) return null;
    this.commitDrop(result, undefined, undefined, spec.focus !== false);
    return result.paneId;
  }

  /**
   * Insert a new cell, as `spec` says (see `place`). What it is, the focused cell decides
   * (the host's `lifecycle.spawn`): the selected pane's active tab, or for a split, its most
   * recently focused pane's. Returns the pane holding it, or null.
   */
  spawn(spec: PlaceSpec): Cell | null {
    return this.withOperand(() => {
      const sel = this.node(this.selection.id);
      const pane = sel && this.node(sel.type === "pane" ? sel.id : this.descend(sel));
      const from = pane?.type === "pane" ? pane.tabs[pane.active] : undefined;
      if (!from) return null;
      const tab = this.lifecycle.spawn ? this.lifecycle.spawn(from) : { id: genId("t"), title: "New tab" };
      return tab ? this.placer(spec).apply(tab) : null;
    }, null);
  }

  /**
   * Move the focused tab (the selected pane's active tab) as `spec` says (see `place`).
   * Returns the pane that ends up holding it, or null (e.g. a lone tab beside its own pane).
   */
  moveTab(spec: PlaceSpec): Cell | null {
    return this.withOperand(() => {
      const sel = this.node(this.selection.id);
      const tab = sel?.type === "pane" && !this.selection.range ? sel.tabs[sel.active] : undefined;
      return tab ? this.placer(spec).apply({ id: tab.id }) : null;
    }, null);
  }

  /** What placing something drags: an existing tab or pane, or a new node. */
  private subjectOf(what: Placeable): DragSubject | null {
    if ("type" in what) {
      const n = what as LayoutNode;
      if (!this.node(n.id)) return { kind: "external", node: n };
      return n.type === "pane" ? { kind: "pane", paneId: n.id } : null; // splits don't move
    }
    if (this.findTab(what.id)) return { kind: "tab", tabId: what.id };
    const n = this.node(what.id);
    if (n) return n.type === "pane" ? { kind: "pane", paneId: n.id } : null;
    if ("title" in what) return { kind: "external", node: { type: "pane", id: genId("p"), weight: 1, tabs: [what as Tab], active: 0 } };
    return null;
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
          const order = k.scroll ? (isSticky(parent) ? [i - 1, i + 1] : [i + 1, i - 1]) : [i - 1, i + 1];
          const near = order.map((j) => kids[j]).find(Boolean)!;
          const pick = k.scroll ? near : (this.mostRecent(parent.id, kids.filter((c) => c !== x)) ?? near);
          return { select: this.descend(pick) };
        }
        x = parent;
      }
      pane = holder;
    }
  }

  /** Down to a cell, through what was last focused (a pane showing a group: into the group). */
  descend(n: LayoutNode): string {
    if (n.type === "pane") {
      const g = activeGroup(n)?.children[0];
      return g ? this.descend(g) : n.id;
    }
    if (!isSplit(n)) return (n as LayoutNode).id; // another leaf type, if any
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
   * Group the selection (by default, the operand: see `operand`) into a new pane holding a
   * single group tab named `name`, taking the selection's place and size. A range is wrapped
   * in a split of the same axis. The new group is selected (e.g. to name it).
   */
  group(name: string, selection?: Selection): boolean {
    const sel = selection && this.node(selection.id) ? selection : this.operand();
    // Pinned nodes stay where they are.
    if (!sel || this.selectedNodes(sel).some((n) => kind(n).pinned)) return false;
    let holderId: string | undefined;
    return this.change(
      (forest) => {
        const n = find(forest, sel.id)?.node;
        if (!n || n.type === "slot") return false;
        let holder: PaneNode;
        if (sel.range && isSplit(n)) {
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

  // -------------------------------------------------------------------------
  // Operand: what cell operations act on

  /**
   * What cell operations (close, swap, move, insert, float, rename, group, maximize) act on:
   * the selection, unless the selected node's type redirects them (`registerOperand`). Null:
   * nothing.
   */
  operand(): Selection | null {
    const n = this.selection.range ? null : this.node(this.selection.id);
    const of = n && OPERANDS[n.type];
    return of ? of(this, n) : this.selection;
  }

  /**
   * Run a cell operation on the operand. If it isn't the selection, the selection is set to
   * it for the operation, then goes back (one undo step, restoring the selection).
   */
  withOperand<T>(fn: () => T, none: T): T {
    const sel = this.selection;
    const op = this.operand();
    if (!op) return none;
    if (sameSel(op, sel)) return fn();
    return this.record(() => {
      this.selection = op;
      try {
        return fn();
      } finally {
        if (this.node(sel.id)) this.selectImpl(sel, true);
      }
    });
  }

  /** A pane can collapse if its only tab is a group (not a scroll split's). */
  canCollapse(paneId: string): boolean {
    const p = this.node(paneId);
    return p?.type === "pane" && canCollapse(p);
  }

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
  commitDrop(result: ForestResult, consumed?: FloatingWindow, floatRect?: Rect, focus = true): void {
    this.record(() => {
      const windows = this.floating.filter((w) => w !== consumed);
      const trees = [...result.trees];
      if (result.floated && floatRect) {
        windows.push({ root: result.floated, rect: floatRect });
        trees.push(result.floated);
      }
      const main = result.trees[0]!;
      this.setTrees(trees, windows, focus && find(main, result.paneId) ? result.paneId : undefined);
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
    if (sel.range && isSplit(n) && sel.range[0] === 0 && sel.range[1] === n.children.length - 1)
      sel = { id: sel.id };
    this.selection = sel;
    this.expandStack = [];
    if (!sel.range && isCell(n)) {
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
    if (!sel.range || !isSplit(n)) return [n];
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
  private parentOf(s: Selection, idx = this.index()): LayoutNode | null {
    // From a range: its split (or the split's holder, if the split is a group's root).
    return s.range ? (idx.holder(s.id) ?? idx.node(s.id)) : idx.navParent(s.id);
  }

  /** Down one navigation step, to the most recently focused child (within the range, if any). */
  private childOf(s: Selection, idx = this.index()): LayoutNode | null {
    const n = idx.node(s.id);
    if (!n) return null;
    const pick = (split: SplitNode, range = [0, split.children.length - 1]) => {
      const allowed = split.children.slice(range[0], range[1] + 1);
      return this.mostRecent(split.id, allowed) ?? allowed[0];
    };
    return isSplit(n) && s.range ? pick(n, s.range) : idx.navChild(n, (split) => pick(split));
  }

  private goParent(): void {
    const up = this.parentOf(this.selection);
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

  private goChild(): void {
    const child = this.childOf(this.selection);
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
    if (n && isCell(n) && !this.selection.range) return false;
    const last = this.lastPane && this.node(this.lastPane);
    if (!last || !isCell(last)) return false;
    this.select({ id: last.id }, false);
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
    this.withOperand(() => {
      if (this.clearMultiSelection()) return;
      const me = this.node(this.selection.id);
      if (this.selection.range || me?.type !== "pane") return;
      const target = this.neighbour(side, "panes");
      if (!target) return;
      this.change((forest) => swapNodes(forest, me.id, target.id), () => me.id);
      this.boundary.set(`${me.id}:${opposite[side]}`, target);
      this.boundary.set(`${target.id}:${side}`, { id: me.id });
    }, undefined);
  }

  /**
   * The pane (or remembered selection) touching a side of a selection (by default, the
   * current one). `only`: what the remembered selection may be (panes, or single nodes).
   */
  private neighbour(side: Side, only: "any" | "panes" | "nodes" = "any", sel = this.selection): Selection | null {
    const tree = this.treeOf(sel.id);
    if (!tree) return null;
    const rects = computeRects(tree);
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
    if (remembered && rn && (only === "any" || (!remembered.range && (only === "nodes" || rn.type === "pane")))) {
      const r = this.selectionRect(remembered, rects);
      if (adjacent(r) && overlap(r) > EPS) return remembered;
    }
    // 2. Otherwise, the cell (any, or a pane if panes only) touching that side, preferring the
    // one facing our center. Cells without a rect are hidden (inactive groups); a pane showing
    // a group is a container.
    const center = horizontal ? S.y + S.h / 2 : S.x + S.w / 2;
    let best: { id: string; score: number } | null = null;
    for (const { node: p } of walk(tree)) {
      if (!isCell(p) || (p.type === "pane" ? !!p.tabs[p.active]?.group : only === "panes")) continue;
      const r = rects.get(p.id);
      if (!r || !adjacent(r)) continue;
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
    if (s.range && isSplit(x) && kind(x).axis === axis) {
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

  /**
   * Maximize the operand (usually the selection: see `operand`). If it isn't the selection,
   * the selection moves to it (null: nothing happens).
   */
  maximize(): void {
    const target = this.operand();
    if (!target) return;
    const moved = !sameSel(target, this.selection);
    if (moved) this.select(target, false); // the focus goes to what is maximized
    if (!this.inMain(this.selection.id)) {
      if (moved) this.emit();
      return;
    }
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
