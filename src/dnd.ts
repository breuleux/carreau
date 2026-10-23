// Drag & drop: what can be dropped where (border lines, tab bar, the hovered pane's zones),
// and the overlay showing it. Relationships come from the LayoutIndex and node kinds.

import { grey, levelColor } from "./colors";
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
export interface SideLine {
  side: Side;
  /** Possible insertions, outermost (longest boundary) first. */
  levels: Choice[];
  /** The band occupied by the line, inward from the edge: [from, to] in pixels. */
  band: [number, number];
  /** Hit area (same convention). Can reach past the band: across a gap between siblings, or
   *  a few pixels outward at a scroll split's start/end. */
  hit: [number, number];
  /** The line borders the gap between two siblings. */
  straddles: boolean;
  /**
   * There: the insertion between them, which is the same seen from either side. It's also
   * drawn on the far half of the gap, along the far sibling (`span`), so that both halves
   * show it, and light up together.
   */
  mirror?: { choice: Choice; span: [number, number] };
  /** the hovered pane's edge coordinate on that side */
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
  lines: SideLine[];
  tabBar: { rect: Rect; dots: TabDot[]; links: TabLink[] } | null;
  zones: Zones | null;
  inCenter: boolean;
  near: SideLine | null;
  active: Choice | null;
  /** Over a scroll split's empty space: inserting there (cached: computing a drop is costly). */
  space: { key: string; choice: Choice | null } | null;
  lastEvent?: PointerEvent;
}

const SVGNS = "http://www.w3.org/2000/svg";
/** Line thickness; dash length and gap; gap between a border's two halves. */
const LINE = 5;
/** How far inward a line can be hit (more than it's thick: easier to aim at). */
const LINE_HIT = 8;
const DASH = 18;
const DASH_GAP = 1;
/** How far outward a scroll split's start/end separator can be hit. */
const EDGE_REACH = 5;
/** At a complex's edge: how far inside it its join dot is, from the gap's plain dot. */
const JOIN_OFFSET = 7;
/** Center icons' radius; tab link icons' radius. */
const ICON_R = 22;
const LINK_R = 9;

/** Two chain links, in a 16×16 box (also the view's link icon, between merged tabs). */
export const LINK_PATHS = ["M6.5 9.5l3-3", "M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2", "M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"];
/** After Esc cancels a drag, no drag may restart for this long (ms). */
const ESC_COOLDOWN = 500;

