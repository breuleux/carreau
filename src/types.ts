// Plain data: everything here is JSON-serializable as-is. Behaviour lives in kinds.ts.

export type Orientation = "row" | "column";
export type Side = "left" | "right" | "top" | "bottom";

/**
 * Split types. Plain splits share their space according to weights; scroll splits let each
 * child take its natural size along the axis and scroll. A "slot" holds a single layout root
 * (a group tab's layout; also, internally, each tree's root). A "forest" (internal only)
 * holds the root slots of several trees, so that operations can span them.
 */
export type SplitType = Orientation | "scroll-row" | "scroll-column" | "slot" | "forest";

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
