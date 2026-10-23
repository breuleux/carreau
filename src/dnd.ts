// Drag & drop: what can be dropped where (border lines, tab bar, the hovered pane's zones),
// and the overlay showing it. Relationships come from the LayoutIndex and node kinds.

import { grey } from "./colors";
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
  SIDES,
  Side,
  SplitNode,
  Tab,
  across,
  along,
  canMerge,
  edge,
  linkedRuns,
  opposite,
  findTab,
  inRect,
  intersect,
  isSplit,
  kind,
  paneDisplay,
  panes,
  shape,
  sideAxis,
  sideIsStart,
  slice,
  span,
  union,
  walk,
} from "./model";
import { Workspace } from "./workspace";

/** What the drag code needs from the view. */
export interface DndHost {
  readonly ws: Workspace;
  readonly el: HTMLElement;
  readonly rootEl: HTMLElement;
  readonly floatLayer: HTMLElement;
  readonly overlay: SVGSVGElement;
  elOf(id: string): HTMLElement | null;
  /** a node's rect, in workspace pixels */
  pxRect(id: string): Rect | null;
  /** the part of it that isn't scrolled out of view */
  visRect(id: string): Rect | null;
  /** where a pane floated out of the layout appears */
  floatRect(paneId: string): Rect | null;
}

/** One possible drop. */
export interface Choice {
  target: DropTarget;
  result: ForestResult;
  /** The span of the boundary this choice inserts along (pixel coordinate along the edge). */
  span: [number, number];
  /** For insertions between two siblings: [before, after] node ids. */
  straddle?: [string, string];
  /** For insertions at the start/end of a scroll split: the end child, and which side. */
  edge?: { nodeId: string; side: Side };
  /** An explicit preview (e.g. an empty scroll split's area). */
  rect?: Rect;
}

/** The drop line along one side of the hovered pane. */
/**
 * A separator's line: a gap between two siblings, or a tree's edge. Seen from one side of it
 * (`side`, of the node before the gap; of the tree, at its edge): what's on that side is "near".
 */
export interface SideLine {
  side: Side;
  /** which tree it is in (0: the main one) */
  tree: number;
  /** Its choices on the near side, outermost first: the main one (between two siblings: the
   *  insertion between them), then the near side's nodes' sides. */
  levels: Choice[];
  /** The far side's nodes' sides (mini lines on that side). */
  far: Choice[];
  /** The band occupied by the line, inward from `edge`: [from, to] in pixels. */
  band: [number, number];
  /** Hit area (same convention): at a gap, all of it, and as far into either side. */
  hit: [number, number];
  /** Its extent along the edge (the union of its choices'). */
  span: [number, number];
  /** What line it is: to keep its mini lines. */
  key: string;
  /** the near side's edge coordinate */
  edge: number;
}

interface TabDot {
  /** null when inserting at this position would be a no-op (the dot is not drawn) */
  choice: Choice | null;
  x: number;
  y: number;
  /** Into a complex there (rather than as a plain tab): drawn differently. */
  join?: boolean;
}

/** A tab the dragged tab can merge with: a link icon over it, hit over its middle. */
interface TabLink {
  choice: Choice;
  x: number;
  y: number;
  /** the hit area: [from, to] along the tab bar */
  hit: [number, number];
}

/** The hovered pane's own zones: its edge thirds, and icons in its center. */
interface Zones {
  rect: Rect;
  sides: Partial<Record<Side, Choice>>;
  centers: { kind: "swap" | "float" | "tab" | "link"; choice: Choice; cx: number; cy: number; r: number }[];
}

export interface DragState {
  subject: DragSubject;
  ghost: HTMLElement;
  sourceEl: HTMLElement;
  /** set when docking a floating window */
  win?: FloatingWindow;
  hoverPane: string | null;
  /** All the lines (null: to compute). */
  lines: SideLine[] | null;
  tabBar: { rect: Rect; dots: TabDot[]; links: TabLink[] } | null;
  zones: Zones | null;
  inCenter: boolean;
  near: SideLine | null;
  active: Choice | null;
  /** On a line: its main choice (the line itself), and its mini lines, once popped out. */
  main?: Choice | null;
  minis?: { line: SideLine; main: Choice; items: { choice: Choice; rect: Rect }[] } | null;
  /** Over a scroll split's empty space: the drops there, by where (cached: computing a drop is costly). */
  space: Map<string, Choice | null>;
  lastEvent?: PointerEvent;
}

const SVGNS = "http://www.w3.org/2000/svg";
/** Line thickness; dash length and gap; gap between a border's two halves. */
const LINE = 5;
/** How far inward a line can be hit (more than it's thick: easier to aim at). */
const LINE_HIT = 8;
/** Mini lines (a line's other choices, popped out next to the cursor after a moment). */
const MINI_DELAY = 250;
const MINI_LEN = 44;
const MINI_T = 6;
const MINI_GAP = 3;
/** The arms of the chevrons on a line choice's future parent's corners. */
const CHEVRON = 16;
/** At a complex's edge: how far inside it its join dot is, from the gap's plain dot. */
const JOIN_OFFSET = 7;
/** Center icons' radius; tab link icons' radius. */
const ICON_R = 22;
const LINK_R = 9;
/** In an empty tab bar: how far in its one dot is. */
const EMPTY_DOT = 6;
/** Over a scroll split's empty space: how deep its edge zones (split beside its holder) are. */
const SPACE_ZONE = 0.2;

/** Two chain links, in a 16×16 box (also the view's link icon, between merged tabs). */
export const LINK_PATHS = ["M6.5 9.5l3-3", "M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2", "M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"];
/** After Esc cancels a drag, no drag may restart for this long (ms). */
const ESC_COOLDOWN = 500;

