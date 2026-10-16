// Node kinds: what each kind of node knows about itself. The data stays plain (types.ts);
// code asks a node's kind instead of testing types and nesting all over the place.

import { LayoutNode, Orientation, PaneNode, SplitNode, Tab } from "./types";

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
  /** Nodes can be inserted beside this one (not a scroll split: that would look like a split
   *  but just wrap it; nor a slot or forest). */
  acceptsBeside: boolean;
  /** This node is a step when navigating (parent/child). See `isNavStep` for the rule. */
  navStep: boolean;
  childContext(n: LayoutNode, ctx: Ctx): Ctx;
  replaceChild(n: LayoutNode, i: number, child: LayoutNode): void;
  removeChild(n: LayoutNode, i: number): void;
}

const splitBase = {
  children: (n: LayoutNode) => (n as SplitNode).children,
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
    acceptsBeside: !scroll,
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
  acceptsBeside: false,
  navStep: false,
  childContext: (_n, ctx) => ({ ...ctx, sizedAlong: null, cellOf: null }),
  // Removing the root leaves the slot empty (normalization then drops what held it).
};

const pane: NodeKind = {
  // Group tabs' slots, indexed like the tabs.
  children: (n) => (n as PaneNode).tabs.map((t) => t.group),
  axis: null,
  scroll: false,
  acceptsBeside: true,
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
