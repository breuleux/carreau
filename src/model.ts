// Layout model: a tree of rows/columns whose leaves are panes holding tabs.
// Everything in here is plain data and is JSON-serializable as-is.

export type Orientation = "row" | "column";
/**
 * Plain splits share their space between children according to weights. Scroll splits let
 * each child take its natural size along the axis and scroll when the content overflows.
 * Scroll splits are never created by moving things around; only by building the layout.
 */
export type SplitType = Orientation | "scroll-row" | "scroll-column" | "group";

/**
 * The axis along which a split lays out its children. A "group" node (the wrapper around a
 * group tab's layout, see Tab.group) has no axis: nothing is ever inserted beside its child.
 */
export function axisOf(type: SplitType): Orientation | null {
  if (type === "group") return null;
  return type === "row" || type === "scroll-row" ? "row" : "column";
}

export function isScroll(type: SplitType | "pane"): boolean {
  return type === "scroll-row" || type === "scroll-column";
}
export type Side = "left" | "right" | "top" | "bottom";

/**
 * A cell, shown as a tab. HTML parts: `content` (rendered by the host), `icon`, `short`
 * (shown in the tab; defaults to `title` as text) and `long` (shown at the top of the cell
 * in panes that show it, e.g. the shell command or prompt that created the cell).
 * Properties: `accent` (a CSS color) and `status`, which changes how the icon looks
 * ("done": faded, "error": red, "unresponsive": blinking; anything else: normal).
 */
export interface Tab {
  id: string;
  /** Plain-text name (also used where HTML can't be, e.g. the drag label). */
  title: string;
  icon?: string;
  short?: string;
  long?: string;
  accent?: string;
  status?: "done" | "error" | "unresponsive" | string;
  content?: string;
  /** Arbitrary serializable data for the host app (e.g. what to embed). */
  data?: Record<string, unknown>;
  /**
   * A group tab holds a whole layout instead of content: a node of type "group" whose single
   * child is the layout's root. Tree walks descend into it, so everything that works in a
   * layout (drops, swaps, navigation...) works inside groups too.
   */
  group?: SplitNode;
}

export interface PaneNode {
  type: "pane";
  id: string;
  weight: number;
  tabs: Tab[];
  active: number;
}

