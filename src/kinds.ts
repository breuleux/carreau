// Node kinds: what each kind of node knows about itself. The data stays plain (types.ts);
// code asks a node's kind instead of testing types and nesting all over the place.

import { SIDES } from "./geometry";
import { LayoutNode, Orientation, PaneNode, Side, SplitNode, Tab } from "./types";

/**
 * What a node learns from its parent about where it is. Computed top-down: each kind tells
 * its children their context (see `childContext`).
 */
export interface Ctx {
  /** Along which axes the node's size is decided by its content (inside scroll splits). */
  natural: Record<Orientation, boolean>;
  /** The node is sized by its content along this axis, its parent's (no weight, no splitter). */
  sizedAlong: Orientation | null;
  /** The node is a direct child of a scroll split along this axis: one of its "cells". */
  cellOf: Orientation | null;
  /** The node is in a floating window. */
  floating: boolean;
}

export const rootCtx = (floating = false): Ctx => ({
  natural: { row: false, column: false },
  sizedAlong: null,
  cellOf: null,
  floating,
});

/**
 * How the host closes tab contents (ending a process, saving a file...). Only the host knows;
 * nodes gather their tabs' closes through their kinds (`close`, `forceClose`).
 */
export interface Lifecycle {
  /** Close a content tab. Resolves once closed; rejecting refuses the close (the tab stays). */
  closeTab(tab: Tab): Promise<void>;
  /** Close it now, whatever its state. Not waited for. */
  forceCloseTab(tab: Tab): Promise<void>;
  /**
   * The new cell a cell creates (e.g. a shell cell: another shell), when the user inserts one
   * from it (`Workspace.spawn`). Null: it creates none. Default: an empty tab.
   */
  spawn?(from: Tab): Tab | null;
  /**
   * Leaving navigation mode with this cell focused: give it the keyboard focus, if it wants it
   * (e.g. focus the iframe it contains). `content`: its persistent content element (null for
   * a group tab). Default: nothing.
   */
  commitFocus?(tab: Tab, content: HTMLElement | null): void;
}

/** A lifecycle with nothing to wait for. */
export const instantLifecycle: Lifecycle = { closeTab: async () => {}, forceCloseTab: async () => {} };

export interface NodeKind {
  /**
   * Children, by index. For a pane, entry i is tab i's slot (undefined for content tabs), so
   * that indices match tabs.
   */
  children(n: LayoutNode): (LayoutNode | undefined)[];
  /** The axis along which children are laid out (and siblings can be inserted), if any. */
  axis: Orientation | null;
  /** Children size themselves along the axis, and the split scrolls. */
  scroll: boolean;
  /**
   * The sides on which something can be inserted (a `side` drop). Along the node's own axis,
   * that inserts into it as its first or last child; across, beside it (as a sibling, or by
   * wrapping it in a new split). A scroll split only takes insertions along its axis: across,
   * it would be wrapped in a split inside its group, which isn't what the line suggests.
   */
  sides: Side[];
  /** This node is a step when navigating (parent/child). See `isNavStep` for the rule. */
  navStep: boolean;
  /** No children of its own (a pane's are its group tabs' slots): not a split. */
  leaf?: boolean;
  /** It can hold the focus by itself, like a pane: a "cell" for navigation and selection. */
  cell?: boolean;
  /** It stays where it is: never moved, grouped, or kept outside a parent that wants it. */
  pinned?: boolean;
  /** Its last child stays last, and fixed (not scrolling): nothing is inserted after it. */
  lastFixed?: boolean;
  /** A scroll split that always sticks to its end (whatever its `reverse`). */
  alwaysSticky?: boolean;
  /** Title of the group tab holding it, if it must live in one (scroll splits). */
  groupTitle?: string;
  /** The merge key of a group tab whose layout's root is of this kind (see `mergeKey`). */
  mergeKey?: string;
  /**
   * Clicking the group tab whose layout's root it is: the child that takes the focus (the
   * selection, and the keyboard focus through its renderer's `commitFocus`). Default: none
   * (the tab's pane is selected).
   */
  focusChild?(n: LayoutNode): LayoutNode | null;
  /**
   * Normalize its children (already normalized themselves), returning the new list. Default:
   * pinned children go (they only stay where their parent's kind keeps them).
   */
  normalizeChildren?(n: SplitNode, kids: LayoutNode[]): LayoutNode[];
  childContext(n: LayoutNode, ctx: Ctx): Ctx;
  replaceChild(n: LayoutNode, i: number, child: LayoutNode): void;
  removeChild(n: LayoutNode, i: number): void;
  /** Close everything in the node: resolves once all of it is closed (rejects if any refuses). */
  close(n: LayoutNode, life: Lifecycle): Promise<void>;
  /** Close everything in the node now (forcefully). */
  forceClose(n: LayoutNode, life: Lifecycle): Promise<void>;
}