export class DragDrop {
  state: DragState | null = null;
  /** The line the mini lines are about to pop out of (after `MINI_DELAY`; by key), and the timer. */
  private miniLine: string | null = null;
  private miniTimer: ReturnType<typeof setTimeout> | null = null;
  /** The layout's index, during a drag (it doesn't change meanwhile). */
  private index: LayoutIndex | null = null;
  /** No drag may start before this time. */
  private cooldownUntil = 0;

  constructor(private host: DndHost) {}

  private get ws() {
    return this.host.ws;
  }

  /** Esc: cancel, and don't let the still-pressed pointer restart a drag right away. */
  cancel(): void {
    if (!this.state) return;
    this.end(false);
    this.cooldownUntil = performance.now() + ESC_COOLDOWN;
  }

  /** Something scrolled: recompute what's under the cursor. */
  refresh(): void {
    const d = this.state;
    if (d?.lastEvent) {
      d.hoverPane = null;
      d.lines = null;
      d.minis = null;
      this.move(d.lastEvent);
    }
  }

  /** Start tracking a press: becomes a drag after 5px; otherwise a click (selects a pane). */
  arm(e: PointerEvent, subject: DragSubject, label: string, sourceEl: HTMLElement, capturerEl?: HTMLElement): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    // Capture the pointer so that moving over an iframe doesn't swallow the events.
    (capturerEl ?? (e.currentTarget as HTMLElement | null))?.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!this.state && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 5 && performance.now() >= this.cooldownUntil)
        this.start(subject, label, sourceEl);
      if (this.state) this.move(ev);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (this.state) {
        this.move(ev);
        this.end(true);
      } else if (subject.kind === "pane") this.ws.select({ id: subject.paneId });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  start(subject: DragSubject, label: string, sourceEl: HTMLElement, win?: FloatingWindow): void {
    const ghost = document.createElement("div");
    ghost.className = "carreau-ghost";
    ghost.textContent = label;
    if (win) ghost.style.display = "none"; // a docking window follows the cursor itself
    document.body.append(ghost);
    sourceEl.classList.add("carreau-drag-source");
    this.host.el.classList.add("is-dragging");
    this.index = null;
    this.state = { subject, ghost, sourceEl, win, hoverPane: null, lines: null, tabBar: null, zones: null, inCenter: false, near: null, active: null, space: new Map() };
  }

  end(commit: boolean): void {
    const d = this.state;
    if (!d) return;
    this.state = null;
    this.index = null;
    this.waitForMinis(null);
    d.ghost.remove();
    d.sourceEl.classList.remove("carreau-drag-source");
    this.host.el.classList.remove("is-dragging");
    this.host.overlay.replaceChildren();
    if (commit && d.active) {
      const t = d.active.target;
      this.ws.commitDrop(d.active.result, d.win, t.kind === "float" ? (this.host.floatRect(t.paneId) ?? undefined) : undefined);
    }
  }

  private tryDrop(target: DropTarget): ForestResult | null {
    if (this.splitsInCell(target)) return null;
    return this.ws.tryDrop(this.state!.subject, target, this.state!.win);
  }

  /**
   * Whether a drop would split a scroll split's cell, or something inside it, along the scroll
   * split's axis (e.g. stacking a pane above another in a row that is a scroll-column's cell):
   * not offered, as that's no different from inserting before or after the cell, which the
   * scroll split's own insertions (between its cells, at its start and end) offer.
   */
  private splitsInCell(t: DropTarget): boolean {
    const idx = (this.index ??= this.ws.index());
    if (t.kind === "side") {
      const e = idx.get(t.targetId);
      return !!e && e.ctx.inCell === sideAxis[t.side];
    }
    if (t.kind === "between") {
      const e = idx.get(t.splitId);
      return !!e && isSplit(e.node) && e.ctx.inCell !== null && e.ctx.inCell === kind(e.node).axis;
    }
    return false;
  }

  move(ev: PointerEvent): void {
    const d = this.state!;
    const { host } = this;
    d.lastEvent = ev;
    d.ghost.style.left = `${ev.clientX + 12}px`;
    d.ghost.style.top = `${ev.clientY + 8}px`;
    const base = host.el.getBoundingClientRect();
    const px = ev.clientX - base.left;
    const py = ev.clientY - base.top;

    // While mini lines are out, the corridor they span (the line included) is the line's: on a
    // mini line, its choice; elsewhere in it, the line's main choice. (The line, and the
    // hovered pane, stay.)
    if (d.minis && inRect(union(d.minis.items.map((m) => grow(m.rect, MINI_GAP)))!, px, py)) {
      const mini = d.minis.items.find((m) => inRect(grow(m.rect, MINI_GAP / 2), px, py));
      d.near = d.minis.line;
      d.active = mini?.choice ?? d.minis.main;
      d.inCenter = false;
      this.draw();
      return;
    }

    // The lines: every separator of the tree under the cursor (computed once: the layout doesn't
    // change during a drag; scrolling recomputes them). The nearest one under the cursor wins.
    d.lines ??= this.separators();
    const tree = this.treeAt(px, py);
    const onLines = d.lines.filter((l) => l.tree === tree && inLine(l, px, py));
    onLines.sort((a, b) => Math.abs(across(a.side, px, py) - a.edge) - Math.abs(across(b.side, px, py) - b.edge));
    d.near = onLines[0] ?? null;
    d.active = null;
    d.inCenter = false;

    // The pane under the cursor, for its own zones. Over a scroll split's empty space (its
    // scroller, where there's no cell): the pane holding it, whose zones the space replaces.
    let hover: string | null = null;
    let space: HTMLElement | null = null;
    for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
      const inner = (el as HTMLElement).closest?.(".carreau-scroll, .carreau-pane") as HTMLElement | null;
      if (inner?.classList.contains("carreau-scroll") && host.el.contains(inner)) {
        space = inner;
        break;
      }
      const p = (el as HTMLElement).closest?.(".carreau-pane") as HTMLElement | null;
      if (p && (host.rootEl.contains(p) || host.floatLayer.contains(p))) {
        // The gaps between a group's parts show its holder's body: a gap, not the holder.
        const body = (el as HTMLElement).closest(".carreau-body");
        if (body?.parentElement === p && body.classList.contains("shows-group")) break;
        hover = p.dataset.id!;
        break;
      }
    }
    if (space) hover = this.ws.index().holder(space.dataset.scroll ?? space.dataset.id!)?.id ?? null;
    if (hover !== d.hoverPane) {
      d.hoverPane = hover;
      d.tabBar = hover ? this.tabBar(hover) : null;
      d.zones = hover ? this.zones(this.ws.index(), hover) : null;
    }

    // Priority: the line under the cursor (its main choice: the outermost one there; the others
    // pop out as mini lines), then the tab bar (nearest gap), then the empty space, then the
    // pane's own zones.
    if (d.near) d.active = d.main = mainChoice(d.near, along(d.near.side, px, py));
    else if (d.tabBar && inRect(d.tabBar.rect, px, py)) {
      // Over the middle of a tab it can merge with: merge; elsewhere, the nearest gap.
      const link = d.tabBar.links.find((l) => px >= l.hit[0] && px <= l.hit[1]);
      const nearest = d.tabBar.dots.reduce<TabDot | null>((a, b) => (!a || Math.abs(b.x - px) < Math.abs(a.x - px) ? b : a), null);
      d.active = link?.choice ?? nearest?.choice ?? null; // nothing if the nearest gap is a no-op
    } else if (space) {
      d.active = this.spaceChoice(space, px, py);
    } else if (d.zones && inRect(d.zones.rect, px, py)) {
      const Z = d.zones;
      const fx = (px - Z.rect.x) / Z.rect.w;
      const fy = (py - Z.rect.y) / Z.rect.h;
      const thirds: [Side, number][] = (
        [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]] as [Side, number][]
      ).filter(([, f]) => f < 1 / 3);
      if (thirds.length) {
        thirds.sort((a, b) => a[1] - b[1]);
        d.active = Z.sides[thirds[0][0]] ?? null;
      } else {
        d.inCenter = true;
        d.active = Z.centers.find((c) => Math.hypot(px - c.cx, py - c.cy) <= c.r)?.choice ?? null;
      }
    }
    // Mini lines: they pop out after the cursor stays on a line for a moment; they go when it
    // leaves the line (and them).
    if (!d.near || (d.minis && d.minis.line.key !== d.near.key)) d.minis = null;
    this.waitForMinis(d.near && d.near.levels.length + d.near.far.length > 1 ? d.near.key : null);
    this.draw();
  }

  /** (Re)start the wait before a line's mini lines pop out (by key; null: none to wait for). */
  private waitForMinis(line: string | null): void {
    if (line === this.miniLine) return;
    if (this.miniTimer) clearTimeout(this.miniTimer);
    this.miniTimer = null;
    this.miniLine = line;
    if (line) this.miniTimer = setTimeout(() => this.popMinis(), MINI_DELAY);
  }

  /**
   * Pop out the mini lines of the line the cursor is on: its other choices there, each a short
   * line parallel to it, next to the cursor, on the side of what it would split (a gap's far
   * side's choices on the far side), the most local ones nearest the line. They stay where they
   * popped out, so that the cursor can go to them.
   */
  private popMinis(): void {
    const d = this.state;
    const line = d?.near;
    this.miniTimer = null;
    if (!d?.lastEvent || !line || line.key !== this.miniLine || !d.main || d.minis) return;
    const base = this.host.el.getBoundingClientRect();
    const v = along(line.side, d.lastEvent.clientX - base.left, d.lastEvent.clientY - base.top);
    const covers = (c: Choice) => c.span[0] - 1 <= v && v <= c.span[1] + 1;
    // Evenly spaced from the line (the same gap from it to the first as between them; while
    // they're out, the corridor they span is the line's, so the cursor can't fall off between).
    const [inner, outer] = [line.band[1], line.band[0]];
    const stretch: [number, number] = [v - MINI_LEN / 2, v + MINI_LEN / 2];
    const step = MINI_T + MINI_GAP;
    // The widest splits nearest the line.
    const widest = (a: Choice, b: Choice) => b.span[1] - b.span[0] - (a.span[1] - a.span[0]);
    const near = line.levels.filter((c) => c !== d.main && covers(c)).sort(widest);
    const far = line.far.filter(covers).sort(widest);
    const items = [
      ...near.map((choice, i) => ({ choice, rect: bandAt(line, inner + MINI_GAP + i * step, inner + MINI_GAP + i * step + MINI_T, stretch) })),
      ...far.map((choice, i) => ({ choice, rect: bandAt(line, outer - MINI_GAP - i * step - MINI_T, outer - MINI_GAP - i * step, stretch) })),
    ];
    if (!items.length) return;
    d.minis = { line, main: d.main, items };
    this.draw();
  }

  // -------------------------------------------------------------------------
  // Choices

  /** Tab bar dots: before the first tab, between tabs, after the last (ends pinned in view). */
  private tabBar(paneId: string): DragState["tabBar"] {
    const { host } = this;
    const paneEl = host.elOf(paneId)!;
    const bar = paneEl.querySelector<HTMLElement>(":scope > .carreau-tabbar")!;
    const b = host.el.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const visible = host.visRect(paneId);
    const rect = visible && intersect({ x: br.left - b.left, y: br.top - b.top, w: br.width, h: br.height }, visible);
    if (!rect) return null; // hidden or scrolled out
    const rs = [...bar.querySelectorAll<HTMLElement>(".carreau-tab")].map((t) => t.getBoundingClientRect());
    // Gaps: before the first tab, between tabs (mid-way: merged tabs have a link icon between
    // them), after the last.
    const n = rs.length;
    const sr = bar.querySelector<HTMLElement>(".carreau-tabs")!.getBoundingClientRect();
    const lo = Math.max(sr.left, rect.x + b.left) + 3;
    // (No tabs: the tabs' scroller is empty, zero-wide; the one dot goes at its start, where
    // the first tab would be, and must not count as scrolled out.)
    const hi = n ? Math.min(sr.right, rect.x + rect.w + b.left) - 3 : lo + EMPTY_DOT;
    const xs = n ? Array.from({ length: n + 1 }, (_, i) => (i === 0 ? rs[0].left : i === n ? rs[n - 1].right : (rs[i - 1].right + rs[i].left) / 2)) : [lo + EMPTY_DOT];
    const pane = this.ws.node(paneId) as PaneNode;
    const dragged = this.draggedTabs();
    const dots: TabDot[] = [];
    xs.forEach((x, index) => {
      const cx = index === 0 ? Math.max(x, lo) : index === xs.length - 1 ? Math.min(x, hi) : x;
      if (cx < lo - 4 || cx > hi + 4) return; // scrolled out
      // Between two merged tabs: into their complex (reordering, or joining it). Elsewhere: a
      // plain tab there (out of any complex), and next to a complex, a dot just inside it, to
      // be at its edge, in it.
      const [before, after] = [pane.tabs[index - 1], pane.tabs[index]];
      const inside = before?.link && before.link === after?.link;
      const variants: [string | undefined, number][] = inside
        ? [[before.link, cx]]
        : [[undefined, cx], ...(before?.link ? [[before.link, cx - JOIN_OFFSET] as [string, number]] : []), ...(after?.link ? [[after.link, cx + JOIN_OFFSET] as [string, number]] : [])];
      for (const [join, vx] of variants) {
        const target: DropTarget = { kind: "tab", paneId, index, ...(join ? { join } : {}) };
        const result = this.tryDrop(target);
        dots.push({ choice: result && { target, result, span: [vx, vx] }, x: vx - b.left, y: br.top + br.height / 2 - b.top, join: !!join });
      }
    });
    const links: TabLink[] = [];
    if (dragged)
      rs.forEach((r, i) => {
        const cx = (r.left + r.right) / 2;
        if (cx < lo || cx > hi || !dragged.tabs.every((t) => canMerge(pane, i, t))) return;
        const target: DropTarget = { kind: "merge", tabId: pane.tabs[i].id };
        const result = this.tryDrop(target);
        const quarter = (r.right - r.left) / 4;
        if (result) links.push({ choice: { target, result, span: [cx, cx] }, x: cx - b.left, y: br.top + br.height / 2 - b.top, hit: [cx - quarter - b.left, cx + quarter - b.left] });
      });
    return { rect, dots, links };
  }

  /**
   * Over a scroll split's empty space. Near its edges (`SPACE_ZONE` of it, on each side, where
   * that is empty space: cells there take their own drops): split beside the pane holding it;
   * not at the end where a fixed last child is (a prompt column's prompt). Elsewhere: insert
   * into it where the cursor is along its axis (an empty one: as its first cell; else,
   * before the first cell whose middle is past the cursor).
   */
  private spaceChoice(scroller: HTMLElement, px: number, py: number): Choice | null {
    const d = this.state!;
    const { host } = this;
    const id = scroller.dataset.scroll ?? scroller.dataset.id!;
    const n = this.ws.node(id);
    if (!n || !isSplit(n)) return null;
    const k = kind(n);
    const kids = k.lastFixed ? n.children.slice(0, -1) : n.children;
    const row = k.axis === "row";
    const b = host.el.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    const S = { x: sr.left - b.left, y: sr.top - b.top, w: sr.width, h: sr.height };
    const zone = this.spaceZone(n, S, px, py);
    if (zone) return zone;
    const index = kids.filter((c) => {
      const r = host.pxRect(c.id);
      return r && (row ? px > r.x + r.w / 2 : py > r.y + r.h / 2);
    }).length;
    const key = `${id}:${index}`;
    if (d.space.has(key)) return d.space.get(key)!;
    const target: DropTarget = { kind: "between", splitId: id, index };
    const result = this.tryDrop(target);
    let choice: Choice | null = null;
    if (result) {
      const [start, end]: Side[] = row ? ["left", "right"] : ["top", "bottom"];
      // The preview: the empty area; or, at an end, the end cell's edge; between two, the straddle.
      choice =
        kids.length === 0 ? { target, result, span: [0, 0], rect: S }
        : index === 0 ? { target, result, span: [0, 0], edge: { nodeId: kids[0].id, side: start } }
        : index === kids.length ? { target, result, span: [0, 0], edge: { nodeId: kids[index - 1].id, side: end } }
        : { target, result, span: [0, 0], straddle: [kids[index - 1].id, kids[index].id] };
    }
    d.space.set(key, choice);
    return choice;
  }

  /**
   * The edge zone of a scroll split's empty space (rect `S`) under the cursor, if any: a split
   * beside the pane holding it (as its edge third would, were it hovered). Null: not in one,
   * or nothing to drop there (the space's own insertion then applies).
   */
  private spaceZone(n: SplitNode, S: Rect, px: number, py: number): Choice | null {
    const d = this.state!;
    const idx = (this.index ??= this.ws.index());
    const holder = idx.holder(n.id);
    const e = holder && idx.get(holder.id);
    if (!e) return null;
    const k = kind(n);
    // (The end where a fixed last child sits: a split there would be hard to aim at, next to it.)
    const fixedEnd: Side | null = k.lastFixed ? (k.axis === "row" ? "right" : "bottom") : null;
    const fx = (px - S.x) / S.w;
    const fy = (py - S.y) / S.h;
    const near = ([["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]] as [Side, number][])
      .filter(([side, f]) => f < SPACE_ZONE && side !== fixedEnd)
      .sort((a, b) => a[1] - b[1]);
    for (const [side] of near) {
      const key = `${n.id}:${side}`;
      if (!d.space.has(key)) d.space.set(key, this.zoneSide(e, side));
      const choice = d.space.get(key)!;
      if (choice) return choice;
    }
    return null;
  }

  /** The dragged tabs, and their pane: a tab, or a complex's tabs. */
  private draggedTabs(): { pane: PaneNode; tabs: Tab[] } | null {
    const s = this.state!.subject;
    if (s.kind === "tab") {
      const ft = this.ws.trees().map((t) => findTab(t, s.tabId)).find(Boolean);
      return ft ? { pane: ft.pane, tabs: [ft.pane.tabs[ft.index]] } : null;
    }
    if (s.kind !== "complex") return null;
    for (const p of this.ws.trees().flatMap((t) => panes(t))) for (const run of linkedRuns(p)) if (run.id === s.link) return { pane: p, tabs: run.tabs };
    return null;
  }

  /** The pane's own zones: edge thirds (insert beside it), and center icons. */
  private zones(idx: LayoutIndex, paneId: string): Zones | null {
    const rect = this.host.visRect(paneId);
    const e = idx.get(paneId);
    if (!rect || !e) return null;
    const pane = e.node as PaneNode;
    const choice = (target: DropTarget): Choice | null => {
      const result = this.tryDrop(target);
      return result && { target, result, span: [0, 0] };
    };
    const sides: Zones["sides"] = {};
    for (const side of SIDES) sides[side] = this.zoneSide(e, side) ?? undefined;
    // Center icons. Over its own pane: float the dragged thing. Elsewhere: swap, plus a tab
    // icon for a pane whose tab bar is hidden (no dots to drop on).
    const s = this.state!.subject;
    const st = this.draggedTabs();
    const own = (s.kind === "pane" && s.paneId === paneId) || st?.pane === pane;
    const wanted: [Zones["centers"][number]["kind"], DropTarget][] = own
      ? [["float", { kind: "float", paneId }]]
      : [
          ["swap", { kind: "swap", paneId }],
          // (Also for an empty pane: into it.)
          ...(paneDisplay(pane, e.ctx).showTabBar && pane.tabs.length ? [] : [["tab", { kind: "tab", paneId, index: pane.tabs.length }] as [Zones["centers"][number]["kind"], DropTarget]]),
          // Merge with its active tab, if the dragged tab can.
          ...(st && st.tabs.every((t) => canMerge(pane, pane.active, t)) ? [["link", { kind: "merge", tabId: pane.tabs[pane.active].id }] as [Zones["centers"][number]["kind"], DropTarget]] : []),
        ];
    const valid = wanted.flatMap(([k, t]) => {
      const c = choice(t);
      return c ? [{ kind: k, choice: c }] : [];
    });
    const step = ICON_R * 2 + 12;
    const x0 = rect.x + rect.w / 2 - ((valid.length - 1) * step) / 2;
    const centers = valid.map((v, i) => ({ ...v, cx: x0 + i * step, cy: rect.y + rect.h / 2, r: ICON_R }));
    return { rect, sides, centers };
  }

  /** A pane's edge third: insert beside it. Not for a scroll split's cell along the split's
   *  axis: that would look like a split, but isn't; only the lines apply there. */
  private zoneSide(e: Entry, side: Side): Choice | null {
    if (e.ctx.cellOf === sideAxis[side]) return null;
    const target: DropTarget = { kind: "side", targetId: e.node.id, side };
    const result = this.tryDrop(target);
    return result && { target, result, span: [0, 0] };
  }

  /** How much of a node a `side` drop on it takes: half, or 1/N at a split's start/end. */
  private sideShare(id: string, side: Side): number {
    const n = this.ws.node(id);
    if (!n || !isSplit(n) || kind(n).axis !== sideAxis[side]) return 1 / 2;
    const s = this.state!.subject;
    const staying = n.children.filter((c) => !(s.kind === "pane" && c.id === s.paneId)).length;
    return 1 / (staying + 1);
  }

  /** Which tree is under the cursor: the frontmost window there (not one being docked), else the main one. */
  private treeAt(px: number, py: number): number {
    const wins = this.ws.floating;
    for (let i = wins.length - 1; i >= 0; i--) if (wins[i] !== this.state!.win && inRect(wins[i].rect, px, py)) return i + 1;
    return 0;
  }

  /**
   * The lines: one per separator, i.e. every gap between two siblings of a split, every edge
   * of a tree (the workspace's, a window's), and a scroll split's ends where they aren't its
   * pane's edges (its tab bar is there). Each has one main choice (the insertion between the
   * siblings; at an edge, beside what ends there), and as mini lines, the nodes whose border
   * lies on it (each on its own side of the line: see `borderChoices`). A line whose main
   * choice another one already has isn't added.
   */
  private separators(): SideLine[] {
    const { host } = this;
    const idx = (this.index ??= this.ws.index());
    const out: SideLine[] = [];
    idx.trees.forEach((root, tree) => {
      if (tree > 0 && this.ws.floating[tree - 1] === this.state!.win) return;
      // A tree's edges.
      const R = host.visRect(root.id);
      if (R)
        for (const side of SIDES) {
          const levels = this.borderChoices(root, side);
          if (levels.length) out.push({ side, tree, levels, far: [], band: [0, LINE], hit: [0, LINE_HIT], key: `e:${tree}:${side}`, edge: edge(R, side), span: lineSpan(levels) });
        }
      // Gaps between siblings, as seen from the one before (its end side).
      for (const { node: S } of walk(root)) {
        const axis = kind(S).axis;
        if (!axis) continue;
        const kids = (S as SplitNode).children;
        const side: Side = axis === "row" ? "right" : "bottom";
        const V = host.visRect(S.id);
        for (let i = 0; i + 1 < kids.length; i++) {
          const [a, b] = [host.pxRect(kids[i].id), host.pxRect(kids[i + 1].id)];
          if (!a || !b || !V) continue;
          const aEnd = edge(a, side);
          const bStart = edge(b, opposite[side]);
          const mid = (aEnd + bStart) / 2;
          // (Scrolled out of view: no line.)
          if (mid < edge(V, opposite[side]) - 1 || mid > edge(V, side) + 1) continue;
          const target: DropTarget = { kind: "between", splitId: S.id, index: i + 1 };
          const result = this.tryDrop(target);
          const between: Choice[] = result ? [{ target, result, span: span(V, side), straddle: [kids[i].id, kids[i + 1].id] }] : [];
          // Each side's own choices, without what the gap's insertion already does.
          const seen = new Set(between.map((c) => resultKey(c.result)));
          const near = this.borderChoices(kids[i], side, seen);
          const far = this.borderChoices(kids[i + 1], opposite[side], seen);
          // (Nothing between them: the near side's choices are the line's, or else the far side's.)
          const levels = [...between, ...near];
          const [lv, fr] = levels.length ? [levels, far] : [far, []];
          if (!lv.length) continue;
          // One line, centered on the gap; its hit area reaches as far into either side.
          const m = aEnd - mid; // (inward from aEnd: toward the node before)
          out.push({
            side, tree, levels: lv, far: fr, band: [m - LINE / 2, m + LINE / 2],
            hit: [Math.min(m - LINE_HIT, aEnd - bStart), m + LINE_HIT],
            key: `b:${S.id}:${i + 1}`, edge: aEnd, span: lineSpan([...lv, ...fr]),
          });
        }
      }
      // A scroll split's ends, inside it, where its pane's edge isn't.
      for (const { node: S } of walk(root)) {
        const k = kind(S);
        const holder = k.scroll && idx.holder(S.id);
        const [r, h] = holder ? [host.visRect(S.id), host.pxRect(holder.id)] : [null, null];
        if (!r || !h) continue;
        for (const side of SIDES) {
          if (sideAxis[side] !== k.axis || Math.abs(edge(r, side) - edge(h, side)) <= 1.5) continue;
          const levels = this.borderChoices(S, side);
          if (levels.length) out.push({ side, tree, levels, far: [], band: [0, LINE], hit: [0, LINE_HIT], key: `s:${S.id}:${side}`, edge: edge(r, side), span: lineSpan(levels) });
        }
      }
    });
    const mains = new Set<string>();
    return out.filter((l) => {
      const key = resultKey(l.levels[0].result);
      return !mains.has(key) && !!mains.add(key);
    });
  }

  /**
   * The insertions on a side of a node and of everything inside it whose border lies on the
   * same line (within 1.5px), outermost first: each node there whose kind takes that side.
   * Results already in `seen` (the same layout, sizes included) are left out, and added.
   */
  private borderChoices(x: LayoutNode, side: Side, seen = new Set<string>()): Choice[] {
    const { host } = this;
    const at = host.pxRect(x.id);
    if (!at) return [];
    const line = edge(at, side);
    const out: Choice[] = [];
    const visit = (n: LayoutNode) => {
      const r = host.pxRect(n.id);
      // (A node with no element of its own, such as a group tab's slot: look inside.)
      if (r && Math.abs(edge(r, side) - line) > 1.5) return;
      const vis = r && host.visRect(n.id);
      if (vis && kind(n).sides.includes(side)) {
        const target: DropTarget = { kind: "side", targetId: n.id, side };
        const result = this.tryDrop(target);
        if (result && !seen.has(resultKey(result))) {
          seen.add(resultKey(result));
          // Into a scroll split at its start/end: previewed on its end child.
          const k = kind(n);
          const kids = (n as SplitNode).children;
          const endChild = k.scroll && k.axis === sideAxis[side] ? kids[sideIsStart[side] ? 0 : kids.length - 1] : null;
          out.push({ target, result, span: span(vis, side), ...(endChild ? { edge: { nodeId: endChild.id, side } } : {}) });
        }
      }
      for (const c of kind(n).children(n)) if (c) visit(c);
    };
    visit(x);
    return out;
  }

  // -------------------------------------------------------------------------
  // Overlay

  private draw(): void {
    const d = this.state!;
    const { host } = this;
    const svg = host.overlay;
    svg.replaceChildren();
    if (!d.hoverPane && !d.active) return;
    const mk = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs))
        // Colors go through CSS (presentation attributes don't take light-dark()).
        if (k === "fill" || k === "stroke" || k === "stop-color") (e as SVGElement).style.setProperty(k, String(v));
        else e.setAttribute(k, String(v));
      parent.append(e);
      return e;
    };
    // The chain links icon, `size` pixels wide, centered.
    const chain = (g: Element, cx: number, cy: number, size: number) => {
      const icon = mk("g", { transform: `translate(${cx - size / 2} ${cy - size / 2}) scale(${size / 16})` }, g);
      for (const path of LINK_PATHS) mk("path", { d: path, stroke: "#111", "stroke-width": 2, fill: "none", "stroke-linecap": "round" }, icon);
    };
    const outline = (r: Rect | null) =>
      r && mk("rect", { x: r.x + 3, y: r.y + 3, width: Math.max(0, r.w - 6), height: Math.max(0, r.h - 6), rx: 6, class: "carreau-preview" });

    // Preview, aligned with the current geometry, clipped to what's visible.
    const c = d.active;
    if (c) {
      const t = c.target;
      const visible = (id: string, r: Rect | null) => {
        const v = host.visRect(id);
        return r && v ? intersect(r, v) : null;
      };
      if (c.rect) outline(c.rect);
      else if (c.edge) outline(visible(targetIdOf(t), slice(host.pxRect(c.edge.nodeId)!, c.edge.side, 1 / 3)));
      else if (t.kind === "side") outline(visible(t.targetId, slice(host.pxRect(t.targetId)!, t.side, this.sideShare(t.targetId, t.side))));
      else if (t.kind === "float") outline(host.floatRect(t.paneId));
      else if (t.kind === "swap") {
        // Both panes that trade contents.
        const s = d.subject;
        const src = s.kind === "pane" ? s.paneId : s.kind === "tab" ? this.ws.trees().map((tr) => findTab(tr, s.tabId)).find(Boolean)?.pane.id : undefined;
        for (const id of [t.paneId, src]) if (id) outline(host.visRect(id));
      } else if (t.kind === "merge") {
        // The pane the merged tab joins.
        const ft = this.ws.trees().map((tr) => findTab(tr, t.tabId)).find(Boolean);
        if (ft) outline(host.visRect(ft.pane.id));
      } else if (t.kind === "tab") {
        // Into a tab bar: the highlighted dot is the preview; into a pane with no tab bar
        // (the center tab icon): outline the pane.
        if (d.zones?.centers.some((z) => z.choice === c)) outline(host.visRect(t.paneId));
      } else if (c.straddle) {
        // Last third of the node before, first third of the one after.
        const [a, b] = c.straddle.map((id) => host.pxRect(id)!);
        const axisRow = a.x + a.w <= b.x + 0.5;
        const r = axisRow ? { x: a.x + (a.w * 2) / 3, y: a.y, w: b.x + b.w / 3 - (a.x + (a.w * 2) / 3), h: a.h } : { x: a.x, y: a.y + (a.h * 2) / 3, w: a.w, h: b.y + b.h / 3 - (a.y + (a.h * 2) / 3) };
        outline(visible(t.splitId, r));
      }
    }

    // Center icons, in the center third of a pane.
    for (const { cx, cy, r, choice, kind: k } of d.inCenter ? (d.zones?.centers ?? []) : []) {
      const active = d.active === choice;
      const g = mk("g", { class: "carreau-indicator carreau-swap" + (active ? " active" : "") });
      mk("circle", { cx, cy, r: active ? r + 3 : r, fill: grey(active ? 0.86 : 0.7, active ? 0.95 : 0.75), stroke: "#0009", "stroke-width": 1 }, g);
      if (k === "float") {
        // A cloud: overlapping circles over a flat base.
        for (const [x, y, rr] of [[-6, 2, 5.5], [1, -3, 7.5], [8, 2, 5.5]] as const) mk("circle", { cx: cx + x, cy: cy + y, r: rr, fill: "#111" }, g);
        mk("rect", { x: cx - 6, y: cy + 2, width: 14, height: 5.5, fill: "#111" }, g);
      } else if (k === "link") {
        chain(g, cx, cy, 24);
      } else if (k === "tab") {
        // A tab: a raised tab over a body.
        mk("path", { d: `M ${cx - 10} ${cy + 8} V ${cy - 4} H ${cx - 6} V ${cy - 8} H ${cx + 2} V ${cy - 4} H ${cx + 10} V ${cy + 8} Z`, stroke: "#111", "stroke-width": 2.2, fill: "none", "stroke-linejoin": "round" }, g);
      } else {
        // Two opposed arrows.
        const a = r * 0.5;
        const arrow = (y: number, dir: 1 | -1) =>
          `M ${cx - dir * a} ${y} L ${cx + dir * a} ${y} M ${cx + dir * a - dir * 6} ${y - 5} L ${cx + dir * a} ${y} L ${cx + dir * a - dir * 6} ${y + 5}`;
        mk("path", { d: `${arrow(cy - 6, 1)} ${arrow(cy + 6, -1)}`, stroke: "#111", "stroke-width": 2.5, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
      }
    }

    // Tab insertion dots.
    for (const dot of d.tabBar?.dots ?? []) {
      if (!dot.choice) continue;
      const active = d.active === dot.choice;
      // Into a complex: a ring (like a link), rather than a plain dot.
      if (dot.join) mk("circle", { cx: dot.x, cy: dot.y, r: active ? 5 : 3.5, fill: grey(0.98, active ? 1 : 0.85), stroke: "#000c", "stroke-width": active ? 2.5 : 2, class: "carreau-indicator carreau-dot join" + (active ? " active" : "") });
      else mk("circle", { cx: dot.x, cy: dot.y, r: active ? 5.5 : 3.5, fill: grey(active ? 0.92 : 0.7, active ? 1 : 0.8), stroke: "#0008", "stroke-width": 1, class: "carreau-indicator carreau-dot" + (active ? " active" : "") });
    }

    // Tabs it can merge with: a link icon over each.
    for (const link of d.tabBar?.links ?? []) {
      const active = d.active === link.choice;
      const g = mk("g", { class: "carreau-indicator carreau-link" + (active ? " active" : "") });
      mk("circle", { cx: link.x, cy: link.y, r: active ? LINK_R + 2 : LINK_R, fill: grey(active ? 0.92 : 0.72, active ? 1 : 0.85), stroke: "#0008", "stroke-width": 1 }, g);
      chain(g, link.x, link.y, active ? 13 : 11);
    }

    // The line along the nearest border, on the cursor's side: its main choice, solid; and on
    // the far half of the gap, the insertion between the siblings, which is the same from
    // either side (the halves touch in the middle). Its other choices: mini lines.
    if (!d.near) return;
    const line = d.near;
    const isActive = (c: Choice) => c === d.active;
    const all = [...line.levels, ...line.far];
    // White and grey only: a choice is white (outlined, darker and thicker when it's the
    // active one); what a mini line's choice doesn't cover, grey.
    const WHITE = "#fff";
    const GREY = grey(0.66);
    const edged = (c: Choice) => ({ stroke: isActive(c) ? grey(0.15) : grey(0.4), "stroke-width": isActive(c) ? 1.5 : 1 });
    const [b0, b1] = line.band;
    const main = d.minis?.main ?? d.main ?? line.levels[0];
    const r0 = bandAt(line, b0, b1, main.span);
    mk("rect", { x: r0.x, y: r0.y, width: r0.w, height: r0.h, fill: WHITE, ...edged(main), class: "carreau-indicator" + (isActive(main) ? " active" : "") });
    // Mini lines: grey, with the stretch of the full line their choice covers in white. The
    // active one gets a shadow (see the CSS): same size, same outline.
    const lo = Math.min(...all.map((c) => c.span[0]));
    const hi = Math.max(...all.map((c) => c.span[1]));
    const row = sideAxis[line.side] === "row"; // (a vertical line)
    for (const { choice, rect: r } of d.minis?.items ?? []) {
      const active = isActive(choice);
      const g = mk("g", { class: "carreau-indicator carreau-mini" + (active ? " active" : "") });
      mk("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 1, fill: GREY, stroke: grey(0.4), "stroke-width": 1 }, g);
      const [len0, len] = row ? [r.y, r.h] : [r.x, r.w];
      const f0 = (Math.max(choice.span[0], lo) - lo) / (hi - lo || 1);
      const f1 = (Math.min(choice.span[1], hi) - lo) / (hi - lo || 1);
      const [c0, c1] = [len0 + f0 * len, len0 + f1 * len];
      if (c1 > c0) mk("rect", row ? { x: r.x + 0.5, y: c0 + 0.5, width: r.w - 1, height: c1 - c0 - 1, fill: WHITE } : { x: c0 + 0.5, y: r.y + 0.5, width: c1 - c0 - 1, height: r.h - 1, fill: WHITE }, g);
    }
    // The node whose space the new one would take: chevrons on its four corners, in the active
    // choice's color, as thick as the line.
    const on = d.active;
    const box = on ? this.containerRect(on.target) : null;
    if (on && box) {
      const h = LINE / 2;
      const arm = Math.min(CHEVRON, box.w / 3, box.h / 3);
      const [x0, y0, x1, y1] = [box.x + h, box.y + h, box.x + box.w - h, box.y + box.h - h];
      const corners = [
        `M ${x0} ${y0 + arm} L ${x0} ${y0} L ${x0 + arm} ${y0}`,
        `M ${x1 - arm} ${y0} L ${x1} ${y0} L ${x1} ${y0 + arm}`,
        `M ${x1} ${y1 - arm} L ${x1} ${y1} L ${x1 - arm} ${y1}`,
        `M ${x0 + arm} ${y1} L ${x0} ${y1} L ${x0} ${y1 - arm}`,
      ];
      // (White, on a slightly wider dark casing: an outline.)
      mk("path", { d: corners.join(" "), stroke: grey(0.15), "stroke-width": LINE + 2, fill: "none", "stroke-linejoin": "miter", class: "carreau-indicator" });
      mk("path", { d: corners.join(" "), stroke: WHITE, "stroke-width": LINE, fill: "none", "stroke-linejoin": "miter", class: "carreau-indicator carreau-chevrons" });
    }
  }

  /**
   * The rect of the node whose space a drop's new node would take, so that each choice shows
   * its own: between two siblings, their split (1/N of it); on a side of a node, that node
   * (half of it, beside it; or, a split along that side's axis, 1/N of it, at its start or end).
   */
  private containerRect(t: DropTarget): Rect | null {
    const id = t.kind === "between" ? t.splitId : t.kind === "side" ? t.targetId : null;
    return id ? this.host.visRect(id) : null;
  }
}

function targetIdOf(t: DropTarget): string {
  return t.kind === "side" ? t.targetId : t.kind === "between" ? t.splitId : t.kind === "merge" ? t.tabId : t.paneId;
}


/** A band of a line, inward from its edge, along a given stretch. */
function bandAt(line: SideLine, from: number, to: number, alongSpan: [number, number]): Rect {
  const e = line.edge;
  const [u0, u1] = sideIsStart[line.side] ? [e + from, e + to] : [e - to, e - from];
  return sideAxis[line.side] === "row"
    ? { x: u0, y: alongSpan[0], w: u1 - u0, h: alongSpan[1] - alongSpan[0] }
    : { x: alongSpan[0], y: u0, w: alongSpan[1] - alongSpan[0], h: u1 - u0 };
}

function inLine(line: SideLine, px: number, py: number): boolean {
  const u = sideIsStart[line.side] ? across(line.side, px, py) - line.edge : line.edge - across(line.side, px, py);
  const v = along(line.side, px, py);
  return u >= line.hit[0] && u <= line.hit[1] && v >= line.span[0] && v <= line.span[1];
}

/** The extent of a line along its edge: the union of its choices'. */
function lineSpan(cs: Choice[]): [number, number] {
  return [Math.min(...cs.map((c) => c.span[0])), Math.max(...cs.map((c) => c.span[1]))];
}

/** A drop's result, as a layout and its sizes: the same key, the same drop. */
function resultKey(r: ForestResult): string {
  return r.trees.map((t) => (t ? shape(t, true) : "-")).join(";");
}

/** A line's main choice at position v along it: the outermost one covering v (else, its first). */
function mainChoice(line: SideLine, v: number): Choice {
  return line.levels.find((c) => c.span[0] <= v && v <= c.span[1]) ?? line.levels[0];
}

function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

