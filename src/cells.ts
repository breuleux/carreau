// Handles for hosts: a Cell addresses a node of the layout (a pane or a split) by id, and a
// Placer places things relative to the focused cell. The data stays plain; the logic is in
// Workspace (`cellAt`, `place`).

import type { LayoutNode } from "./types";
import type { Path, Placeable, PlaceSpec, Workspace } from "./workspace";

export class Cell {
  constructor(
    readonly ws: Workspace,
    readonly id: string,
  ) {}

  /** The node (null if it is gone). */
  get node(): LayoutNode | null {
    return this.ws.node(this.id);
  }

  /**
   * The cell at a relative location, as the navigation shortcuts would go from this one
   * (without moving the focus); or null. `path`: "left", "right", "up", "down", "parent",
   * "child", an explicit cell, or a sequence of these, e.g. `["parent", "right"]`.
   */
  cellAt(path: Path): Cell | null {
    const id = this.ws.cellAt(this.id, path);
    return id ? new Cell(this.ws, id) : null;
  }
}

export class Placer {
  constructor(
    readonly ws: Workspace,
    readonly spec: PlaceSpec,
  ) {}

  /**
   * Place `what` (a tab or a pane, new or already in the layout; or a new layout) as
   * specified, relative to the focused cell at the time of the call. Returns the cell (pane)
   * holding it, or null if it can't be placed there.
   */
  apply(what: Placeable | Cell): Cell | null {
    const id = this.ws.place(this.spec, what instanceof Cell ? { id: what.id } : what);
    return id ? new Cell(this.ws, id) : null;
  }
}
