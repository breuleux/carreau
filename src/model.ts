// Layout model: construction, serialization, normalization, mutations, drops.
// Data types are in types.ts; per-kind behaviour in kinds.ts; queries in tree.ts.

import { sideAxis, sideIsStart } from "./geometry";
import { canCollapse, isScroll, isSplit, kind, kindOf, mergeKey } from "./kinds";
import { find, findTab, panes, pathTo } from "./tree";
import { canMerge, linkedRuns, newLink, normalizeLinks, trackComplexes } from "./complex";
import { LayoutNode, PaneNode, Side, SplitNode, Tab, WorkspaceData, FloatingWindow } from "./types";

export * from "./types";
export * from "./geometry";
export * from "./kinds";
export * from "./tree";
export * from "./complex";

// ---------------------------------------------------------------------------
// Construction

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

const split = (type: SplitNode["type"], prefix: string) => (children: LayoutNode[], weight = 1): SplitNode => ({
  type,
  id: genId(prefix),
  weight,
  children,
});
export const row = split("row", "r");
export const column = split("column", "c");
export const scrollRow = split("scroll-row", "sr");
export const scrollColumn = split("scroll-column", "sc");

export function slot(child: LayoutNode | null): SplitNode {
  return { type: "slot", id: genId("s"), weight: 1, children: child ? [child] : [] };
}

/** A pane holding a single group tab whose layout is `root`. */
export function groupPane(title: string, root: LayoutNode, weight: number): PaneNode {
  root.weight = 1;
  return {
    type: "pane",
    id: genId("p"),
    weight,
    active: 0,
    tabs: [{ id: genId("t"), title, group: slot(root) }],
  };
}

// ---------------------------------------------------------------------------
// Serialization

export function serialize(data: WorkspaceData | LayoutNode): string {
  return JSON.stringify(data, null, 2);
}

/** Accepts either a bare tree or `{root, floating}`. */
export function deserialize(text: string): WorkspaceData {
  const data = JSON.parse(text);
  if (data && typeof data === "object" && "root" in data) {
    validate(data.root);
    const floating: FloatingWindow[] = Array.isArray(data.floating) ? data.floating : [];
    for (const f of floating) validate(f.root);
    return { root: data.root, floating };
  }
  validate(data);
  return { root: data, floating: [] };
}

function validate(n: any): void {
  if (!n || typeof n !== "object" || typeof n.id !== "string") throw new Error("Invalid node");
  if (typeof n.weight !== "number") n.weight = 1;
  const k = n.type === "forest" ? undefined : kindOf(n.type); // (forests are internal only)
  if (!k) throw new Error(`Unknown node type ${n.type}`);
  if (n.type === "pane") {
    if (!Array.isArray(n.tabs)) throw new Error("Pane without tabs");
    if (n.size !== undefined && !(typeof n.size === "number" && n.size > 0)) throw new Error("A pane's size is a positive number");
    if (n.name !== undefined && (typeof n.name !== "string" || !n.name.trim())) throw new Error("A pane's name is a non-empty string");
    n.active = Math.max(0, Math.min(n.active ?? 0, n.tabs.length - 1));
    for (const t of n.tabs) {
      if (t.group) validate(t.group);
      if (t.link !== undefined && typeof t.link !== "string") throw new Error("A tab's link is a string");
      if (t.key !== undefined && t.key !== null && typeof t.key !== "string") throw new Error("A tab's key is a string or null");
    }
  } else if (!k.leaf) {
    if (!Array.isArray(n.children)) throw new Error("Split without children");
    if (n.type === "slot" && n.children.length !== 1) throw new Error("A slot holds one node");
    if (n.reverse !== undefined && (typeof n.reverse !== "boolean" || !k.scroll)) throw new Error("Only scroll splits reverse");
    if (n.size !== undefined && !(typeof n.size === "number" && n.size > 0)) throw new Error("A split's size is a positive number");
    n.children.forEach(validate);
  }
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}

/**
 * Structure of a layout, ignoring ids: nesting, types, tabs in each pane (merged ones joined
 * by "+"); and, with
 * `withWeights`, the (normalized) weights too.
 */
