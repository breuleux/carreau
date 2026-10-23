// Prompt columns: a column of cells sticking to its bottom, with an input field (the prompt)
// below them, like a terminal or a chat. Self-contained: it plugs into the core through its
// extension points (node types and kinds, operand redirection, tab complexes). No DOM here:
// rendering is in prompt-view.ts, styles in prompt.css. See "Prompt columns" in design.md.

import { complexAt, registerComplex } from "./complex";
import { kind, leafKind, registerKind, splitKind } from "./kinds";
import { genId } from "./model";
import { walk } from "./tree";
import { LayoutNode, PaneNode, SplitNode, Tab } from "./types";
import { Workspace, registerOperand } from "./workspace";

/**
 * The input field of a prompt-column: always its last child, fixed at its bottom. It can be
 * focused (selected), but not moved, closed, or dropped onto. What is typed in it is UI state.
 */
export interface PromptNode {
  type: "prompt";
  id: string;
  weight: number;
}

/** A prompt-column's node: a split, plus what it knows of its cells (for merging). */
export interface PromptColumnNode extends SplitNode {
  type: "prompt-column";
  /** By cell (child) id: see `CellInfo`. Maintained by normalization. */
  cells?: Record<string, CellInfo>;
}

/** What a prompt-column knows of a cell. */
export interface CellInfo {
  /**
   * Its place in the insertion order: merged columns interleave their cells by it. Increasing
   * along the column; a cell moved by hand gets one between its new neighbours'.
   */
  order: number;
  /** The tab holding the column the cell came from: where it goes back when unmerged. */
  origin?: string;
}

declare module "./types" {
  interface NodeTypes {
    prompt: PromptNode;
  }
  interface SplitTypes {
    "prompt-column": true;
  }
}

// ---------------------------------------------------------------------------
// Kinds

/** A cell of its own (it can be focused), pinned: nothing moves it, nothing goes into it. */
registerKind("prompt", { ...leafKind, cell: true, pinned: true });

registerKind("prompt-column", {
  ...splitKind("column", true),
  // Its prompt stays last, below the cells: insertions at its end go just before it.
  lastFixed: true,
  alwaysSticky: true,
  groupTitle: "Prompt",
  // Group tabs holding prompt-columns merge with each other (see "Merging" below).
  mergeKey: "prompt-column",
  // Clicking its tab: into the prompt (typing, right away).
  focusChild: (n) => (n as SplitNode).children.at(-1) ?? null,
  // Exactly one prompt, last (the first one, keeping its id), even with no cells: a
  // prompt-column never disappears for being empty. And the cells' orders.
  normalizeChildren(n, kids) {
    const out = [...kids.filter((x) => !kind(x).pinned), kids.find((x) => x.type === "prompt") ?? promptNode()];
    fixOrders(n as PromptColumnNode, out);
    return out;
  },
});

// ---------------------------------------------------------------------------
// Construction

/** A column of cells sticking to its bottom, with a prompt below them. */
export function promptColumn(children: LayoutNode[], weight = 1): SplitNode {
  return { type: "prompt-column", id: genId("pc"), weight, children: [...children, promptNode()] };
}

export function promptNode(): PromptNode {
  return { type: "prompt", id: genId("q"), weight: 1 };
}

// ---------------------------------------------------------------------------
// The secondary focus: what cell operations act on, from a focused prompt

/** A prompt's secondary focus: the cell just above it (in a split there, its most recently focused cell). */
export function secondaryOf(ws: Workspace, promptId: string): string | null {
  const e = ws.index().get(promptId);
  const col = e?.parent;
  const above = col?.type === "prompt-column" ? col.children[e!.index - 1] : undefined;
  return above ? ws.descend(above) : null;
}

// From a focused prompt, cell operations act on the secondary focus. (Maximizing it also moves
// the focus there: a maximized prompt alone would show nothing.)
registerOperand("prompt", (ws, n) => {
  const id = secondaryOf(ws, n.id);
  return id ? { id } : null;
});

