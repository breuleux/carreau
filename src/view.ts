// DOM rendering, resizing, maximization (CSS only) and drag & drop with nested drop indicators.

import {
  applyDrop,
  DragSubject,
  DropResult,
  DropTarget,
  find,
  LayoutNode,
  opposite,
  panes,
  pathTo,
  PaneNode,
  Rect,
  Side,
  sideAxis,
  sideIsStart,
  SplitNode,
} from "./model";
import { Workspace } from "./workspace";

export interface ViewOptions {
  /** Content of a tab body. */
  renderTab?: (tab: PaneNode["tabs"][number], pane: PaneNode) => HTMLElement | string;
}

const SVGNS = "http://www.w3.org/2000/svg";
const SIDES: Side[] = ["left", "right", "top", "bottom"];

// ---------------------------------------------------------------------------
// Accent colors: constant lightness, narrow chroma range, hues spread by golden angle.

const hues = new Map<string, number>();
export function accent(id: string, alpha = 1, lightness = 0.72): string {
  if (!hues.has(id)) hues.set(id, (hues.size * 137.508 + 20) % 360);
  const h = hues.get(id)!;
  const c = 0.13 + 0.03 * Math.sin(h);
  return `oklch(${lightness} ${c.toFixed(3)} ${h.toFixed(1)} / ${alpha})`;
}

/** One possible drop. */
interface Choice {
  target: DropTarget;
  result: DropResult;
  /** Node whose accent color represents this choice. */
  ownerId: string;
  /** The span of the boundary this choice inserts along (pixel coordinate along the edge). */
  span: [number, number];
  /** For insertions between two siblings: [before, after] node ids. */
  straddle?: [string, string];
}

/** The drop line along one side of the hovered pane. */
interface SideLine {
  side: Side;
  /** Possible insertions, outermost (longest boundary) first. */
  levels: Choice[];
  /** The band occupied by the line, across the edge: [from, to] in pixels. */
  band: [number, number];
  /** Hit area across the edge. Like `band`, but on a border between siblings it covers the
   *  whole gap, so that the line doesn't vanish while the cursor is right on the separator. */
  hit: [number, number];
  /** Whether the line borders the gap between two siblings (rather than the workspace edge). */
  straddles: boolean;
  /**
   * The same border as seen from the panes on the other side, each clipped to the stretch
   * along that pane, so that one can see what crossing over would offer.
   */
  across: { line: SideLine; clip: [number, number] }[];
}

/** A dot in the tab bar: insert the tab(s) at this position. */
interface TabDot {
  /** null when inserting at this position would be a no-op (the dot is not drawn) */
  choice: Choice | null;
  x: number;
  y: number;
}

/** The tab bar of the hovered pane: dropping anywhere in it picks the nearest gap. */
interface TabBar {
  rect: Rect;
  dots: TabDot[];
}

/** Length of each dash when several insertions share a stretch of boundary. */
const DASH = 18;
/** Visual gap between consecutive dashes. */
const DASH_GAP = 1;
/** Each half of a border line backs off this much from the middle, unless both halves
 *  stand for the same insertion. */
const HALF_GAP = 1;
/** Line thickness. */
const LINE = 8;

export class View {
  readonly el: HTMLElement;
  private rootEl: HTMLElement;
  private overlay: SVGSVGElement;
  private selBox: HTMLElement;
  private opts: Required<ViewOptions>;
  private drag: {
    subject: DragSubject;
    label: string;
    ghost: HTMLElement;
    sourceEl: HTMLElement;
    hoverPane: string | null;
    lines: SideLine[];
    tabBar: TabBar | null;
    near: SideLine | null;
    active: Choice | null;
  } | null = null;