export function shape(node: LayoutNode, withWeights = false): string {
  const w = withWeights ? `:${node.weight.toFixed(4)}` : "";
  const sub = (n: LayoutNode) => shape(n, withWeights);
  if (node.type === "pane")
    return `[${node.tabs.map((t, i) => (i === 0 ? "" : t.link && t.link === node.tabs[i - 1].link ? "+" : ",") + (t.group ? `${t.id}{${t.group.children.map(sub).join(" ")}}` : t.id)).join("")}]${w}`;
  if (!isSplit(node)) return `${(node as LayoutNode).type}${w}`; // (other leaf types, if any)
  return `${node.type}(${node.children.map(sub).join(" ")})${w}`;
}

// ---------------------------------------------------------------------------
// Normalization

/**
 * Clean up a node, returning what replaces it (null: nothing left).
 *  - panes: group tabs whose layout is gone disappear; a pane with no tabs disappears (unless
 *    it's named: it stays, empty, until closed)
 *  - splits: drop empty children (an empty split goes too, unless it's `keep`); flatten same-type children (and plain same-axis children of
 *    a scroll split); rescale weights to average 1; collapse a single child (not scroll
 *    splits: they could not be recreated by dragging)
 *  - scroll splits always live in a group tab: any that isn't a slot's child gets wrapped
 *  - pinned children go, unless their parent's kind keeps them (`normalizeChildren`)
 */
export function normalize(node: LayoutNode): LayoutNode | null {
  if (node.type === "pane") {
    node.tabs = node.tabs.filter((t, i) => {
      if (!t.group) return true;
      const inner = t.group.children[0] && normalize(t.group.children[0]);
      if (inner) {
        t.group.children = [inner];
        return true;
      }
      if (i < node.active) node.active--;
      return false;
    });
    if (node.tabs.length === 0 && !node.name) return null; // (a named pane stays, empty)
    normalizeLinks(node);
    node.active = Math.max(0, Math.min(node.active, node.tabs.length - 1));
    return node;
  }
  if (!isSplit(node)) return node; // other leaves
  const k = kind(node);
  let kids: LayoutNode[] = [];
  for (const c of node.children) {
    const n = normalize(c);
    if (!n) continue;
    const nk = kind(n);
    const flatten = n.type === node.type || (k.scroll && !nk.scroll && nk.axis === k.axis && isSplit(n));
    if (flatten) {
      const total = (n as SplitNode).children.reduce((s, x) => s + x.weight, 0) || 1;
      for (const x of (n as SplitNode).children) {
        x.weight = (x.weight / total) * n.weight;
        kids.push(x);
      }
    } else {
      kids.push(nk.scroll ? groupPane(scrollTitle(n), n, n.weight) : n);
    }
  }
  kids = k.normalizeChildren ? k.normalizeChildren(node, kids) : kids.filter((x) => !kind(x).pinned);
  node.children = kids;
  if (kids.length === 0) return node.keep ? node : null; // (a kept split stays, empty)
  // Weights are flex-grow factors: summing to less than 1, they'd leave part of the parent
  // empty (after a few half-splitting moves). Rescale to average 1, same ratios.
  const total = kids.reduce((s, x) => s + x.weight, 0);
  if (total > 0) for (const x of kids) x.weight = (x.weight * kids.length) / total;
  if (kids.length === 1 && !k.scroll) {
    kids[0].weight = node.weight;
    return kids[0];
  }
  return node;
}

/** Normalize a tree's root (in a root slot, a scroll split also gets wrapped). */
export function normalizeTree(node: LayoutNode): LayoutNode | null {
  const n = normalize(node);
  return n && isScroll(n) ? groupPane(scrollTitle(n), n, n.weight) : n;
}

function scrollTitle(n: LayoutNode): string {
  return kind(n).groupTitle ?? n.type;
}

// ---------------------------------------------------------------------------
// Forests: operations spanning several trees (the main one, floating windows'...)