export class DragDrop {
  state: DragState | null = null;
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
    this.state = { subject, ghost, sourceEl, win, hoverPane: null, lines: [], tabBar: null, zones: null, inCenter: false, near: null, active: null, space: null };
  }

  end(commit: boolean): void {
    const d = this.state;
    if (!d) return;
    this.state = null;
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
    return this.ws.tryDrop(this.state!.subject, target, this.state!.win);
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

    // Which pane is under the cursor? Over gaps, keep the current one. Over a scroll split's
    // empty space (its scroller, where there's no cell), none: the space itself takes drops.
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
    const R = host.pxRect(this.ws.root.id);
    if (!hover && !space && d.hoverPane && R && inRect(R, px, py)) hover = d.hoverPane;
    // Still within the current line's hit area (it can reach past the pane): keep the pane.
    if (d.hoverPane && hover !== d.hoverPane && d.near && inLine(d.near, px, py)) hover = d.hoverPane;
    if (hover !== d.hoverPane) {
      d.hoverPane = hover;
      const idx = this.ws.index();
      d.lines = hover ? this.lines(idx, hover) : [];
      d.tabBar = hover ? this.tabBar(hover) : null;
      d.zones = hover ? this.zones(idx, hover) : null;
    }

    d.near = null;
    d.active = null;
    d.inCenter = false;
    if (!hover && space) d.active = this.spaceChoice(space, px, py);
    const P = hover ? host.pxRect(hover) : null;
    if (P) {
      // Priority: the border line under the cursor (nearest border at corners), then the
      // tab bar (nearest gap), then the pane's own zones.
      const onLines = d.lines.filter((l) => inLine(l, px, py));
      onLines.sort((a, b) => Math.abs(across(a.side, px, py) - a.edge) - Math.abs(across(b.side, px, py) - b.edge));
      d.near = onLines[0] ?? null;
      if (d.near) d.active = dashAt(d.near, along(d.near.side, px, py));
      else if (d.tabBar && inRect(d.tabBar.rect, px, py)) {
        // Over the middle of a tab it can merge with: merge; elsewhere, the nearest gap.
        const link = d.tabBar.links.find((l) => px >= l.hit[0] && px <= l.hit[1]);
        const nearest = d.tabBar.dots.reduce<TabDot | null>((a, b) => (!a || Math.abs(b.x - px) < Math.abs(a.x - px) ? b : a), null);
        d.active = link?.choice ?? nearest?.choice ?? null; // nothing if the nearest gap is a no-op
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
    }
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
    const xs = n ? Array.from({ length: n + 1 }, (_, i) => (i === 0 ? rs[0].left : i === n ? rs[n - 1].right : (rs[i - 1].right + rs[i].left) / 2)) : [br.left + 24];
    const sr = bar.querySelector<HTMLElement>(".carreau-tabs")!.getBoundingClientRect();
    const lo = Math.max(sr.left, rect.x + b.left) + 3;
    const hi = Math.min(sr.right, rect.x + rect.w + b.left) - 3;
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
   * Over a scroll split's empty space: insert into it where the cursor is along its axis (an
   * empty one: as its first cell; else, before the first cell whose middle is past the cursor).
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
    const index = kids.filter((c) => {
      const r = host.pxRect(c.id);
      return r && (row ? px > r.x + r.w / 2 : py > r.y + r.h / 2);
    }).length;
    const key = `${id}:${index}`;
    if (d.space?.key === key) return d.space.choice;
    const target: DropTarget = { kind: "between", splitId: id, index };
    const result = this.tryDrop(target);
    let choice: Choice | null = null;
    if (result) {
      const b = host.el.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const [start, end]: Side[] = row ? ["left", "right"] : ["top", "bottom"];
      // The preview: the empty area; or, at an end, the end cell's edge; between two, the straddle.
      choice =
        kids.length === 0 ? { target, result, span: [0, 0], rect: { x: sr.left - b.left, y: sr.top - b.top, w: sr.width, h: sr.height } }
        : index === 0 ? { target, result, span: [0, 0], edge: { nodeId: kids[0].id, side: start } }
        : index === kids.length ? { target, result, span: [0, 0], edge: { nodeId: kids[index - 1].id, side: end } }
        : { target, result, span: [0, 0], straddle: [kids[index - 1].id, kids[index].id] };
    }
    d.space = { key, choice };
    return choice;
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
          ...(paneDisplay(pane, e.ctx).showTabBar ? [] : [["tab", { kind: "tab", paneId, index: pane.tabs.length }] as [Zones["centers"][number]["kind"], DropTarget]]),
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

  /** Where a node's border is, for lines: a scroll split ends where its content does. */
  private lineEdge(n: LayoutNode, r: Rect, side: Side): number {
    const k = kind(n);
    if (!k.scroll || k.axis !== sideAxis[side]) return edge(r, side);
    const kids = (n as SplitNode).children;
    const end = this.host.pxRect(kids[sideIsStart[side] ? 0 : kids.length - 1]?.id ?? "");
    return end ? edge(end, side) : edge(r, side);
  }

  /**
   * Border lines. For each side of the hovered pane P, the nodes whose border lies on P's
   * border on that side (P's ancestors, walking up through group holders, while their edge
   * coincides with P's) each offer an insertion there if their kind accepts that side. Walking
   * up stops where P's side borders a sibling: there, the line straddles the gap and offers
   * insertion between the two. Levels come outermost first. Insertions that are the same
   * (same resulting shape) appear once, innermost; those P's own edge thirds offer don't.
   */
  private lines(idx: LayoutIndex, paneId: string, onlySide?: Side): SideLine[] {
    const { host } = this;
    const P = host.pxRect(paneId);
    const Pvis = host.visRect(paneId);
    const pe0 = idx.get(paneId);
    if (!P || !Pvis || !pe0) return [];
    const out: SideLine[] = [];
    for (const side of onlySide ? [onlySide] : SIDES) {
      const start = sideIsStart[side];
      // A border scrolled out of view gets no line (2px tolerance: fractional pixels).
      if (Math.abs(edge(P, side) - edge(Pvis, side)) > 2) continue;
      const pe = edge(P, side);
      const vspan = (id: string) => {
        const r = host.visRect(id);
        return r && span(r, side);
      };

      // Walk up: the nodes on the line (innermost first), and the gap to a sibling, if any.
      const onLine: LayoutNode[] = [];
      let between: { split: SplitNode; index: number; before: LayoutNode; after: LayoutNode } | null = null;
      for (let x: LayoutNode = idx.node(paneId)!; ; ) {
        const e = idx.get(x.id)!;
        const p = e.parent?.type === "slot" ? idx.holder(x.id) : e.parent;
        if (!p || p.type === "forest") break;
        if (kind(p).axis === sideAxis[side]) {
          const kids = (p as SplitNode).children;
          const j = start ? e.index - 1 : e.index + 1;
          if (j >= 0 && j < kids.length) {
            const lo = Math.min(j, e.index);
            between = { split: p as SplitNode, index: lo + 1, before: kids[lo], after: kids[lo + 1] };
            break;
          }
        }
        const pr = host.pxRect(p.id);
        if (!pr || Math.abs(this.lineEdge(p, pr, side) - pe) > 1.5) break;
        onLine.push(p);
        x = p;
      }

      // Already offered: P's own edge third on that side, and the insertion between siblings.
      // (Same layout *and sizes*: halving P and taking 1/N of its parent are different drops.)
      const key = (r: ForestResult) => r.trees.map((t) => (t ? shape(t, true) : "-")).join(";");
      const seen = new Set<string>();
      const third = this.zoneSide(pe0, side);
      if (third) seen.add(key(third.result));
      const levels: Choice[] = [];
      let mirror: SideLine["mirror"];
      if (between) {
        const target: DropTarget = { kind: "between", splitId: between.split.id, index: between.index };
        const result = this.tryDrop(target);
        const sp = vspan((start ? between.after : between.before).id);
        if (result && sp) {
          seen.add(key(result));
          const choice: Choice = { target, result, span: sp, straddle: [between.before.id, between.after.id] };
          levels.push(choice);
          const far = vspan((start ? between.before : between.after).id);
          if (far) mirror = { choice, span: far };
        }
      }
      const sides: Choice[] = [];
      for (const n of onLine) {
        const sp = vspan(n.id);
        if (!sp || !kind(n).sides.includes(side)) continue;
        const target: DropTarget = { kind: "side", targetId: n.id, side };
        const result = this.tryDrop(target);
        if (!result || seen.has(key(result))) continue;
        seen.add(key(result));
        // Into a scroll split at its start/end: previewed on its end child.
        const k = kind(n);
        const endChild = k.scroll && k.axis === sideAxis[side] ? (n as SplitNode).children[start ? 0 : (n as SplitNode).children.length - 1] : null;
        sides.push({ target, result, span: endChild ? (vspan(endChild.id) ?? sp) : sp, ...(endChild ? { edge: { nodeId: endChild.id, side } } : {}) });
      }
      levels.push(...sides.reverse());
      if (!levels.length) continue;

      // Where the line is (inward from P's edge). Between siblings: our half starts at the
      // middle of the gap, and the hit area covers the whole gap. At a scroll split's end, it
      // reaches a little outward (the end can be flush with the viewport's).
      const inward = (c: number) => (start ? c - pe : pe - c);
      let line: [number, number] = [0, LINE];
      let hit: [number, number] = [0, LINE_HIT];
      if (between) {
        const [first, last]: Side[] = sideAxis[side] === "row" ? ["left", "right"] : ["top", "bottom"];
        const aEnd = edge(host.pxRect(between.before.id)!, last);
        const bStart = edge(host.pxRect(between.after.id)!, first);
        const mid = inward((aEnd + bStart) / 2);
        line = [mid, mid + LINE];
        hit = [inward(start ? aEnd : bStart), mid + LINE_HIT];
      } else if (levels.some((c) => c.edge)) hit = [-EDGE_REACH, LINE_HIT];
      out.push({ side, levels, band: line, hit, straddles: !!between, mirror, edge: pe });
    }
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

    // The line along the nearest border, on the cursor's side (one flat color per level); and
    // on the far half of the gap, the insertion between the siblings, which is the same from
    // either side: the halves touch in the middle.
    if (!d.near) return;
    const line = d.near;
    const key = (c: Choice) => JSON.stringify(c.target);
    const activeKey = d.active && key(d.active);
    const isActive = (c: Choice) => key(c) === activeKey;
    const fill = new Map(line.levels.map((c, k) => [c, levelColor(k, isActive(c) ? 1 : 0.8, isActive(c) ? 0.9 : 0.68)]));
    const [b0, b1] = line.band;
    const rect = (v0: number, v1: number, c: Choice) => {
      if (v1 <= v0) return;
      const r = bandAt(line, b0, b1, [v0, v1]);
      mk("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: fill.get(c)!, class: "carreau-indicator" + (isActive(c) ? " active" : "") });
    };
    if (line.mirror) {
      const { choice, span: [v0, v1] } = line.mirror;
      const r = bandAt(line, b0 - (b1 - b0), b0, [v0, v1]);
      mk("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: fill.get(choice)!, class: "carreau-indicator" + (isActive(choice) ? " active" : "") });
    }
    for (const seg of segments(line)) {
      if (seg.levels.length === 1) rect(seg.from, seg.to, seg.levels[0]);
      // Alternate dashes, anchored to absolute positions (with a 1px visual gap).
      else
        for (let k = Math.floor(seg.from / DASH); k * DASH < seg.to; k++)
          rect(Math.max(seg.from, k * DASH), Math.min(seg.to, (k + 1) * DASH - DASH_GAP), seg.levels[mod(k, seg.levels.length)]);
    }
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
  return u >= line.hit[0] && u <= line.hit[1];
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Split a line into stretches covered by the same set of choices (outermost first). */
function segments(line: SideLine): { from: number; to: number; levels: Choice[] }[] {
  const cuts = [...new Set(line.levels.flatMap((c) => c.span))].sort((a, b) => a - b);
  const out: { from: number; to: number; levels: Choice[] }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const mid = (cuts[i] + cuts[i + 1]) / 2;
    const levels = line.levels.filter((c) => c.span[0] <= mid && mid <= c.span[1]);
    if (levels.length) out.push({ from: cuts[i], to: cuts[i + 1], levels });
  }
  return out;
}

/** The choice whose dash lies at position v along the line. */
function dashAt(line: SideLine, v: number): Choice | null {
  const seg = segments(line).find((s) => s.from <= v && v <= s.to);
  return seg ? seg.levels[seg.levels.length === 1 ? 0 : mod(Math.floor(v / DASH), seg.levels.length)] : null;
}