// ---------------------------------------------------------------------------
// Submitting

export interface PromptOptions {
  /** What submitted text becomes: a new cell above the prompt (null: none). Default: a text tab. */
  submit?(text: string): Tab | null;
  /** The field's placeholder. */
  placeholder?: string;
  /**
   * When a merged prompt-column's tab closes, its cells: go to the complex's first tab
   * ("transfer", the default), or close with it ("close").
   */
  mergedClose?: "transfer" | "close";
}

const OPTIONS = new WeakMap<Workspace, PromptOptions>();

/** Set how a workspace's prompts behave (merged with what was set before). */
export function configurePrompts(ws: Workspace, opts: PromptOptions): void {
  OPTIONS.set(ws, { ...OPTIONS.get(ws), ...opts });
}

export function promptOptions(ws: Workspace): PromptOptions {
  return OPTIONS.get(ws) ?? {};
}

/**
 * Submit what was typed in a prompt: it becomes a cell (`PromptOptions.submit`), added just
 * above the prompt, like a drop (undoable). The focus stays where it is. Returns the new pane,
 * or null.
 */
export function submitPrompt(ws: Workspace, promptId: string, text: string): string | null {
  const col = ws.index().parent(promptId);
  if (col?.type !== "prompt-column") return null;
  const { submit } = promptOptions(ws);
  const tab = submit ? submit(text) : { id: genId("t"), title: text.slice(0, 24) || "…", content: text };
  if (!tab) return null;
  const node: PaneNode = { type: "pane", id: genId("p"), weight: 1, tabs: [tab], active: 0 };
  const result = ws.tryDrop({ kind: "external", node }, { kind: "between", splitId: col.id, index: col.children.length - 1 });
  if (!result) return null;
  // Merged: the cell comes from the member typing (the complex's active tab).
  const speaker = speakerOf(ws, promptId);
  const info = speaker && result.trees.flatMap((t) => (t ? [...walk(t)] : [])).find((l) => l.node.id === col.id);
  const cells = info && (info.node as PromptColumnNode).cells;
  if (cells?.[result.paneId]) cells[result.paneId].origin = speaker!.id;
  ws.commitDrop(result, undefined, undefined, false);
  return result.paneId;
}

/**
 * Who types in a prompt: the tab holding its column; merged, the complex's active member
 * (which may hold another column: the first member's shows all the cells).
 */
export function speakerOf(ws: Workspace, promptId: string): Tab | null {
  const idx = ws.index();
  const col = idx.parent(promptId);
  const holder = col && idx.holder(col.id);
  const i = holder ? holder.tabs.findIndex((t) => t.group?.children[0] === col) : -1;
  if (!holder || i < 0) return null;
  const c = complexAt(holder, i);
  return c.active ?? c.tabs[0];
}

// ---------------------------------------------------------------------------
// Merging (tab complexes of prompt-columns' tabs)
//
// Merged, the members' cells all go into the first member's column (the one shown),
// interleaved by insertion order; each remembers where it came from (`origin`). A member that
// leaves takes its cells back; one that closes hands them over to the first member (or closes
// them: `mergedClose`). All of it is one rule, applied after every change of a complex: every
// cell goes to its origin's complex's first member's column (`reconcile`).

registerComplex("prompt-column", {
  changed: (forest) => reconcile(forest),
  closing(_forest, complex, tab, ws) {
    if ((promptOptions(ws).mergedClose ?? "transfer") !== "transfer") return; // it takes its cells along
    const heir = complex.tabs.find((t) => t !== tab);
    if (!heir) return;
    for (const t of complex.tabs) {
      const col = columnOf(t);
      for (const info of Object.values(col?.cells ?? {})) if ((info.origin ?? t.id) === tab.id) info.origin = heir.id;
    }
  },
});

