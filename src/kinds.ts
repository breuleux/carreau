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

function split(axis: Orientation, scroll: boolean): NodeKind {
  return {
    ...splitBase,
    axis,
    scroll,
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

export const KINDS: Record<LayoutNode["type"], NodeKind> = {
  pane,
  row: split("row", false),
  column: split("column", false),
  "scroll-row": split("row", true),
  "scroll-column": split("column", true),
  slot,
  forest: { ...slot }, // holds root slots; never navigated, never inserted into
};

export function kind(n: LayoutNode): NodeKind {
  return KINDS[n.type];
}

export function isScroll(n: LayoutNode): n is SplitNode {
  return kind(n).scroll;
}

// ---------------------------------------------------------------------------
// Panes

/** The active group tab's slot, if a pane is showing a group. */
export function activeGroup(p: PaneNode): SplitNode | null {
  return p.tabs[p.active]?.group ?? null;
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