/**
 * Run `fn` on a forest holding the given trees, each in a root slot: every node then has a
 * parent, ids are findable across trees, and a tree emptied by the operation is just an
 * empty slot. Afterwards, each tree is normalized; returns the trees (null: emptied).
 */
export function inForest<R>(trees: LayoutNode[], fn: (forest: SplitNode) => R): { trees: (LayoutNode | null)[]; value: R } {
  const forest: SplitNode = { type: "forest", id: "__forest__", weight: 1, children: trees.map(slot) };
  // (Complex types follow what happens to their complexes: see complex.ts.)
  const value = trackComplexes(forest, () => fn(forest));
  const out = (forest.children as SplitNode[]).map((s) => (s.children[0] ? normalizeTree(s.children[0]) : null));
  return { trees: out, value };
}

// ---------------------------------------------------------------------------
// Mutations (in place; normalize afterwards)

/**
 * Insert `node` on a side of the node `targetId` (which must accept it: `kind(n).sides`).
 *  - The target's parent lays out its children along that side's axis: the node becomes a
 *    sibling taking half of the target's space.
 *  - Otherwise the target is wrapped in a new split (in place, through its parent).
 * (On a split along that axis, a drop inserts at its start/end instead: see `applyDropRaw`.)
 */
export function insertBeside(root: LayoutNode, targetId: string, side: Side, node: LayoutNode): void {
  const loc = find(root, targetId);
  if (!loc?.parent) throw new Error(`No node ${targetId} (or no parent)`);
  const axis = sideAxis[side];
  const before = sideIsStart[side];
  const { node: target, parent, index } = loc;
  if (kind(parent).axis === axis) {
    target.weight = node.weight = target.weight / 2;
    (parent as SplitNode).children.splice(before ? index : index + 1, 0, node);
    return;
  }
  const wrapper: SplitNode = {
    type: axis,
    id: genId(axis === "row" ? "r" : "c"),
    weight: target.weight,
    children: before ? [node, target] : [target, node],
  };
  target.weight = node.weight = 1;
  kind(parent).replaceChild(parent, index, wrapper);
}

/** Exchange two disjoint nodes. Weights stay with the positions: the geometry is unchanged. */
export function swapNodes(root: LayoutNode, idA: string, idB: string): void {
  const a = find(root, idA);
  const b = find(root, idB);
  if (!a?.parent || !b?.parent) return;
  if (pathTo(a.node, idB) || pathTo(b.node, idA)) return; // nested: not swappable
  [a.node.weight, b.node.weight] = [b.node.weight, a.node.weight];
  kind(a.parent).replaceChild(a.parent, a.index, b.node);
  kind(b.parent).replaceChild(b.parent, b.index, a.node);
}

/** Replace a node by `by` (in place, through its parent). */
export function replaceNode(root: LayoutNode, id: string, by: LayoutNode): boolean {
  const loc = find(root, id);
  if (!loc?.parent) return false;
  kind(loc.parent).replaceChild(loc.parent, loc.index, by);
  return true;
}

/** Remove a node (in place, through its parent). */
export function removeNode(root: LayoutNode, id: string): boolean {
  const loc = find(root, id);
  if (!loc?.parent) return false;
  kind(loc.parent).removeChild(loc.parent, loc.index);
  return true;
}

/** Collapse a group: replace its holder pane (whose only tab it is) by the group's layout. */
export function collapseGroup(root: LayoutNode, paneId: string): LayoutNode | null {
  const p = find(root, paneId)?.node;
  if (p?.type !== "pane" || !canCollapse(p)) return null;
  const inner = p.tabs[0].group!.children[0];
  inner.weight = p.weight;
  return replaceNode(root, paneId, inner) ? inner : null;
}

// ---------------------------------------------------------------------------
// Drops