function columnOf(t: Tab): PromptColumnNode | null {
  const root = t.group?.children[0];
  return root?.type === "prompt-column" ? (root as PromptColumnNode) : null;
}

/** Every cell to its origin's complex's first member's column, then each column in order. */
function reconcile(forest: SplitNode): void {
  // The tabs holding prompt-columns, by id, with their complex's first member.
  const holders = new Map<string, { col: PromptColumnNode; first: Tab }>();
  for (const { node } of walk(forest))
    if (node.type === "pane")
      node.tabs.forEach((t, i) => {
        const col = columnOf(t);
        if (col) holders.set(t.id, { col, first: complexAt(node, i).tabs[0] });
      });
  const home = (tabId: string) => holders.get(holders.get(tabId)!.first.id)?.col ?? holders.get(tabId)!.col;
  for (const [id, h] of holders) {
    fixOrders(h.col, h.col.children);
    for (const cell of h.col.children.filter((c) => c.type !== "prompt")) {
      const info = h.col.cells![cell.id];
      // No origin (it has always been here, or was dropped here), or a closed one: the tab
      // holding the column it is in.
      if (!info.origin || !holders.has(info.origin)) info.origin = id;
      const dest = home(info.origin);
      if (dest === h.col) continue;
      h.col.children.splice(h.col.children.indexOf(cell), 1);
      delete h.col.cells![cell.id];
      dest.children.splice(dest.children.length - 1, 0, cell); // (before its prompt)
      (dest.cells ??= {})[cell.id] = info;
    }
  }
  // Interleaved by order (stable: unmoved cells keep their order, which is increasing).
  for (const { col } of holders.values()) {
    const order = (c: LayoutNode) => (c.type === "prompt" ? Infinity : (col.cells?.[c.id]?.order ?? Infinity));
    col.children.sort((a, b) => order(a) - order(b));
  }
}

/**
 * Keep the cells' orders increasing along the column: the most cells keep theirs (a longest
 * increasing subsequence); the others (new, or moved by hand) get orders between their
 * neighbours' (at the end: the insertion time). Forgets cells that left.
 */
function fixOrders(col: PromptColumnNode, kids: LayoutNode[]): void {
  const cells = kids.filter((c) => c.type !== "prompt");
  const old = col.cells ?? {};
  const orders = cells.map((c) => old[c.id]?.order);
  const keep = increasingSubsequence(orders);
  const out: Record<string, CellInfo> = {};
  const now = Date.now();
  let i = 0;
  while (i < cells.length) {
    if (keep.has(i)) {
      out[cells[i].id] = { ...old[cells[i].id] };
      i++;
      continue;
    }
    // A run of cells to give orders to, between the kept ones around it.
    let j = i;
    while (j < cells.length && !keep.has(j)) j++;
    const lo = i > 0 ? out[cells[i - 1].id].order : undefined;
    const hi = j < cells.length ? orders[j]! : undefined;
    const m = j - i;
    for (let k = 0; k < m; k++) {
      const order =
        lo !== undefined && hi !== undefined ? lo + ((hi - lo) * (k + 1)) / (m + 1)
        : hi !== undefined ? hi - (m - k)
        : Math.max((lo ?? -Infinity) + 1 + k, now + k);
      out[cells[i + k].id] = { ...old[cells[i + k].id], order };
    }
    i = j;
  }
  col.cells = out;
}

/** Indices of a longest strictly increasing subsequence of the defined values. */
function increasingSubsequence(xs: (number | undefined)[]): Set<number> {
  const tails: number[] = []; // index of the last element of the best subsequence of each length
  const prev: number[] = [];
  xs.forEach((x, i) => {
    if (x === undefined) return;
    let [a, b] = [0, tails.length];
    while (a < b) {
      const mid = (a + b) >> 1;
      if (xs[tails[mid]]! < x) a = mid + 1;
      else b = mid;
    }
    prev[i] = a > 0 ? tails[a - 1] : -1;
    tails[a] = i;
  });
  const out = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}