/** Close a tab: a group tab closes its layout, a content tab through the host. */
export function closeTabWith(t: Tab, life: Lifecycle, force = false): Promise<void> {
  if (t.group) return force ? kind(t.group).forceClose(t.group, life) : kind(t.group).close(t.group, life);
  return force ? life.forceCloseTab(t) : life.closeTab(t);
}

const gather = (ps: Promise<void>[]) => Promise.all(ps).then(() => {});

const splitBase = {
  children: (n: LayoutNode) => (n as SplitNode).children,
  close: (n: LayoutNode, life: Lifecycle) => gather((n as SplitNode).children.map((c) => kind(c).close(c, life))),
  forceClose: (n: LayoutNode, life: Lifecycle) => gather((n as SplitNode).children.map((c) => kind(c).forceClose(c, life))),
  replaceChild(n: LayoutNode, i: number, child: LayoutNode) {
    (n as SplitNode).children[i] = child;
  },
  removeChild(n: LayoutNode, i: number) {
    (n as SplitNode).children.splice(i, 1);
  },
};

export function splitKind(axis: Orientation, scroll: boolean): NodeKind {
  return {
    ...splitBase,
    axis,
    scroll,
    groupTitle: scroll ? (axis === "row" ? "Scroll row" : "Scroll column") : undefined,
    sides: scroll ? SIDES.filter((s) => (axis === "row") === (s === "left" || s === "right")) : SIDES,
    navStep: true,
    childContext(_n, ctx) {
      // Children of a scroll split, or of a plain split whose own size along its axis is
      // natural, size themselves along that axis.
      const byContent = scroll || ctx.natural[axis];
      return {
        natural: { ...ctx.natural, [axis]: byContent },
        sizedAlong: byContent ? axis : null,
        cellOf: scroll ? axis : null,
        floating: ctx.floating,
      };
    },
  };
}

/** Holds one layout root. Its child takes the holder's whole place. */
const slot: NodeKind = {
  ...splitBase,
  axis: null,
  scroll: false,
  sides: [],
  navStep: false,
  childContext: (_n, ctx) => ({ ...ctx, sizedAlong: null, cellOf: null }),
  // Removing the root leaves the slot empty (normalization then drops what held it).
};

const pane: NodeKind = {
  // Group tabs' slots, indexed like the tabs.
  children: (n) => (n as PaneNode).tabs.map((t) => t.group),
  axis: null,
  scroll: false,
  sides: SIDES,
  navStep: true,
  leaf: true,
  cell: true,
  // A group's layout fills the holder's body, and inherits its natural-size context (inside
  // a scroll split the holder sizes to its content, so the group's parts must too).
  childContext: (_n, ctx) => ({ ...ctx, sizedAlong: null, cellOf: null }),
  replaceChild(n, i, child) {
    (n as PaneNode).tabs[i].group = child as SplitNode;
  },
  removeChild(n, i) {
    (n as PaneNode).tabs.splice(i, 1);
  },
  close: (n, life) => gather((n as PaneNode).tabs.map((t) => closeTabWith(t, life))),
  forceClose: (n, life) => gather((n as PaneNode).tabs.map((t) => closeTabWith(t, life, true))),
};