export type DropTarget =
  | { kind: "side"; targetId: string; side: Side }
  /**
   * Into a pane's tabs, at `index`. `join`: the link of a complex next to that position, which
   * a dragged tab joins there (it must be able to merge with it). Otherwise it lands there as a
   * plain tab, out of any complex (so not between two members of one). See complex.ts.
   */
  | { kind: "tab"; paneId: string; index: number; join?: string }
  /** Insert as child `index` of split `splitId`, sized to 1/N of the split. */
  | { kind: "between"; splitId: string; index: number }
  /** Exchange contents with a pane: a tab trades places with its active tab; a pane, all tabs. */
  | { kind: "swap"; paneId: string }
  /** Pull the dragged thing out into a floating window (only over its own pane). */
  | { kind: "float"; paneId: string }
  /** Merge the dragged tab with a tab: it joins that tab's complex, just after it (see complex.ts). */
  | { kind: "merge"; tabId: string };

export type DragSubject =
  | { kind: "tab"; tabId: string }
  /** A tab complex, as a block of tabs (by its link): it stays merged wherever it goes. */
  | { kind: "complex"; link: string }
  | { kind: "pane"; paneId: string }
  /** A node in none of the trees (a floating window's tree being docked). */
  | { kind: "external"; node: LayoutNode };

/** Result of a drop: the trees, in the order given (null: emptied). */
export interface ForestResult {
  trees: (LayoutNode | null)[];
  /** the pane that ends up holding the dragged thing */
  paneId: string;
  /** for `float` drops: the pane to show as a new floating window */
  floated?: PaneNode;
}

/**
 * Apply a drop to copies of several trees (`trees[0]` is the main tree, which can't be
 * emptied). Returns null if the drop is invalid or pointless.
 */
export function applyDropForest(trees: LayoutNode[], subject: DragSubject, target: DropTarget): ForestResult | null {
  const { trees: out, value } = inForest(clone(trees), (forest) => applyDropRaw(forest, subject, target));
  if (!value || !out[0]) return null;
  if (value.floated) {
    // Floating a floating window's only pane again would change nothing.
    if (target.kind === "float" && trees.some((t, i) => i > 0 && t.id === target.paneId)) return null;
  } else {
    // Leaving the arrangement as it was (e.g. a lone tab dropped on a border it already
    // occupies) is pointless, even if sizes would change.
    const shapes = (ts: (LayoutNode | null)[]) => ts.map((t) => (t ? shape(t) : "-")).join(";");
    if (shapes(out) === shapes(trees)) return null;
  }
  return { trees: out, ...value };
}

/** Ids of the nodes a drop target refers to. */
function targetIds(t: DropTarget): string[] {
  return t.kind === "side" ? [t.targetId] : t.kind === "between" ? [t.splitId] : t.kind === "merge" ? [] : [t.paneId];
}

/** Whether the target lies in a group carried by the dragged tab, or by the dragged pane. */
function wouldNestInItself(root: LayoutNode, subject: DragSubject, target: DropTarget): boolean {
  let groups: SplitNode[] = [];
  if (subject.kind === "tab" || subject.kind === "complex") {
    groups = (draggedTabs(root, subject)?.tabs ?? []).flatMap((t) => (t.group ? [t.group] : []));
  } else if (subject.kind === "pane") {
    const p = find(root, subject.paneId)?.node;
    if (p?.type === "pane") groups = p.tabs.flatMap((t) => (t.group ? [t.group] : []));
  }
  return groups.some((g) => (target.kind === "merge" ? !!findTab(g, target.tabId) : targetIds(target).some((id) => find(g, id))));
}

const TOMB = "__tombstone__";

/**
 * Dragged tabs just inserted at `i` in a pane's tabs (a tab, or a complex's): they join the
 * complex `join` there (they must be next to it, and able to merge with it); or, without
 * `join`, a lone tab is a plain tab, and a complex stays itself. Either way, not between two
 * members of a complex. Returns whether that's possible.
 */
function placeTabs(p: PaneNode, i: number, tabs: Tab[], join?: string): boolean {
  const [l, r] = [p.tabs[i - 1], p.tabs[i + tabs.length]];
  if (join) {
    const member = l?.link === join ? l : r?.link === join ? r : undefined;
    const key = member && mergeKey(member);
    if (!key || !tabs.every((t) => mergeKey(t) === key)) return false;
    for (const t of tabs) t.link = join;
    return true;
  }
  if (tabs.length === 1) delete tabs[0].link;
  return !(l?.link && l.link === r?.link);
}

