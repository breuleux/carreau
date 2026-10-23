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
  applyDropRaw,
  closeTabWith,
  complexAt,
  complexType,
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
/** Resizing the focus (`resizeFocus`): a share step (of the split), a cell's height step (px). */
const SHARE_STEP = 0.05;
const CELL_STEP = 24;
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

/** A host change (see `Workspace.hostChange`): like a structural change, on a forest. */
export type HostFn = (forest: SplitNode) => boolean | void;
interface ResizeToken {
  key: string;
  before: Snapshot;
}
/** What a tab shows: the host's, kept as it is when undoing (see `restoreSnapshot`). */
const TAB_META = ["title", "icon", "short", "long", "accent", "status", "content", "data"] as const;

function snapshotTrees(s: Snapshot): LayoutNode[] {
  return [s.root, ...s.floating.map((w) => w.root)];
}

function allTabs(root: LayoutNode): Tab[] {
  return [...walk(root)].flatMap(({ node }) => (node.type === "pane" ? node.tabs : []));
}

/** Apply a host change to a snapshot, in place. False if it can't (then leave it be). */
function rebase(s: Snapshot, fn: HostFn): boolean {
  const { trees, value } = inForest(structuredClone(snapshotTrees(s)), fn);
  if (value === false || !trees[0]) return false;
  s.root = trees[0];
  s.floating = s.floating.flatMap((w, i) => (trees[i + 1] ? [{ root: trees[i + 1]!, rect: w.rect }] : []));
  return true;
}

/** A relative move, as the navigation shortcuts make it. */
export type Direction = "left" | "right" | "up" | "down" | "parent" | "child";
/** Where to go from a cell: a move, an explicit cell (or node), or a sequence of these. */
export type Path = Direction | { id: string } | { name: string } | Path[];
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
  /** a tab, a pane (all its tabs), or a batch of tabs (`clear`) */
  kind: "tab" | "pane" | "tabs";
  id: string;
  tabIds: string[];
}