/** A leaf that holds nothing and closes instantly: a base for leaf kinds besides panes. */
export const leafKind: NodeKind = {
  children: () => [],
  axis: null,
  scroll: false,
  sides: [],
  navStep: true,
  leaf: true,
  childContext: (_n, ctx) => ctx,
  replaceChild() {},
  removeChild() {},
  close: async () => {},
  forceClose: async () => {},
};

const KINDS: Record<string, NodeKind> = {
  pane,
  row: splitKind("row", false),
  column: splitKind("column", false),
  "scroll-row": splitKind("row", true),
  "scroll-column": splitKind("column", true),
  slot,
  forest: { ...slot }, // holds root slots; never navigated, never inserted into
};

/** Add a node type (see `NodeTypes` and `SplitTypes` in types.ts). */
export function registerKind(type: LayoutNode["type"], k: NodeKind): void {
  KINDS[type] = k;
}

/** The kind of a node type, if it is registered. */
export function kindOf(type: string): NodeKind | undefined {
  return KINDS[type];
}

export function kind(n: LayoutNode): NodeKind {
  const k = KINDS[n.type];
  if (!k) throw new Error(`Unknown node type ${n.type}`);
  return k;
}

export function isScroll(n: LayoutNode): n is SplitNode {
  return kind(n).scroll;
}

/** A node with children of its own (rows, columns, scroll splits, slots): not a leaf. */
export function isSplit(n: LayoutNode): n is SplitNode {
  return !kind(n).leaf;
}

/** A node that can hold the focus by itself (a pane, and leaf kinds that say so). */
export function isCell(n: LayoutNode): boolean {
  return !!kind(n).cell;
}

/** A scroll split that sticks to its end: a sticky (`reverse`) one, or one that always does. */
export function isSticky(n: LayoutNode): boolean {
  return isSplit(n) && (!!n.reverse || !!kind(n).alwaysSticky);
}

// ---------------------------------------------------------------------------
// Panes

/**
 * The index of the tab whose body a pane shows: its active tab's; but in a tab complex (a run
 * of linked tabs, see complex.ts), the complex's first tab's, whichever member is active.
 */
export function shownIndex(p: PaneNode): number {
  let i = p.active;
  const link = p.tabs[i]?.link;
  if (link) while (i > 0 && p.tabs[i - 1].link === link) i--;
  return i;
}

/** The shown group tab's slot, if a pane is showing a group (see `shownIndex`). */
export function activeGroup(p: PaneNode): SplitNode | null {
  return p.tabs[shownIndex(p)]?.group ?? null;
}

/**
 * What a tab can merge with: tabs with the same key (null: nothing). Its own `key` if set;
 * for a group tab, its layout root's kind's `mergeKey`.
 */
export function mergeKey(t: Tab): string | null {
  if (t.key !== undefined) return t.key;
  const root = t.group?.children[0];
  return (root && kind(root).mergeKey) ?? null;
}

/**
 * How a pane displays its tabs, decided by the pane from the context its parent gave it.
 * Panes in scroll splits are "cells": a single tab hides the tab bar (a group tab always
 * shows: it's a container whose name matters), and the active cell's `long` shows on top.
 */
export function paneDisplay(p: PaneNode, ctx: Ctx): { cell: boolean; showTabBar: boolean; showLong: boolean } {
  const cell = ctx.natural.row || ctx.natural.column;
  const showTabBar = !cell || p.tabs.length !== 1 || !!p.tabs[0].group;
  return { cell, showTabBar, showLong: cell };
}

/** A pane whose only tab is a group can collapse into the group's layout (not a scroll split:
 *  those always live in a group tab). */
export function canCollapse(p: PaneNode): boolean {
  const root = p.tabs.length === 1 ? p.tabs[0].group?.children[0] : undefined;
  return !!root && !isScroll(root);
}

export function groupTab(title: string, root: LayoutNode, id: string, slotId: string): Tab {
  return { id, title, group: { type: "slot", id: slotId, weight: 1, children: [root] } };
}