/** The tabs a tab or complex subject drags, where they are (a complex: its members' run). */
function draggedTabs(root: LayoutNode, subject: DragSubject): { pane: PaneNode; index: number; tabs: Tab[] } | null {
  if (subject.kind === "tab") {
    const ft = findTab(root, subject.tabId);
    return ft && { pane: ft.pane, index: ft.index, tabs: [ft.pane.tabs[ft.index]] };
  }
  if (subject.kind !== "complex") return null;
  for (const p of panes(root)) for (const run of linkedRuns(p)) if (run.id === subject.link && run.tabs.length > 1) return { pane: p, index: run.start, tabs: run.tabs };
  return null;
}

/**
 * Take dragged tabs out of their pane, which keeps an active tab (the next one, if it was
 * theirs). Returns the index, among them, of the one that was active (else 0).
 */
function detachTabs(d: { pane: PaneNode; index: number; tabs: Tab[] }): number {
  const { pane, index, tabs } = d;
  const a = pane.active;
  const wasActive = Math.max(0, tabs.indexOf(pane.tabs[a]));
  pane.tabs.splice(index, tabs.length);
  if (a >= index + tabs.length) pane.active = a - tabs.length;
  else if (a >= index) pane.active = Math.max(0, Math.min(index, pane.tabs.length - 1));
  return wasActive;
}