  constructor(
    readonly ws: Workspace,
    host: HTMLElement,
    opts: ViewOptions = {},
  ) {
    this.opts = {
      renderTab: opts.renderTab ?? ((t) => t.content ?? t.title),
    };
    this.el = document.createElement("div");
    this.el.className = "carreau";
    this.rootEl = document.createElement("div");
    this.rootEl.className = "carreau-root";
    this.overlay = document.createElementNS(SVGNS, "svg");
    this.overlay.classList.add("carreau-overlay");
    this.selBox = document.createElement("div");
    this.selBox.className = "carreau-selection";
    this.el.append(this.rootEl, this.selBox, this.overlay);
    host.append(this.el);
    ws.onChange(() => this.render());
    new ResizeObserver(() => this.decorate()).observe(this.el);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.drag) this.endDrag(false);
    });
    this.render();
  }

  // -------------------------------------------------------------------------
  // Rendering

  render(): void {
    this.rootEl.replaceChildren(this.renderNode(this.ws.root));
    this.decorate();
  }

  private elOf(id: string): HTMLElement | null {
    return this.rootEl.querySelector(`[data-id="${id}"]`);
  }

  private renderNode(node: LayoutNode): HTMLElement {
    const el = document.createElement("div");
    el.dataset.id = node.id;
    el.style.flex = `${node.weight} 1 0`;
    el.style.setProperty("--accent", accent(node.id));
    if (node.type === "pane") {
      el.className = "carreau-pane";
      el.append(this.renderTabBar(node));
      const body = document.createElement("div");
      body.className = "carreau-body";
      const tab = node.tabs[node.active];
      if (tab) {
        const c = this.opts.renderTab(tab, node);
        if (typeof c === "string") body.textContent = c;
        else body.append(c);
      }
      el.append(body);
      el.addEventListener("pointerdown", () => {
        if (this.ws.selection.id !== node.id) this.ws.select({ id: node.id });
      });
      return el;
    }
    el.className = `carreau-split carreau-${node.type}`;
    node.children.forEach((c, i) => {
      if (i > 0) el.append(this.renderSplitter(node, i));
      el.append(this.renderNode(c));
    });
    return el;
  }

  private renderTabBar(node: PaneNode): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "carreau-tabbar";
    const grip = document.createElement("div");
    grip.className = "carreau-grip";
    grip.title = "Drag to move this pane";
    grip.textContent = "⠿";
    grip.addEventListener("pointerdown", (e) =>
      this.armDrag(e, { kind: "pane", paneId: node.id }, node.tabs[node.active]?.title ?? "pane", grip.parentElement!.parentElement!),
    );
    bar.append(grip);
    node.tabs.forEach((t, i) => {
      const tab = document.createElement("div");
      tab.className = "carreau-tab" + (i === node.active ? " active" : "");
      tab.dataset.tab = t.id;
      tab.textContent = t.title;
      tab.addEventListener("click", () => {
        node.active = i;
        this.ws.select({ id: node.id });
      });
      tab.addEventListener("pointerdown", (e) =>
        this.armDrag(e, { kind: "tab", tabId: t.id }, t.title, tab),
      );
      bar.append(tab);
    });
    return bar;
  }

  private renderSplitter(parent: SplitNode, i: number): HTMLElement {
    const s = document.createElement("div");
    s.className = "carreau-splitter";
    s.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const a = parent.children[i - 1];
      const b = parent.children[i];
      const ea = this.elOf(a.id)!;
      const eb = this.elOf(b.id)!;
      const horiz = parent.type === "row";
      const size = (el: HTMLElement) =>
        horiz ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
      const pa = size(ea);
      const pb = size(eb);
      const wTot = a.weight + b.weight;
      const start = horiz ? e.clientX : e.clientY;
      s.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const d = (horiz ? ev.clientX : ev.clientY) - start;
        const na = Math.max(30, Math.min(pa + pb - 30, pa + d));
        a.weight = (wTot * na) / (pa + pb);
        b.weight = wTot - a.weight;
        ea.style.flex = `${a.weight} 1 0`;
        eb.style.flex = `${b.weight} 1 0`;
        this.decorate();
      };
      const up = () => {
        s.removeEventListener("pointermove", move);
        s.removeEventListener("pointerup", up);
        this.ws.emit();
      };
      s.addEventListener("pointermove", move);
      s.addEventListener("pointerup", up);
    });
    return s;
  }

  /** Apply selection & maximization. Pure CSS: the DOM structure is untouched. */
  decorate(): void {
    for (const el of this.rootEl.querySelectorAll(".max-hidden, .max-path, .selected"))
      el.classList.remove("max-hidden", "max-path", "selected");
    this.el.classList.toggle("is-maximized", !!this.ws.maximized);

    const max = this.ws.maximized;
    if (max) {
      const path = pathTo(this.ws.root, max.id) ?? [];
      const keep = new Set(path.map((n) => n.id));
      const target = path[path.length - 1];
      if (target && target.type !== "pane" && max.range) {
        target.children.forEach((c, i) => {
          if (i < max.range![0] || i > max.range![1]) this.elOf(c.id)?.classList.add("max-hidden");
        });
      }
      for (const n of path.slice(0, -1)) {
        if (n.type === "pane") continue;
        for (const c of n.children)
          if (!keep.has(c.id)) this.elOf(c.id)?.classList.add("max-hidden");
      }
      for (const n of path) this.elOf(n.id)?.classList.add("max-path");
      // splitters adjacent to hidden children are hidden too
      for (const s of this.rootEl.querySelectorAll<HTMLElement>(".carreau-splitter")) {
        const prev = s.previousElementSibling;
        const next = s.nextElementSibling;
        s.classList.toggle(
          "max-hidden",
          !!(prev?.classList.contains("max-hidden") || next?.classList.contains("max-hidden")),
        );
      }
    } else {
      for (const s of this.rootEl.querySelectorAll(".carreau-splitter.max-hidden"))
        s.classList.remove("max-hidden");
    }

    // Selection box
    const nodes = this.ws.selectedNodes();
    const base = this.el.getBoundingClientRect();
    const rs = nodes
      .map((n) => this.elOf(n.id)?.getBoundingClientRect())
      .filter((r): r is DOMRect => !!r && r.width > 0);
    if (rs.length) {
      const x0 = Math.min(...rs.map((r) => r.left)) - base.left;
      const y0 = Math.min(...rs.map((r) => r.top)) - base.top;
      const x1 = Math.max(...rs.map((r) => r.right)) - base.left;
      const y1 = Math.max(...rs.map((r) => r.bottom)) - base.top;
      Object.assign(this.selBox.style, {
        display: "block",
        left: `${x0}px`,
        top: `${y0}px`,
        width: `${x1 - x0}px`,
        height: `${y1 - y0}px`,
      });
      const accentId = this.ws.selection.id;
      this.selBox.style.setProperty("--accent", accent(accentId));
      this.selBox.dataset.kind = this.ws.selection.range
        ? "range"
        : (this.ws.node(accentId)?.type ?? "");
    } else {
      this.selBox.style.display = "none";
    }
    for (const n of nodes) this.elOf(n.id)?.classList.add("selected");
  }

  // -------------------------------------------------------------------------
  // Drag & drop

  private armDrag(e: PointerEvent, subject: DragSubject, label: string, sourceEl: HTMLElement): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      if (!this.drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 5) {
        this.startDrag(subject, label, sourceEl);
      }
      if (this.drag) this.dragMove(ev);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (this.drag) {
        this.dragMove(ev);
        this.endDrag(true);
      } else if (subject.kind === "pane") {
        this.ws.select({ id: subject.paneId });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private startDrag(subject: DragSubject, label: string, sourceEl: HTMLElement): void {
    const ghost = document.createElement("div");
    ghost.className = "carreau-ghost";
    ghost.textContent = label;
    document.body.append(ghost);
    sourceEl.classList.add("carreau-drag-source");
    this.el.classList.add("is-dragging");
    this.drag = { subject, label, ghost, sourceEl, hoverPane: null, lines: [], tabBar: null, near: null, active: null };
  }

  private endDrag(commit: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.ghost.remove();
    d.sourceEl.classList.remove("carreau-drag-source");
    this.el.classList.remove("is-dragging");
    this.overlay.replaceChildren();
    if (commit && d.active) this.ws.setRoot(d.active.result.root, d.active.result.paneId);
  }

  private dragMove(ev: PointerEvent): void {
    const d = this.drag!;
    d.ghost.style.left = `${ev.clientX + 12}px`;
    d.ghost.style.top = `${ev.clientY + 8}px`;
    const base = this.el.getBoundingClientRect();
    const px = ev.clientX - base.left;
    const py = ev.clientY - base.top;

    // Which pane is under the cursor? Over a gap (splitter), keep the current one.
    let hover: string | null = null;
    for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
      const p = (el as HTMLElement).closest?.(".carreau-pane") as HTMLElement | null;
      if (p && this.rootEl.contains(p)) {
        hover = p.dataset.id!;
        break;
      }
    }
    const R = this.pxRect(this.ws.root.id);
    if (!hover && d.hoverPane && R && inRect(R, px, py)) hover = d.hoverPane;
    if (hover !== d.hoverPane) {
      d.hoverPane = hover;
      d.lines = hover ? this.buildLines(hover, d.subject) : [];
      d.tabBar = hover ? this.buildTabBar(hover, d.subject) : null;
    }
    d.near = null;
    d.active = null;
    const P = hover ? this.pxRect(hover) : null;
    if (P) {
      // The border line under the cursor (nearest border if two overlap, at corners).
      let best: { line: SideLine; dist: number } | null = null;
      for (const line of d.lines) {
        if (!this.inLine(line, px, py)) continue;
        const dist = Math.abs(
          line.side === "left" ? px - P.x : line.side === "right" ? P.x + P.w - px
            : line.side === "top" ? py - P.y : P.y + P.h - py,
        );
        if (!best || dist < best.dist) best = { line, dist };
      }
      d.near = best?.line ?? null;
      if (d.near) {
        d.active = dashAt(d.near, sideAxis[d.near.side] === "row" ? py : px);
      } else if (d.tabBar && inRect(d.tabBar.rect, px, py)) {
        // Anywhere in the tab bar: the nearest gap between tabs (nothing if that's a no-op).
        let nearest: TabDot | null = null;
        for (const dot of d.tabBar.dots)
          if (!nearest || Math.abs(dot.x - px) < Math.abs(nearest.x - px)) nearest = dot;
        d.active = nearest?.choice ?? null;
      }
    }
    this.drawOverlay();
  }

  private inLine(line: SideLine, px: number, py: number): boolean {
    const u = sideAxis[line.side] === "row" ? px : py;
    return u >= line.hit[0] && u <= line.hit[1];
  }

  private pxRect(id: string): Rect | null {
    const el = this.elOf(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const b = this.el.getBoundingClientRect();
    return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
  }

  /** Dots before the first tab, between tabs, and after the last tab. */
  private buildTabBar(paneId: string, subject: DragSubject): TabBar {
    const root = this.ws.root;
    const paneEl = this.elOf(paneId)!;
    const tabs = [...paneEl.querySelectorAll<HTMLElement>(".carreau-tab")];
    const bar = paneEl.querySelector<HTMLElement>(".carreau-tabbar")!;
    const b = this.el.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const rects = tabs.map((t) => t.getBoundingClientRect());
    const xs = rects.length ? [rects[0].left, ...rects.map((r) => r.right)] : [br.left + 24];
    const y = br.top + br.height / 2 - b.top;
    const dots: TabDot[] = [];
    xs.forEach((cx, index) => {
      if (cx > br.right - 4) return; // overflowed out of the bar
      const target: DropTarget = { kind: "tab", paneId, index };
      const result = applyDrop(root, subject, target);
      dots.push({
        choice: result ? { target, result, ownerId: paneId, span: [cx, cx] } : null,
        x: cx - b.left,
        y,
      });
    });
    return { rect: { x: br.left - b.left, y: br.top - b.top, w: br.width, h: br.height }, dots };
  }

  /**
   * For each side of the hovered pane, collect the nodes whose boundary on that side contains
   * the pane's, outermost first, keeping one per distinct boundary. The outermost either sits
   * against the edge of the workspace, or between two siblings of a split, in which case the
   * line straddles the border and that choice inserts between the siblings.
   */
  private buildLines(
    paneId: string,
    subject: DragSubject,
    onlySide?: Side,
    withAcross = true,
  ): SideLine[] {
    const root = this.ws.root;
    const P = this.pxRect(paneId);
    if (!P) return [];
    const lines: SideLine[] = [];

    for (const side of onlySide ? [onlySide] : SIDES) {
      const axis = sideAxis[side];
      const start = sideIsStart[side];
      const horizontal = axis === "row";
      const span = (id: string): [number, number] | null => {
        const r = this.pxRect(id);
        return r ? (horizontal ? [r.y, r.y + r.h] : [r.x, r.x + r.w]) : null;
      };

      const chain: LayoutNode[] = [];
      let between: { split: SplitNode; index: number; before: LayoutNode; after: LayoutNode } | null = null;
      let x: LayoutNode = find(root, paneId)!.node;
      for (;;) {
        chain.unshift(x);
        const loc = find(root, x.id)!;
        if (!loc.parent) break;
        if (loc.parent.type === axis) {
          const j = start ? loc.index - 1 : loc.index + 1;
          if (j >= 0 && j < loc.parent.children.length) {
            const lo = Math.min(j, loc.index);
            between = {
              split: loc.parent,
              index: lo + 1,
              before: loc.parent.children[lo],
              after: loc.parent.children[lo + 1],
            };
            break;
          }
        }
        x = loc.parent;
      }

      const levels: Choice[] = [];
      let rest = chain;
      if (between) {
        const target: DropTarget = { kind: "between", splitId: between.split.id, index: between.index };
        const result = applyDrop(root, subject, target);
        const sp = span(chain[0].id);
        if (result && sp) {
          levels.push({
            target,
            result,
            span: sp,
            ownerId: between.split.id,
            straddle: [between.before.id, between.after.id],
          });
        }
        rest = chain.slice(1);
      }
      // One choice per distinct boundary: the innermost node for which the drop is valid.
      let group: { span: [number, number]; best: Choice | null } | null = null;
      const flush = () => {
        if (group?.best) levels.push(group.best);
      };
      for (const n of rest) {
        const sp = span(n.id);
        if (!sp) continue;
        if (!group || Math.abs(sp[0] - group.span[0]) > 1 || Math.abs(sp[1] - group.span[1]) > 1) {
          flush();
          group = { span: sp, best: null };
        }
        const target: DropTarget = { kind: "side", targetId: n.id, side };
        const result = applyDrop(root, subject, target);
        if (result) group.best = { target, result, span: sp, ownerId: n.id };
      }
      flush();
      if (!levels.length) continue;

      // Position of the line across the edge.
      const edge = side === "left" ? P.x : side === "right" ? P.x + P.w : side === "top" ? P.y : P.y + P.h;
      let band: [number, number];
      let hit: [number, number];
      if (between) {
        const a = this.pxRect(between.before.id)!;
        const b = this.pxRect(between.after.id)!;
        const mid = horizontal ? (a.x + a.w + b.x) / 2 : (a.y + a.h + b.y) / 2;
        // Our half of the border: from the middle of the gap, inwards.
        band = start ? [mid, mid + LINE] : [mid - LINE, mid];
        const far = horizontal ? (start ? a.x + a.w : b.x) : start ? a.y + a.h : b.y;
        hit = start ? [far, mid + LINE] : [mid - LINE, far];
      } else {
        band = start ? [edge, edge + LINE] : [edge - LINE, edge];
        hit = band;
      }

      // Panes on the other side of the border, and the border as they see it.
      const across: SideLine["across"] = [];
      if (between && withAcross) {
        const other = start ? this.pxRect(between.before.id)! : this.pxRect(between.after.id)!;
        const otherEdge =
          side === "left" ? other.x + other.w : side === "right" ? other.x
            : side === "top" ? other.y + other.h : other.y;
        const extent: [number, number] = [
          Math.min(...levels.map((c) => c.span[0])),
          Math.max(...levels.map((c) => c.span[1])),
        ];
        const otherSide = opposite[side];
        for (const q of panes(start ? between.before : between.after)) {
          const Q = this.pxRect(q.id);
          if (!Q) continue;
          const facing =
            otherSide === "left" ? Q.x : otherSide === "right" ? Q.x + Q.w
              : otherSide === "top" ? Q.y : Q.y + Q.h;
          if (Math.abs(facing - otherEdge) > 1.5) continue;
          const qs: [number, number] = horizontal ? [Q.y, Q.y + Q.h] : [Q.x, Q.x + Q.w];
          const clip: [number, number] = [Math.max(qs[0], extent[0]), Math.min(qs[1], extent[1])];
          if (clip[1] <= clip[0]) continue;
          const [line] = this.buildLines(q.id, subject, otherSide, false);
          if (line) across.push({ line, clip });
        }
      }
      lines.push({ side, levels, band, hit, straddles: !!between, across });
    }
    return lines;
  }

  private drawOverlay(): void {
    const d = this.drag!;
    const svg = this.overlay;
    svg.replaceChildren();
    if (!d.hoverPane) return;
    const mk = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      parent.append(e);
      return e;
    };
    const defs = mk("defs", {});

    // Preview, aligned with the current geometry.
    if (d.active) {
      const t = d.active.target;
      let r: Rect | null = null;
      if (t.kind === "tab") r = null; // the highlighted dot is the preview
      else if (t.kind === "side") {
        r = this.pxRect(t.targetId);
        if (r) {
          r =
            t.side === "left"
              ? { ...r, w: r.w / 2 }
              : t.side === "right"
                ? { ...r, x: r.x + r.w / 2, w: r.w / 2 }
                : t.side === "top"
                  ? { ...r, h: r.h / 2 }
                  : { ...r, y: r.y + r.h / 2, h: r.h / 2 };
        }
      } else if (d.active.straddle) {
        // Straddle the boundary: last third of the node before, first third of the one after.
        const a = this.pxRect(d.active.straddle[0])!;
        const b = this.pxRect(d.active.straddle[1])!;
        const split = this.ws.node(t.splitId)!;
        r =
          split.type === "row"
            ? { x: a.x + (a.w * 2) / 3, y: a.y, w: b.x + b.w / 3 - (a.x + (a.w * 2) / 3), h: a.h }
            : { x: a.x, y: a.y + (a.h * 2) / 3, w: a.w, h: b.y + b.h / 3 - (a.y + (a.h * 2) / 3) };
      }
      if (r) {
        mk("rect", {
          x: r.x + 3,
          y: r.y + 3,
          width: Math.max(0, r.w - 6),
          height: Math.max(0, r.h - 6),
          rx: 6,
          class: "carreau-preview",
          style: `--accent: ${accent(d.active.ownerId)}`,
        });
      }
    }

    // Tab insertion dots.
    for (const dot of d.tabBar?.dots ?? []) {
      if (!dot.choice) continue;
      const active = d.active === dot.choice;
      mk("circle", {
        cx: dot.x,
        cy: dot.y,
        r: active ? 5.5 : 3.5,
        fill: accent(dot.choice.ownerId, active ? 1 : 0.8, active ? 0.9 : 0.75),
        stroke: "#0008",
        "stroke-width": 1,
        class: "carreau-indicator carreau-dot" + (active ? " active" : ""),
      });
    }

    // The line along the nearest border, plus the same border seen from the other side.
    if (!d.near) return;
    // Choices offered on both sides of the border are the same insertion (between the two
    // siblings): those halves touch and light up together. Others keep a gap between halves.
    const key = (c: Choice) => JSON.stringify(c.target);
    const nearKeys = new Set(d.near.levels.map(key));
    const acrossKeys = new Set(d.near.across.flatMap(({ line }) => line.levels.map(key)));
    const shared = (c: Choice) => nearKeys.has(key(c)) && acrossKeys.has(key(c));
    const activeKey = d.active ? key(d.active) : null;
    const isActive = (c: Choice) => key(c) === activeKey;
    let gradients = 0;
    const drawLine = (line: SideLine, clip?: [number, number]) => {
      const horizontal = sideAxis[line.side] === "row";
      // Inner end of the band (the middle of the gap, for lines bordering a sibling).
      const start = sideIsStart[line.side];
      const bandFor = (c: Choice): [number, number] => {
        const [b0, b1] = line.band;
        if (!line.straddles || shared(c)) return [b0, b1];
        return start ? [b0 + HALF_GAP, b1] : [b0, b1 - HALF_GAP];
      };
      const [b0, b1] = line.band;
      // Gradient across the line: bright at the border, darker away from it.
      const gradFor = (c: Choice) => {
        const active = isActive(c);
        const alpha = active ? 1 : 0.75;
        const outer = sideIsStart[line.side] ? b0 : b1;
        const inner = sideIsStart[line.side] ? b1 : b0;
        const [x1, y1, x2, y2] = horizontal ? [outer, 0, inner, 0] : [0, outer, 0, inner];
        const id = `carreau-grad-${gradients++}`;
        const g = mk("linearGradient", { id, gradientUnits: "userSpaceOnUse", x1, y1, x2, y2 }, defs);
        mk("stop", { offset: 0, "stop-color": accent(c.ownerId, alpha, active ? 0.95 : 0.86) }, g);
        mk("stop", { offset: 1, "stop-color": accent(c.ownerId, alpha, active ? 0.66 : 0.5) }, g);
        return `url(#${id})`;
      };
      const fills = new Map(line.levels.map((c) => [c, gradFor(c)]));
      const rect = (v0: number, v1: number, c: Choice) => {
        if (clip) {
          v0 = Math.max(v0, clip[0]);
          v1 = Math.min(v1, clip[1]);
        }
        if (v1 <= v0) return;
        const [u0, u1] = bandFor(c);
        mk("rect", {
          ...(horizontal
            ? { x: u0, y: v0, width: u1 - u0, height: v1 - v0 }
            : { x: v0, y: u0, width: v1 - v0, height: u1 - u0 }),
          fill: fills.get(c)!,
          class: "carreau-indicator" + (isActive(c) ? " active" : ""),
        });
      };
      for (const seg of segments(line)) {
        if (seg.levels.length === 1) {
          rect(seg.from, seg.to, seg.levels[0]);
          continue;
        }
        // Alternate dashes, anchored to absolute positions so they don't shift around.
        for (let k = Math.floor(seg.from / DASH); k * DASH < seg.to; k++) {
          const v0 = Math.max(seg.from, k * DASH);
          // 1px gap at the end of each dash (visual only: hit-testing ignores it).
          const v1 = Math.min(seg.to, (k + 1) * DASH - DASH_GAP);
          rect(v0, v1, seg.levels[((k % seg.levels.length) + seg.levels.length) % seg.levels.length]);
        }
      }
    };
    drawLine(d.near);
    for (const { line, clip } of d.near.across) drawLine(line, clip);
  }
}

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
  if (!seg) return null;
  if (seg.levels.length === 1) return seg.levels[0];
  const k = Math.floor(v / DASH);
  return seg.levels[((k % seg.levels.length) + seg.levels.length) % seg.levels.length];
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