/** Statuses of finished cells: what `clear` removes. */
export const CLEARABLE = new Set(["done", "standby", "error"]);

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
    if (select) this.selection = { id: select };
    this.validate(this.selection);
    this.emit();
  }

  /** Select `sel`, or something valid if it isn't (anymore); drop maximizations that aren't. */
  private validate(sel: Selection): void {
    const valid = (s: Selection | null) => {
      const n = s && this.node(s.id);
      if (!n) return null;
      return s.range && (!isSplit(n) || s.range[1] >= n.children.length) ? { id: s.id } : s;
    };
    this.selection = valid(sel) ?? { id: panes(this.root)[0].id };
    // Maximization only applies to the main tree.
    const validMain = (s: Selection | null) => (s && this.inMain(s.id) ? valid(s) : null);
    this.maximized = validMain(this.maximized);
    this.maxHistory = this.maxHistory.map(validMain);
    this.selectImpl(this.selection, false);
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
  /** Host changes made during the user action being recorded: replayed on its snapshot. */
  private hostDuring: HostFn[] = [];
  /** Splitter resizes in progress: their snapshots are rebased like the stacks'. */
  private resizing = new Set<ResizeToken>();
  /**
   * Whether closing is an undo step. If not (false), a closed tab is gone for good: its
   * removal is a host change (see `hostChange`), which undo can't bring back.
   */
  undoableClose = true;

  /** What counts as "the layout": trees, tabs and sizes; not the active tabs nor rects. */
  private layoutKey(trees: LayoutNode[] = this.trees()): string {
    return JSON.stringify(trees, (k, v) => (k === "active" ? undefined : v));
  }

  /**
   * A change that the host makes, not the user (e.g. a cell some process created, or one whose
   * process ended): it is not an undo step, and **undo never reverts it**. `fn` runs on the
   * current trees like `change`'s, then again on every undo and redo snapshot, so that they
   * include it too (it must only depend on the forest it's given). A snapshot it can't apply to
   * (`fn` returns false, or empties the main tree) is dropped, along with all the older ones.
   * `replay` (default: `fn`) is what runs on the snapshots, if it should differ (e.g. without
   * moving the focus). Returns whether it changed the current trees.
   */
  hostChange(fn: HostFn, select?: () => string | undefined, replay: HostFn = fn): boolean {
    const { trees, value } = inForest(structuredClone(this.trees()), fn);
    if (value === false || !trees[0]) return false;
    this.setTrees(trees, this.floating, select?.());
    if (this.recording > 0) this.hostDuring.push(replay);
    for (const stack of [this.undoStack, this.redoStack])
      for (let i = stack.length - 1; i >= 0; i--)
        if (!rebase(stack[i], replay)) {
          stack.splice(0, i + 1);
          break;
        }
    for (const t of this.resizing) if (!rebase(t.before, replay)) this.resizing.delete(t);
    return true;
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
    // What tabs show (status, titles…) is the host's: it stays as it is now.
    const now = new Map<string, Tab>();
    for (const t of this.trees()) for (const tab of allTabs(t)) now.set(tab.id, tab);
    for (const t of snapshotTrees(s))
      for (const tab of allTabs(t)) {
        const cur = now.get(tab.id);
        if (cur) for (const f of TAB_META) cur[f] === undefined ? delete tab[f] : ((tab as any)[f] = cur[f]);
      }
    Object.assign(this, { root: s.root, floating: s.floating, maximized: s.maximized, maxHistory: s.maxHistory, lastPane: s.lastPane });
    this.validate(s.selection); // (host changes may have removed what it had selected)
    this.expandStack = s.expandStack; // after selectImpl, which clears it
    this.emit();
  }

  /**
   * Run a user action, recording the state before it if it changes the layout. Nested
   * actions record once (the outermost). Host changes meanwhile apply to that state too.
   */
  private record<T>(fn: () => T): T {
    if (this.recording > 0) return fn();
    const before = this.snapshot();
    this.hostDuring = [];
    this.recording++;
    try {
      return fn();
    } finally {
      this.recording--;
      const ok = this.hostDuring.every((f) => rebase(before, f));
      this.hostDuring = [];
      if (ok && this.layoutKey() !== this.layoutKey(snapshotTrees(before))) this.pushUndo(before, "action");
    }
  }

  /** Splitter resizes: consecutive resizes of the same splitter (`key`) are one step. */
  beginResize(key: string): ResizeToken {
    const token = { key, before: this.snapshot() };
    this.resizing.add(token);
    return token;
  }

  endResize(token: ResizeToken): void {
    // (Gone: a host change made its snapshot unusable.)
    if (!this.resizing.delete(token)) return;
    if (this.layoutKey() === this.layoutKey(snapshotTrees(token.before))) return;
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
    // (The main tree's last tab: not if its pane would go. A named pane stays, empty.)
    return !(main.length === 1 && main[0].tabs.length === 1 && main[0].tabs[0].id === tabId && !main[0].name);
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
      const n = "name" in path ? this.paneByName(path.name) : this.node(path.id);
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
    const result = this.placeDrop(spec, what);
    if (!result) return null;
    this.commitDrop(result, undefined, undefined, spec.focus !== false);
    return result.paneId;
  }

  /** Whether `place` would place it (and change something). */
  canPlace(spec: PlaceSpec, what: Placeable): boolean {
    return !!this.placeDrop(spec, what);
  }

  /**
   * Like `place`, but as a host change (see `hostChange`): not an undo step, and never undone.
   * The focus stays. Returns the pane holding it, or null.
   */
  hostPlace(spec: PlaceSpec, what: Placeable): string | null {
    const target = this.placeTarget(spec);
    const subject = target && this.subjectOf(what);
    return subject ? this.hostDrop(subject, target!) : null;
  }

  /**
   * A drop, as a host change (see `hostChange`): not an undo step, and never undone. The focus
   * stays. Returns the pane holding what was dropped, or null if the drop is invalid.
   */
  hostDrop(subject: DragSubject, target: DropTarget): string | null {
    if (!this.tryDrop(subject, target)) return null;
    let paneId: string | null = null;
    const ok = this.hostChange((forest) => {
      // (A new node goes into every snapshot: a copy of it each time.)
      const s = subject.kind === "external" ? { ...subject, node: structuredClone(subject.node) } : subject;
      const r = applyDropRaw(forest, s, target);
      if (!r) return false;
      paneId ??= r.paneId;
    });
    return ok ? paneId : null;
  }

  /** The drop `place` makes (computed, not committed). */
  private placeDrop(spec: PlaceSpec, what: Placeable): ForestResult | null {
    const target = this.placeTarget(spec);
    const subject = target && this.subjectOf(what);
    return (subject && this.tryDrop(subject, target!)) || null;
  }

  /** Where `place` drops (see `place`). */
  private placeTarget(spec: PlaceSpec): DropTarget | null {
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
    return target;
  }

  // -------------------------------------------------------------------------
  // Marks: stored selections, to move together

  /**
   * Marked tabs and panes (ids), in the order marked: "stored selections", to move together
   * (`moveMarked`). UI state: not part of the layout (not undoable, not saved).
   */
  marked: string[] = [];

  /**
   * Toggle the marks of a selection (default: the operand). A pane: its active tab (or, empty,
   * the pane); a split or a range: the panes in it. All marked already: unmarked; else, the
   * missing ones are marked.
   */
  toggleMark(sel: Selection | null = this.operand()): void {
    const n = sel && this.node(sel.id);
    if (!sel || !n) return;
    const ids =
      n.type === "pane" && !sel.range ? [n.tabs[n.active]?.id ?? n.id] : this.selectedNodes(sel).flatMap((x) => panes(x)).map((p) => p.id);
    if (!ids.length) return;
    this.marked = this.validMarks();
    if (ids.every((id) => this.marked.includes(id))) this.marked = this.marked.filter((id) => !ids.includes(id));
    else this.marked.push(...ids.filter((id) => !this.marked.includes(id)));
    this.emit();
  }

  /** Forget the marks. */
  clearMarks(): void {
    if (!this.marked.length) return;
    this.marked = [];
    this.emit();
  }

  /** The marks still standing for something (a closed tab's, or pane's, are gone). */
  validMarks(): string[] {
    return this.marked.filter((id) => this.findTab(id) || this.node(id)?.type === "pane");
  }

  /**
   * Move what's marked to the focus, in the order marked: into the focused pane's tabs (a
   * split: its most recently focused pane's); on a leaf that isn't a pane (a prompt), each as a
   * cell just before it. Like drops (a pane's name goes along: see `applyDropRaw`), all in one
   * undo step; the focus stays. Then the marks are forgotten. Returns how many moved.
   */
  moveMarked(): number {
    const marks = this.validMarks();
    let moved = 0;
    this.record(() => {
      for (const id of marks) {
        const focus = this.node(this.selection.id);
        if (!focus) break;
        let target: DropTarget | null = null;
        if (isSplit(focus) || focus.type === "pane") {
          // A pane: its own tabs (even if it shows a group); a split: its most recent pane's.
          const dest = focus.type === "pane" ? focus : this.node(this.descend(focus));
          if (dest?.type === "pane") target = { kind: "tab", paneId: dest.id, index: dest.tabs.length };
        } else {
          const leaf = focus as LayoutNode; // (other leaf types, if any)
          const parent = this.index().parent(leaf.id);
          if (parent && isSplit(parent)) target = { kind: "between", splitId: parent.id, index: parent.children.indexOf(leaf) };
        }
        const subject = target && this.subjectOf({ id });
        const result = subject && this.tryDrop(subject, target!);
        if (!result) continue;
        this.commitDrop(result, undefined, undefined, false);
        moved++;
      }
    });
    this.marked = [];
    this.emit();
    return moved;
  }

  // -------------------------------------------------------------------------
  // Pane names, and sending things to panes

  /** Names panes can't have (ignoring case): e.g. the directions `sendTo` also takes. */
  reservedNames: string[] = ["left", "right", "up", "down"];

  /** The pane with that name (ignoring case), in any tree; or null. */
  paneByName(name: string): PaneNode | null {
    const key = name.trim().toLowerCase();
    for (const t of this.trees()) for (const p of panes(t)) if (p.name?.toLowerCase() === key) return p;
    return null;
  }

  /** Whether a pane can take that name: not empty, not reserved, not another pane's. */
  canNamePane(paneId: string, name: string): boolean {
    const n = name.trim();
    if (!n || this.reservedNames.some((r) => r.toLowerCase() === n.toLowerCase())) return false;
    const other = this.paneByName(n);
    return !other || other.id === paneId;
  }

  /** Name a pane (null, or blank: no name). Undoable. Returns whether it did. */
  namePane(paneId: string, name: string | null): boolean {
    const n = name?.trim() || null;
    if (n !== null && !this.canNamePane(paneId, n)) return false;
    return this.change((forest) => {
      const p = find(forest, paneId)?.node;
      if (p?.type !== "pane" || (p.name ?? null) === n) return false;
      if (n === null) delete p.name;
      else p.name = n;
    });
  }

  /**
   * Send a tab (by id), or a whole pane (its tabs), into another pane's tabs: the pane with
   * that name, or the neighbour of the pane holding it on that side ("left", "right", "up",
   * "down"; if there's none, where it would be). Like a drop: undoable; what's sent gets the
   * focus. Returns the pane that ends up holding it, or null.
   */
  sendTo(id: string, to: string): string | null {
    const result = this.sendDrop(id, to);
    if (!result) return null;
    this.commitDrop(result);
    return result.paneId;
  }

  /** Whether `sendTo` would send it (and change something). */
  canSendTo(id: string, to: string): boolean {
    return !!this.sendDrop(id, to);
  }

  private sendDrop(id: string, to: string): ForestResult | null {
    const src = this.findTab(id)?.pane ?? this.node(id);
    if (src?.type !== "pane") return null;
    // A side: into the neighbour's tabs (its most recently focused pane's), as moveInto does.
    if (to in DIRECTION_SIDES) return this.placeDrop({ split: "tab", base: [{ id: src.id }, to as Direction], force: true }, { id });
    // A name: into that pane's own tabs (even if it shows a group).
    const dest = this.paneByName(to);
    const subject = dest && dest.id !== src.id ? this.subjectOf({ id }) : null;
    return subject && this.tryDrop(subject, { kind: "tab", paneId: dest!.id, index: dest!.tabs.length });
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
    if (!this.findTab(tabId) || !this.canCloseTab(tabId) || this.closing.has(tabId)) return Promise.resolve(false);
    this.leaveComplex(tabId);
    const ft = this.findTab(tabId)!;
    return this.runClose({ kind: "tab", id: tabId, tabIds: [tabId] }, closeTabWith(ft.pane.tabs[ft.index], this.lifecycle));
  }

  /**
   * A merged tab about to close: its complex's type has a say first (`closing`), then it
   * leaves the complex (unlinked, just after it), and only then do its contents close. (Its own
   * undo step: if the close is refused, the tab stays, out of the complex.)
   */
  private leaveComplex(tabId: string): void {
    const ft = this.findTab(tabId);
    if (!ft || complexAt(ft.pane, ft.index).tabs.length < 2) return;
    this.closeChange((forest) => {
      const f = findTab(forest, tabId);
      // (Not merged there, in history: nothing to do.)
      if (!f || complexAt(f.pane, f.index).tabs.length < 2) return;
      const c = complexAt(f.pane, f.index);
      const tab = f.pane.tabs[f.index];
      const active = f.pane.tabs[f.pane.active];
      complexType(c.key)?.closing?.(forest, c, tab, this);
      f.pane.tabs.splice(f.index, 1);
      delete tab.link;
      f.pane.tabs.splice(c.start + c.tabs.length - 1, 0, tab);
      f.pane.active = f.pane.tabs.indexOf(active);
    });
  }

  /** Close a pane and all its tabs, like `closeTab`. */
  closePane(paneId: string): Promise<boolean> {
    const p = this.node(paneId);
    if (p?.type !== "pane" || !this.canClosePane(paneId)) return Promise.resolve(false);
    return this.runClose({ kind: "pane", id: paneId, tabIds: p.tabs.map((t) => t.id) }, kind(p).close(p, this.lifecycle));
  }

  /**
   * Clear the selection (or `sel`): close every tab with a finished status (`CLEARABLE`:
   * "done", "standby", "error") in it, inside groups too (a group tab itself, never: only what
   * it holds). Emptied panes go. Meanwhile the tabs show as closing; once their contents have
   * closed (through the lifecycle), they are removed together, as one undo step. (A refused
   * close: that tab stays.) On a node that holds no tabs (e.g. a prompt): its parent's. The
   * selection stays, or goes to what's left of it. Resolves to how many tabs were removed.
   */
  async clear(sel: Selection = this.selection): Promise<number> {
    let n = this.node(sel.id);
    if (!n) return 0;
    let nodes = this.selectedNodes(sel);
    if (n.type !== "pane" && !isSplit(n)) {
      n = this.index().parent((n as LayoutNode).id); // (other leaf types, if any)
      if (!n) return 0;
      nodes = [n];
    }
    const tabs = nodes.flatMap((x) => [...walk(x)]).flatMap(({ node }) => (node.type === "pane" ? node.tabs : []));
    const clearable = tabs.filter((t) => !t.group && CLEARABLE.has(t.status ?? "") && !this.closing.has(t.id));
    if (!clearable.length) return 0;
    const op: CloseOp = { kind: "tabs", id: "", tabIds: clearable.map((t) => t.id) };
    for (const id of op.tabIds) this.closing.set(id, op);
    this.emit();
    const results = await Promise.allSettled(clearable.map((t) => closeTabWith(t, this.lifecycle)));
    // (Forced meanwhile: already gone, and out of the batch.)
    const closed = op.tabIds.filter((id) => results[clearable.findIndex((t) => t.id === id)].status === "fulfilled");
    this.endClose(op);
    // (The selection now: it may have moved while the contents closed.)
    const was = this.selection;
    const tree = this.treeOf(was.id);
    const path = (tree && pathTo(tree, was.id)) ?? [];
    const removed =
      closed.length > 0 &&
      this.closeChange((forest) => {
        for (const id of closed) {
          const ft = findTab(forest, id);
          if (!ft) continue;
          ft.pane.tabs.splice(ft.index, 1);
          if (ft.index < ft.pane.active || ft.pane.active >= ft.pane.tabs.length) ft.pane.active = Math.max(0, ft.pane.active - 1);
        }
      });
    // The selection went with what was cleared: to what's left of it (the innermost survivor).
    if (removed && !this.node(was.id)) {
      const left = [...path].reverse().find((x) => x.type !== "slot" && this.node(x.id));
      if (left) this.select({ id: left.id });
    }
    if (!removed) this.emit();
    return removed ? closed.length : 0;
  }

  /**
   * Close what a tab's pending close is about (the tab, or its whole pane) right away: call
   * the forceful close without waiting for it, and remove it.
   */
  forceClose(tabId: string): boolean {
    if (!this.closing.has(tabId)) this.leaveComplex(tabId);
    let op = this.closing.get(tabId) ?? { kind: "tab" as const, id: tabId, tabIds: [tabId] };
    if (op.kind === "tabs") {
      // One tab of a batch (a clear): that tab alone, now; the batch goes on without it.
      this.closing.delete(tabId);
      op.tabIds = op.tabIds.filter((x) => x !== tabId);
      op = { kind: "tab", id: tabId, tabIds: [tabId] };
    }
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
    // Forced meanwhile (it's no longer pending). (An empty pane had nothing pending: it goes.)
    if (!this.endClose(op) && op.tabIds.length) return false;
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
    const del = (forest: SplitNode) => {
      if (op.kind === "pane") return removeNode(forest, op.id);
      const ft = findTab(forest, op.id);
      if (!ft) return false;
      ft.pane.tabs.splice(ft.index, 1);
      if (ft.index < ft.pane.active || ft.pane.active >= ft.pane.tabs.length) ft.pane.active = Math.max(0, ft.pane.active - 1);
    };
    return this.closeChange(
      (forest) => {
        if (del(forest) === false) return false;
        const a = next?.activate;
        const p = a && find(forest, a.paneId)?.node;
        if (p?.type === "pane") p.active = Math.max(0, p.tabs.findIndex((t) => t.id === a!.tabId));
      },
      () => next?.select,
      // (Elsewhere in history, it may not be there anymore: nothing to remove, no harm.)
      (forest) => void del(forest),
    );
  }

  /** A change that a close makes: an undo step, or a host change (see `undoableClose`). */
  private closeChange(fn: HostFn, select?: () => string | undefined, replay: HostFn = fn): boolean {
    return this.undoableClose ? this.change(fn, select) : this.hostChange(fn, select, replay);
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
      // A named pane stays, empty (a tab of it closed): the focus too.
      if (gone !== null && pane.name) return { select: pane.id };
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

  /**
   * Grow (`delta` > 0) or shrink (< 0) the focus along an axis: the innermost node around the
   * selection whose size along that axis can change (up through splits, and through groups to
   * their holders). In a plain split along the axis: its share of it, 5% of the split per step
   * (the others keep their proportions, and the weights their total). A cell of a
   * scroll-column, vertically: its height (`size`), 24px per step; `measure` gives a node's current size in pixels along the axis,
   * for a cell that has no size yet. Steps on the same node and axis make one undo step (like a
   * splitter drag). Returns whether something changed.
   */
  resizeFocus(axis: "row" | "column", delta: number, measure?: (id: string) => number | null): boolean {
    const idx = this.index();
    let x: LayoutNode | null = idx.node(this.selection.id);
    while (x) {
      const p: LayoutNode | null = idx.parent(x.id);
      if (p?.type === "slot") {
        x = idx.holder(x.id); // a group's root: its holder's size
        continue;
      }
      if (!p || p.type === "forest" || !isSplit(p)) return false;
      const k = kind(p);
      if (k.axis === axis) {
        if (k.scroll && axis === "column" && (x.type === "pane" || isSplit(x))) return this.resizeCell(x as PaneNode | SplitNode, delta, measure);
        if (!k.scroll && p.children.length > 1) return this.resizeShare(p, x, delta);
      }
      x = p;
    }
    return false;
  }

  private resizeShare(split: SplitNode, x: LayoutNode, delta: number): boolean {
    const total = split.children.reduce((s, c) => s + c.weight, 0);
    const others = total - x.weight;
    const frac = Math.min(0.95, Math.max(0.05, x.weight / total + SHARE_STEP * Math.sign(delta)));
    if (others <= 0 || Math.abs(frac - x.weight / total) < 1e-9) return false;
    const token = this.beginResize(`focus:${x.id}:${kind(split).axis}`);
    // The total stays the same: weights are flex-grow factors, and summing to less than the
    // number of children (after normalization, their average is 1) would leave blank space.
    const scale = ((1 - frac) * total) / others;
    for (const c of split.children) c.weight = c === x ? frac * total : c.weight * scale;
    this.endResize(token);
    this.emit();
    return true;
  }

  private resizeCell(x: PaneNode | SplitNode, delta: number, measure?: (id: string) => number | null): boolean {
    const start = x.size ?? measure?.(x.id);
    if (!start) return false;
    const token = this.beginResize(`focus:${x.id}:column`);
    x.size = Math.max(40, Math.round(start + CELL_STEP * Math.sign(delta)));
    this.endResize(token);
    this.emit();
    return true;
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

  /**
   * Next or previous tab, in the innermost pane around the selection that has several (up
   * through the groups' holders: a group with a single tab has nothing to cycle). If that pane
   * isn't the selection, the focus moves into its newly shown tab.
   */
  private cycleTab(delta: number): void {
    const path = pathTo(this.tree(), this.selection.id) ?? [];
    const n = [...path].reverse().find((x): x is PaneNode => x.type === "pane" && x.tabs.length > 1);
    if (!n) return;
    n.active = (n.active + delta + n.tabs.length) % n.tabs.length;
    if (n.id !== this.selection.id) this.select({ id: this.descend(n) }, false);
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
      if (!isCell(p) || (p.type === "pane" ? !!activeGroup(p) : only === "panes")) continue;
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