/** Works on the forest in place. Returns where the dragged thing went, or null. */
/** Apply a drop in place, to a forest (as `inForest` gives). Null if invalid. */
export function applyDropRaw(root: SplitNode, subject: DragSubject, target: DropTarget): { paneId: string; floated?: PaneNode } | null {
  if (wouldNestInItself(root, subject, target)) return null;
  if (target.kind === "side") {
    const t = find(root, target.targetId)?.node;
    if (!t || !kind(t).sides.includes(target.side)) return null;
    // A side of a split along that side's axis: its start or end, sized 1/N like a separator.
    if (isSplit(t) && kind(t).axis === sideAxis[target.side])
      target = { kind: "between", splitId: t.id, index: sideIsStart[target.side] ? 0 : t.children.length };
  }

  if (target.kind === "merge") {
    // A tab (or a complex's tabs), onto a tab they can merge with: just after it, linked to it.
    const d = draggedTabs(root, subject);
    const dt = findTab(root, target.tabId);
    if (!d || !dt || !d.tabs.every((t) => canMerge(dt.pane, dt.index, t))) return null;
    const onto = dt.pane.tabs[dt.index];
    const wasActive = detachTabs(d);
    const dest = dt.pane;
    onto.link ??= newLink();
    for (const t of d.tabs) t.link = onto.link;
    const at = dest.tabs.indexOf(onto) + 1;
    dest.tabs.splice(at, 0, ...d.tabs);
    dest.active = at + wasActive;
    return { paneId: dest.id };
  }

  if (target.kind === "float") {
    if (subject.kind === "external") return null;
    const p = find(root, target.paneId)?.node;
    if (p?.type !== "pane") return null;
    const d = draggedTabs(root, subject);
    if (subject.kind === "pane" || (d && d.pane === p && d.tabs.length === p.tabs.length)) {
      if (subject.kind === "pane" && subject.paneId !== p.id) return null;
      removeNode(root, p.id);
      return { paneId: p.id, floated: p };
    }
    if (!d || d.pane !== p) return null; // only over its own pane
    const active = detachTabs(d);
    const floated: PaneNode = { type: "pane", id: genId("p"), weight: 1, tabs: d.tabs, active };
    return { paneId: floated.id, floated };
  }

  if (target.kind === "swap") {
    if (subject.kind === "external") return null;
    const dest = find(root, target.paneId)?.node;
    if (dest?.type !== "pane") return null;
    if (subject.kind === "pane") {
      const src = find(root, subject.paneId)?.node;
      if (src?.type !== "pane" || src === dest) return null;
      [src.tabs, dest.tabs] = [dest.tabs, src.tabs];
      [src.active, dest.active] = [dest.active, src.active];
    } else {
      if (subject.kind === "complex") return null; // (a tab trades places with one tab)
      const ft = findTab(root, subject.tabId);
      if (!ft || ft.pane === dest || !dest.tabs.length) return null; // (an empty pane: nothing to trade)
      [dest.tabs[dest.active], ft.pane.tabs[ft.index]] = [ft.pane.tabs[ft.index], dest.tabs[dest.active]];
    }
    return { paneId: dest.id };
  }

  // 1. Detach the subject, leaving a tombstone so that ids along the target path stay valid.
  let moving: LayoutNode;
  if (subject.kind === "external") {
    moving = { ...clone(subject.node), weight: 1 };
  } else if (subject.kind === "pane") {
    const p = find(root, subject.paneId)?.node;
    if (p?.type !== "pane" || targetIds(target).includes(p.id)) return null;
    moving = p;
    replaceNode(root, p.id, { type: "pane", id: TOMB, weight: p.weight, tabs: [], active: 0 });
  } else {
    // A tab, or a complex's tabs: a block.
    const d = draggedTabs(root, subject);
    if (!d) return null;
    const n = d.tabs.length;
    if (target.kind === "tab") {
      const dest = find(root, target.paneId)?.node;
      if (dest?.type !== "pane") return null;
      const own = dest === d.pane;
      if (own && target.index > d.index && target.index < d.index + n) return null; // into itself
      const wasActive = detachTabs(d);
      const idx = own && d.index < target.index ? target.index - n : target.index;
      dest.tabs.splice(idx, 0, ...d.tabs);
      if (!placeTabs(dest, idx, d.tabs, target.join)) return null;
      dest.active = idx + wasActive;
      return { paneId: dest.id };
    }
    const active = detachTabs(d);
    // Its pane, emptied, goes: beside it is where it already is. (Unless the pane is named: it stays.)
    if (d.pane.tabs.length === 0 && !d.pane.name && target.kind === "side" && target.targetId === d.pane.id) return null;
    moving = { type: "pane", id: genId("p"), weight: 1, tabs: d.tabs, active };
  }

  // 2. Insert.
  if (target.kind === "tab") {
    const dest = find(root, target.paneId)?.node;
    if (moving.type !== "pane" || dest?.type !== "pane") return null; // only a pane's tabs join
    // Not into a complex (a pane's tabs don't join one), nor between two of its members.
    const [l, r] = [dest.tabs[target.index - 1], dest.tabs[target.index]];
    if (target.join || (l?.link && l.link === r?.link)) return null;
    dest.tabs.splice(target.index, 0, ...moving.tabs);
    dest.active = target.index + moving.active;
    // A named pane's name goes with its tabs, to a pane that has none. One that has a name
    // keeps it: then the dropped pane stays behind, empty, with its own (it isn't lost).
    if (moving.name && !dest.name) dest.name = moving.name;
    else if (moving.name && subject.kind === "pane") {
      replaceNode(root, TOMB, { type: "pane", id: moving.id, weight: moving.weight, tabs: [], active: 0, name: moving.name });
      return { paneId: dest.id };
    }
    removeNode(root, TOMB);
    return { paneId: dest.id };
  }
  if (target.kind === "between") {
    const s = find(root, target.splitId)?.node;
    if (!s || !isSplit(s)) return null;
    // Nothing goes after a fixed last child: just before it.
    const index = kind(s).lastFixed ? Math.min(target.index, s.children.length - 1) : target.index;
    // 1/N of the split, N counting the new node but not what is leaving.
    const staying = s.children.filter((c) => c.id !== TOMB && !(c.type === "pane" && c.tabs.length === 0 && !c.name));
    moving.weight = staying.length ? staying.reduce((x, c) => x + c.weight, 0) / staying.length : 1;
    s.children.splice(index, 0, moving);
  } else {
    insertBeside(root, target.targetId, target.side, moving);
  }
  // 3. Remove the tombstone (the caller normalizes).
  removeNode(root, TOMB);
  return { paneId: (panes(moving)[0] ?? moving).id };
}
