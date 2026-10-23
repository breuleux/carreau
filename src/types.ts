// Plain data: everything here is JSON-serializable as-is. Behaviour lives in kinds.ts.

export type Orientation = "row" | "column";
export type Side = "left" | "right" | "top" | "bottom";

/**
 * Split types. Plain splits share their space according to weights; scroll splits let each
 * child take its natural size along the axis and scroll. A "slot" holds a single layout root
 * (a group tab's layout; also, internally, each tree's root). A "forest" (internal only)
 * holds the root slots of several trees, so that operations can span them.
 *
 * Open: a module can add split types (`declare module "./types" { interface SplitTypes
 * { "my-split": true } }`), and register their kind (`registerKind`).
 */
export interface SplitTypes {
  row: true;
  column: true;
  "scroll-row": true;
  "scroll-column": true;
  slot: true;
  forest: true;
}
export type SplitType = keyof SplitTypes;

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
  /** A group tab holds a whole layout instead of content: a slot holding the layout's root. */
  group?: SplitNode;
  /**
   * What it can merge with: tabs with the same key (null: nothing). Default: for a group tab,
   * its layout root's kind decides (`NodeKind.mergeKey`); otherwise, null. See complex.ts.
   */
  key?: string | null;
  /** Merged tabs: adjacent tabs of a pane with the same link form a tab complex (complex.ts). */
  link?: string;
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
  /**
   * Scroll splits only: stick to the end (bottom / right) instead of the start, like a
   * terminal or a chat. Short content sits at the end; scrolled to the end, it stays there as
   * content grows. The order of the children is unchanged.
   */
  reverse?: boolean;
}

/**
 * Node types, by `type` field. Open, like `SplitTypes`: a module can add leaf node types
 * (`interface NodeTypes { "my-leaf": MyLeafNode }`), with their kind (`registerKind`) and
 * their renderer (`registerRenderer`).
 */
export interface NodeTypes {
  pane: PaneNode;
  split: SplitNode;
}

export type LayoutNode = NodeTypes[keyof NodeTypes];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