export interface SplitNode {
  type: SplitType;
  id: string;
  weight: number;
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Construction helpers

let counter = 0;
export function genId(prefix = "n"): string {
  counter++;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function pane(tabs: (string | Tab)[], weight = 1): PaneNode {
  return {
    type: "pane",
    id: genId("p"),
    weight,
    active: 0,
    tabs: tabs.map((t) => (typeof t === "string" ? { id: genId("t"), title: t } : t)),
  };
}

export function row(children: LayoutNode[], weight = 1): SplitNode {
  return { type: "row", id: genId("r"), weight, children };
}

export function column(children: LayoutNode[], weight = 1): SplitNode {
  return { type: "column", id: genId("c"), weight, children };
}

export function scrollRow(children: LayoutNode[], weight = 1): SplitNode {
  return { type: "scroll-row", id: genId("sr"), weight, children };
}

export function scrollColumn(children: LayoutNode[], weight = 1): SplitNode {
  return { type: "scroll-column", id: genId("sc"), weight, children };
}

// ---------------------------------------------------------------------------
// Serialization

/** A layout tree pulled out of the hierarchy, shown as a floating window. */
export interface FloatingWindow {
  root: LayoutNode;
  /** position and size in pixels, relative to the workspace */
  rect: Rect;
}

/** Everything that is serialized: the tree, plus floating windows. */
export interface WorkspaceData {
  root: LayoutNode;
  floating: FloatingWindow[];
}

export function serialize(data: WorkspaceData | LayoutNode): string {
  return JSON.stringify(data, null, 2);
}

/** Accepts either a bare tree or `{root, floating}`. */
export function deserialize(text: string): WorkspaceData {
  const data = JSON.parse(text);
  if (data && typeof data === "object" && "root" in data) {
    validate(data.root);
    const floating: FloatingWindow[] = (Array.isArray(data.floating) ? data.floating : []).map(
      (f: any) => ({ root: f.root ?? f.pane, rect: f.rect }), // older format: {pane, rect}
    );
    for (const f of floating) validate(f.root);
    return { root: data.root, floating };
  }
  validate(data);
  return { root: data, floating: [] };
}

function validate(n: any): void {
  if (!n || typeof n !== "object" || typeof n.id !== "string") throw new Error("Invalid node");
  if (typeof n.weight !== "number") n.weight = 1;
  if (n.type === "pane") {
    if (!Array.isArray(n.tabs)) throw new Error("Pane without tabs");
    n.active = Math.max(0, Math.min(n.active ?? 0, n.tabs.length - 1));
    for (const t of n.tabs) {
      if (!t.group) continue;
      if (t.group.type !== "group" || !Array.isArray(t.group.children) || t.group.children.length !== 1)
        throw new Error("A group tab must hold a group node with one child");
      validate(t.group);
    }
  } else if (["row", "column", "scroll-row", "scroll-column", "group"].includes(n.type)) {
    if (!Array.isArray(n.children)) throw new Error("Split without children");
    n.children.forEach(validate);
  } else {
    throw new Error(`Unknown node type ${n.type}`);
  }
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}

// ---------------------------------------------------------------------------
// Queries

export interface Located {
  node: LayoutNode;
  parent: SplitNode | null;
  index: number;
}

export function* walk(
  node: LayoutNode,
  parent: SplitNode | null = null,
  index = 0,
): Generator<Located> {
  yield { node, parent, index };
  if (node.type !== "pane") {
    for (let i = 0; i < node.children.length; i++) {
      yield* walk(node.children[i], node, i);
    }
  } else {
    // Group tabs: their group node is reached from the pane (with no split parent).
    for (const t of node.tabs) if (t.group) yield* walk(t.group, null, 0);
  }
}

/** The pane holding a group node (as the `group` of one of its tabs). */
export function holderOf(root: LayoutNode, groupId: string): { pane: PaneNode; index: number } | null {
  for (const p of panes(root)) {
    const i = p.tabs.findIndex((t) => t.group?.id === groupId);
    if (i >= 0) return { pane: p, index: i };
  }
  return null;
}

/** The active group tab's group node, if a pane is showing a group. */
export function activeGroup(p: PaneNode): SplitNode | null {
  return p.tabs[p.active]?.group ?? null;
}

export function find(root: LayoutNode, id: string): Located | null {
  for (const loc of walk(root)) if (loc.node.id === id) return loc;
  return null;
}

/** Path of nodes from the root to the node with the given id (inclusive). */
export function pathTo(root: LayoutNode, id: string): LayoutNode[] | null {
  if (root.id === id) return [root];
  const children = root.type === "pane" ? root.tabs.flatMap((t) => (t.group ? [t.group] : [])) : root.children;
  for (const c of children) {
    const p = pathTo(c, id);
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

/** Logical rectangles of every node, in the given frame (defaults to the unit square). */
export function computeRects(
  root: LayoutNode,
  frame: Rect = { x: 0, y: 0, w: 1, h: 1 },
  out = new Map<string, Rect>(),
): Map<string, Rect> {
  out.set(root.id, frame);
  if (root.type === "pane") {
    // A pane showing a group: the group's layout takes the pane's place (inactive groups
    // are hidden and get no rects).
    const g = activeGroup(root);
    if (g?.children[0]) computeRects(g.children[0], frame, out);
    return out;
  }
  const total = root.children.reduce((s, c) => s + c.weight, 0) || 1;
  let offset = 0;
  for (const c of root.children) {
    const frac = c.weight / total;
    const r =
      axisOf(root.type) === "row"
        ? { x: frame.x + offset * frame.w, y: frame.y, w: frac * frame.w, h: frame.h }
        : { x: frame.x, y: frame.y + offset * frame.h, w: frame.w, h: frac * frame.h };
    computeRects(c, r, out);
    offset += frac;
  }
  return out;
}

export const sideAxis: Record<Side, Orientation> = {
  left: "row",
  right: "row",
  top: "column",
  bottom: "column",
};

export const sideIsStart: Record<Side, boolean> = {
  left: true,
  top: true,
  right: false,
  bottom: false,
};

export const opposite: Record<Side, Side> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};

// ---------------------------------------------------------------------------
// Mutations (in place). Call normalize() afterwards.

/**
 * Insert `node` on the given side of the node `targetId`.
 * If the target's parent is split along the side's axis, the node becomes a sibling
 * and takes half of the target's space; otherwise the target is wrapped in a new split.
 * Returns the (possibly new) root.
 */
export function insertBeside(
  root: LayoutNode,
  targetId: string,
  side: Side,
  node: LayoutNode,
): LayoutNode {
  const loc = find(root, targetId);
  if (!loc) throw new Error(`No node ${targetId}`);
  const axis = sideAxis[side];
  const before = sideIsStart[side];
  const { node: target, parent, index } = loc;
  if (parent && parent.id !== FOREST && axisOf(parent.type) === axis) {
    const w = target.weight / 2;
    target.weight = w;
    node.weight = w;
    parent.children.splice(before ? index : index + 1, 0, node);
    return root;
  }
  const wrapper: SplitNode = {
    type: axis,
    id: genId(axis === "row" ? "r" : "c"),
    weight: target.weight,
    children: before ? [node, target] : [target, node],
  };
  target.weight = 1;
  node.weight = 1;
  if (parent) {
    parent.children[index] = wrapper;
    return root;
  }
  return wrapper;
}

/**
 * Exchange the positions of two disjoint nodes. Weights stay with the positions,
 * so the geometry of the layout is unchanged.
 */
export function swapNodes(root: LayoutNode, idA: string, idB: string): void {
  const a = find(root, idA);
  const b = find(root, idB);
  if (!a?.parent || !b?.parent) return;
  if (pathTo(a.node, idB) || pathTo(b.node, idA)) return; // nested: not swappable
  [a.node.weight, b.node.weight] = [b.node.weight, a.node.weight];
  a.parent.children[a.index] = b.node;
  b.parent.children[b.index] = a.node;
}

/** Remove a node from the tree. Returns the new root (null if the tree became empty). */
export function removeNode(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return null;
  const loc = find(root, id);
  if (!loc || !loc.parent) return root;
  loc.parent.children.splice(loc.index, 1);
  return normalize(root);
}

/**
 * Clean up the tree:
 *  - drop empty panes and empty splits
 *  - collapse splits with a single child
 *  - flatten splits nested in a split of the same orientation
 */
/**
 * Normalize a whole tree (the main one or a floating window's). On top of `normalize`, a
 * scroll split at the root is wrapped in a group tab, like everywhere else.
 */
export function normalizeTree(node: LayoutNode): LayoutNode | null {
  const n = normalize(node);
  return n && isScroll(n.type) ? wrapInGroupTab(n as SplitNode) : n;
}

/**
 * Wrap a scroll split in a holder pane with a single group tab. Scroll splits are always the
 * root of a group: that tab is how the whole scroll split is moved around.
 */
export function wrapInGroupTab(split: SplitNode): PaneNode {
  const weight = split.weight;
  split.weight = 1;
  return {
    type: "pane",
    id: genId("p"),
    weight,
    active: 0,
    tabs: [
      {
        id: genId("t"),
        title: split.type === "scroll-row" ? "Scroll row" : "Scroll column",
        group: { type: "group", id: genId("g"), weight: 1, children: [split] },
      },
    ],
  };
}

export function normalize(node: LayoutNode): LayoutNode | null {
  if (node.type === "pane") {
    // Group tabs: normalize their layout; a group left empty disappears with its tab.
    node.tabs = node.tabs.filter((t, i) => {
      if (!t.group) return true;
      const inner = t.group.children[0] ? normalize(t.group.children[0]) : null;
      if (inner) {
        t.group.children = [inner];
        return true;
      }
      if (i < node.active) node.active--;
      return false;
    });
    if (node.tabs.length === 0) return null;
    node.active = Math.max(0, Math.min(node.active, node.tabs.length - 1));
    return node;
  }
  const kids: LayoutNode[] = [];
  for (const c of node.children) {
    let n = normalize(c);
    if (!n) continue;
    // Same type: flatten. A plain split inside a scroll split of the same axis is flattened
    // too (its children are naturally sized either way); the reverse is not, since a scroll
    // split inside a plain one is what provides the scrolling.
    const sameAxisPlainInScroll =
      n.type !== "pane" && !isScroll(n.type) && isScroll(node.type) && axisOf(n.type) === axisOf(node.type);
    if (n.type !== "pane" && (n.type === node.type || sameAxisPlainInScroll)) {
      const total = n.children.reduce((s, k) => s + k.weight, 0) || 1;
      for (const k of n.children) {
        k.weight = (k.weight / total) * n.weight;
        kids.push(k);
      }
    } else {
      // Scroll splits always live in a group tab (so they can be moved as a whole).
      if (isScroll(n.type)) n = wrapInGroupTab(n as SplitNode);
      kids.push(n);
    }
  }
  node.children = kids;
  if (kids.length === 0) return null;
  // Rescale weights to average 1 (same ratios). Weights are used as flex-grow factors, and
  // flex-grow factors summing to less than 1 only claim that fraction of the free space:
  // after a few half-splitting moves, children would leave part of their parent empty.
  const total = kids.reduce((s, k) => s + k.weight, 0);
  if (total > 0) for (const k of kids) k.weight = (k.weight * kids.length) / total;
  // A scroll split is kept even with a single child: it could not be recreated by dragging.
  if (kids.length === 1 && !isScroll(node.type)) {
    kids[0].weight = node.weight;
    return kids[0];
  }
  return node;
}

// ---------------------------------------------------------------------------
// Drops

export type DropTarget =
  | { kind: "side"; targetId: string; side: Side }
  | { kind: "tab"; paneId: string; index: number }
  /** Insert as child `index` of split `splitId`, sized to 1/N of the split. */
  | { kind: "between"; splitId: string; index: number }
  /**
   * Exchange contents with a pane: a dragged tab trades places with the pane's active tab;
   * a dragged pane trades all its tabs with the pane's.
   */
  | { kind: "swap"; paneId: string }
  /**
   * Pull the dragged thing out of the hierarchy into a floating window. Only over its own
   * pane: a dragged pane (or its only tab) floats the pane; a tab among others floats alone.
   */
  | { kind: "float"; paneId: string };

export type DragSubject =
  | { kind: "tab"; tabId: string }
  | { kind: "pane"; paneId: string }
  /** A node that is in none of the trees (a floating window's tree being docked). */
  | { kind: "external"; node: LayoutNode };

/**
 * Result of a drop across several trees (the main tree, then floating windows' trees, in
 * the order they were given). A tree is null if the drop emptied it.
 */
export interface ForestResult {
  trees: (LayoutNode | null)[];
  /** id of the pane that ends up holding the dragged thing */
  paneId: string;
  /** for `float` drops: the pane to show as a new floating window (in none of the trees) */
  floated?: PaneNode;
}

export interface DropResult {
  root: LayoutNode;
  paneId: string;
  floated?: PaneNode;
}

/** Single-tree convenience wrapper around applyDropForest. */
export function applyDrop(
  original: LayoutNode,
  subject: DragSubject,
  target: DropTarget,
): DropResult | null {
  const r = applyDropForest([original], subject, target);
  return r ? { root: r.trees[0]!, paneId: r.paneId, floated: r.floated } : null;
}

/**
 * Apply a drop to copies of several trees at once, so that things can move between them.
 * `trees[0]` is the main tree: a drop that would empty it is invalid. Returns null if the
 * drop is invalid or a no-op.
 */
export function applyDropForest(
  trees: LayoutNode[],
  subject: DragSubject,
  target: DropTarget,
): ForestResult | null {
  // All trees go under a temporary root, so that ids stay findable across them and the
  // detach/insert logic works unchanged. That root is never normalized as a split: each
  // tree is normalized on its own, and a tree emptied by the drop becomes an EMPTY marker
  // rather than being spliced out, so that tree indices stay stable.
  const forest: SplitNode = { type: "row", id: FOREST, weight: 1, children: clone(trees) };
  const r = applyDropRaw(forest, subject, target);
  if (!r) return null;
  const out = forest.children.map((c) => (c.id === EMPTY ? null : c));
  if (!out[0]) return null; // the main tree cannot be emptied
  if (target.kind === "float") {
    // Floating a floating window's only pane again would change nothing.
    const i = trees.findIndex((t) => t.id === target.paneId);
    if (i > 0) return null;
  }
  // A drop that leaves the arrangement as it was (e.g. a lone tab dropped on a border it
  // already occupies) is pointless, even if sizes would change.
  const shapeOf = (ts: (LayoutNode | null)[]) => ts.map((t) => (t ? shape(t) : "-")).join(" ; ");
  if (!r.floated && shapeOf(out) === shapeOf(trees)) return null;
  return { trees: out, paneId: r.paneId, floated: r.floated };
}

const FOREST = "__forest__";
const EMPTY = "__empty__";
const TOMB = "__tombstone__";

function emptyMarker(): PaneNode {
  return { type: "pane", id: EMPTY, weight: 1, tabs: [], active: 0 };
}

/** Remove a child; at the top of the forest, leave an EMPTY marker so indices don't shift. */
function removeAt(parent: SplitNode, index: number): void {
  if (parent.id === FOREST) parent.children[index] = emptyMarker();
  else parent.children.splice(index, 1);
}

/** Normalize each tree of the forest separately. */
function normalizeForest(forest: SplitNode): void {
  forest.children = forest.children.map((c) => normalizeTree(c) ?? emptyMarker());
}

/** Structure of a layout, ignoring ids and sizes: nesting, orientation, tabs in each pane. */
export function shape(node: LayoutNode): string {
  if (node.type === "pane")
    return `[${node.tabs.map((t) => (t.group ? `${t.id}{${t.group.children.map(shape).join(" ")}}` : t.id)).join(",")}]`;
  return `${node.type}(${node.children.map(shape).join(" ")})`;
}

/** Works on the forest in place. Returns where the dragged thing went, or null. */
/** Ids of the nodes a drop target refers to. */
function targetIds(t: DropTarget): string[] {
  return t.kind === "side" ? [t.targetId] : t.kind === "between" ? [t.splitId] : [t.paneId];
}

/**
 * Whether a drop would put something inside itself: the target lies in a group carried by
 * the dragged tab, or by one of the dragged pane's tabs.
 */
function wouldNestInItself(root: SplitNode, subject: DragSubject, target: DropTarget): boolean {
  let groups: SplitNode[] = [];
  if (subject.kind === "tab") {
    const g = findTab(root, subject.tabId)?.pane.tabs.find((t) => t.id === subject.tabId)?.group;
    if (g) groups = [g];
  } else if (subject.kind === "pane") {
    const p = find(root, subject.paneId)?.node;
    if (p?.type === "pane") groups = p.tabs.flatMap((t) => (t.group ? [t.group] : []));
  }
  return groups.some((g) => targetIds(target).some((id) => find(g, id)));
}

function applyDropRaw(
  root: SplitNode,
  subject: DragSubject,
  target: DropTarget,
): { paneId: string; floated?: PaneNode } | null {
  if (wouldNestInItself(root, subject, target)) return null;
  // Never beside a scroll split itself: it lives as its group's root, so this would wrap it in
  // a split inside the group (and normalization would then pack it into yet another group).
  // Insert beside the group's holder, or into the scroll split, instead.
  if (target.kind === "side") {
    const t = find(root, target.targetId)?.node;
    if (t && t.type !== "pane" && isScroll(t.type)) return null;
  }
  if (target.kind === "float") {
    if (subject.kind === "external") return null;
    const loc = find(root, target.paneId);
    if (!loc || loc.node.type !== "pane" || !loc.parent) return null;
    const p = loc.node;
    let floated: PaneNode;
    if (subject.kind === "pane" || (p.tabs.length === 1 && p.tabs[0].id === subject.tabId)) {
      if (subject.kind === "pane" && subject.paneId !== p.id) return null;
      removeAt(loc.parent, loc.index);
      floated = p;
    } else {
      const i = p.tabs.findIndex((t) => t.id === subject.tabId);
      if (i < 0) return null; // only over its own pane
      const [tab] = p.tabs.splice(i, 1);
      if (i < p.active || p.active >= p.tabs.length) p.active = Math.max(0, p.active - 1);
      floated = { type: "pane", id: genId("p"), weight: 1, tabs: [tab], active: 0 };
    }
    normalizeForest(root);
    return { paneId: floated.id, floated };
  }

  if (target.kind === "swap") {
    if (subject.kind === "external") return null;
    const dest = find(root, target.paneId)?.node;
    if (!dest || dest.type !== "pane") return null;
    if (subject.kind === "pane") {
      const src = find(root, subject.paneId)?.node;
      if (!src || src.type !== "pane" || src === dest) return null;
      [src.tabs, dest.tabs] = [dest.tabs, src.tabs];
      [src.active, dest.active] = [dest.active, src.active];
    } else {
      const ft = findTab(root, subject.tabId);
      if (!ft || ft.pane === dest) return null;
      const theirs = dest.tabs[dest.active];
      dest.tabs[dest.active] = ft.pane.tabs[ft.index];
      ft.pane.tabs[ft.index] = theirs;
    }
    return { paneId: dest.id };
  }

  // 1. Detach the subject, leaving a tombstone so that ids along the target path stay valid.
  let moving: LayoutNode;
  if (subject.kind === "external") {
    moving = { ...clone(subject.node), weight: 1 };
  } else if (subject.kind === "pane") {
    const loc = find(root, subject.paneId);
    if (!loc || loc.node.type !== "pane" || !loc.parent) return null;
    if (target.kind === "side" && target.targetId === subject.paneId) return null;
    if (target.kind === "tab" && target.paneId === subject.paneId) return null;
    if (target.kind === "between" && isNeighbourOf(root, subject.paneId, target)) return null;
    moving = loc.node;
    loc.parent.children[loc.index] = { type: "pane", id: TOMB, weight: moving.weight, tabs: [], active: 0 };
  } else {
    const ft = findTab(root, subject.tabId);
    if (!ft) return null;
    const [tab] = ft.pane.tabs.splice(ft.index, 1);
    if (ft.pane.active >= ft.pane.tabs.length) ft.pane.active = ft.pane.tabs.length - 1;
    if (ft.index < ft.pane.active) ft.pane.active--;
    if (target.kind === "tab") {
      const dest = find(root, target.paneId)?.node;
      if (!dest || dest.type !== "pane") return null;
      let idx = target.index;
      if (dest === ft.pane && (idx === ft.index || idx === ft.index + 1)) return null; // no-op
      if (dest === ft.pane && ft.index < idx) idx--;
      dest.tabs.splice(idx, 0, tab);
      dest.active = idx;
      normalizeForest(root);
      return { paneId: dest.id };
    }
    if (ft.pane.tabs.length === 0) {
      if (target.kind === "side" && target.targetId === ft.pane.id) return null;
      if (target.kind === "between" && isNeighbourOf(root, ft.pane.id, target)) return null;
    }
    moving = { type: "pane", id: genId("p"), weight: 1, tabs: [tab], active: 0 };
  }

  // 2. Insert.
  if (target.kind === "tab") {
    if (moving.type !== "pane") return null; // only a pane's tabs can join a tab bar
    const dest = find(root, target.paneId)?.node;
    if (!dest || dest.type !== "pane") return null;
    dest.tabs.splice(target.index, 0, ...moving.tabs);
    dest.active = target.index + moving.active;
    removeTomb(root);
    return { paneId: dest.id };
  }
  if (target.kind === "between") {
    const split = find(root, target.splitId)?.node;
    if (!split || split.type === "pane") return null;
    // Size to 1/N of the split, N counting the new pane but not what is leaving.
    const staying = split.children.filter(
      (c) => c.id !== TOMB && !(c.type === "pane" && c.tabs.length === 0),
    );
    const total = staying.reduce((s, c) => s + c.weight, 0);
    moving.weight = staying.length ? total / staying.length : 1;
    split.children.splice(target.index, 0, moving);
  } else {
    if (!find(root, target.targetId)) return null;
    insertBeside(root, target.targetId, target.side, moving);
  }

  // 3. Remove tombstone & normalize (empty panes get dropped by normalize).
  removeTomb(root);
  return { paneId: firstPane(moving).id };
}

function firstPane(n: LayoutNode): PaneNode {
  return n.type === "pane" ? n : firstPane(n.children[0]);
}

/** Whether dropping `paneId` at `target` would put it right back where it is. */
function isNeighbourOf(
  root: LayoutNode,
  paneId: string,
  target: { splitId: string; index: number },
): boolean {
  const loc = find(root, paneId);
  return !!loc?.parent && loc.parent.id === target.splitId &&
    (loc.index === target.index || loc.index === target.index - 1);
}

function removeTomb(forest: SplitNode): void {
  const loc = find(forest, TOMB);
  if (loc?.parent) removeAt(loc.parent, loc.index);
  normalizeForest(forest);
}
