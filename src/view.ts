// DOM rendering, resizing, maximization (CSS only) and drag & drop with nested drop indicators.

import {
  axisOf,
  isScroll,
  DragSubject,
  ForestResult,
  DropTarget,
  find,
  findTab,
  FloatingWindow,
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
  result: ForestResult;
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

/** The hovered pane's own drop zones: its edge thirds, and a swap icon in its center. */
interface Zones {
  /** visible rect of the pane */
  rect: Rect;
  /** Insert beside the pane (taking half of it), per side; missing if that's a no-op. */
  sides: Partial<Record<Side, Choice>>;
  /**
   * The center icon, shown when in the center third and active over the icon: swap contents
   * with the pane, or (over the dragged thing's own pane) float it.
   */
  center: { kind: "swap" | "float"; choice: Choice; cx: number; cy: number; r: number } | null;
}

/** Docking a floating window: hold it still this long (ms), within this many pixels. */
const HOLD_TO_DOCK = 1000;
const HOLD_TOLERANCE = 4;
/** When the progress ring appears while holding still (ms). */
const HOLD_RING_DELAY = 150;

/** Radius of the swap icon. */
const SWAP_R = 22;

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
    zones: Zones | null;
    /** whether the cursor is in the center third (shows the swap icon) */
    inCenter: boolean;
    near: SideLine | null;
    active: Choice | null;
    lastEvent?: PointerEvent;
    /** set when docking a floating window */
    win?: FloatingWindow;
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
    this.floatLayer = document.createElement("div");
    this.floatLayer.className = "carreau-floats";
    this.el.append(this.rootEl, this.selBox, this.floatLayer, this.overlay);
    // Close the pane menu on any outside interaction.
    window.addEventListener("pointerdown", (e) => {
      // (the anchor toggles the menu itself)
      const t = e.target as Node;
      if (this.menu && !this.menu.contains(t) && !this.menuAnchor?.contains(t)) this.closeMenu();
    }, { capture: true });
    host.append(this.el);
    ws.onChange(() => this.render());
    new ResizeObserver(() => this.decorate()).observe(this.el);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.drag) this.endDrag(false);
    });
    // Clicking into an iframe fires nothing in this document; the window loses focus and
    // the iframe becomes the active element. Select its pane.
    window.addEventListener("blur", () =>
      setTimeout(() => {
        const a = document.activeElement;
        if (a instanceof HTMLIFrameElement && this.el.contains(a)) {
          const id = (a.closest(".carreau-pane") as HTMLElement | null)?.dataset.id;
          if (id && this.ws.selection.id !== id) this.ws.select({ id });
        }
      }),
    );
    // Scrolling a scroll split moves things around: refresh the selection outline and, during
    // a drag, rebuild the indicators for the current cursor position.
    this.el.addEventListener(
      "scroll",
      () => {
        this.decorate();
        const d = this.drag;
        if (d?.lastEvent) {
          d.hoverPane = null;
          this.dragMove(d.lastEvent);
        }
      },
      { capture: true },
    );
    this.render();
  }

  // -------------------------------------------------------------------------
  // Rendering

  render(): void {
    // Re-rendering rebuilds the DOM, so carry scroll positions over by node id.
    const scroll = new Map<string, [number, number]>();
    for (const el of this.el.querySelectorAll<HTMLElement>(".carreau-scroll"))
      scroll.set(el.dataset.id!, [el.scrollLeft, el.scrollTop]);
    // Attach the new tree *before* removing the old one, so that tab contents (iframes...)
    // can be moved across while staying connected: moveBefore only preserves state when
    // both the node and its destination are in the document.
    const old = [...this.rootEl.childNodes, ...this.floatLayer.childNodes];
    const tree = this.renderNode(this.ws.root);
    const floats = this.ws.floating.map((w) => this.renderFloat(w));
    this.rootEl.append(tree);
    this.floatLayer.append(...floats);
    this.placeContents([tree, ...floats]);
    for (const n of old) n.remove();
    for (const [id, [l, t]] of scroll) {
      const el = this.elOf(id);
      if (el) {
        el.scrollLeft = l;
        el.scrollTop = t;
      }
    }
    this.decorate();
    // Bring a newly selected node into view (it may be scrolled out in a scroll split).
    const key = JSON.stringify(this.ws.selection);
    if (key !== this.lastSelection) {
      this.lastSelection = key;
      this.elOf(this.ws.selection.id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  private lastSelection = "";
  private floatLayer: HTMLElement;
  private menu: HTMLElement | null = null;
  private menuAnchor: HTMLElement | null = null;

  /** One persistent element per tab, created once and moved around, never recreated. */
  private contents = new Map<string, HTMLElement>();

  /** Put every tab's content into its pane's body; only the active tab's is shown. */
  private placeContents(trees: HTMLElement[]): void {
    const seen = new Set<string>();
    // Pitfall: the old tree is still attached at this point, so look panes up in the new
    // tree only (a document-wide lookup would find the old pane first).
    const paneEls = new Map<string, HTMLElement>();
    for (const tree of trees)
      for (const el of [tree, ...tree.querySelectorAll<HTMLElement>(".carreau-pane")])
        if (el.classList.contains("carreau-pane")) paneEls.set(el.dataset.id!, el);
    for (const p of this.ws.trees().flatMap((t) => panes(t))) {
      const body = paneEls.get(p.id)?.querySelector<HTMLElement>(":scope > .carreau-body");
      if (!body) continue;
      p.tabs.forEach((tab, i) => {
        seen.add(tab.id);
        let el = this.contents.get(tab.id);
        if (!el) {
          el = document.createElement("div");
          el.className = "carreau-content";
          el.dataset.tab = tab.id;
          const c = this.opts.renderTab(tab, p);
          if (typeof c === "string") el.textContent = c;
          else el.append(c);
          this.contents.set(tab.id, el);
        }
        el.hidden = i !== p.active;
        if (el.parentElement !== body) move(body, el);
      });
    }
    // Tabs that left the layout entirely (e.g. a new layout was loaded).
    for (const [id, el] of this.contents) {
      if (!seen.has(id)) {
        el.remove();
        this.contents.delete(id);
      }
    }
  }

  private elOf(id: string): HTMLElement | null {
    const sel = `[data-id="${id}"]`;
    return this.rootEl.querySelector(sel) ?? this.floatLayer.querySelector(sel);
  }

  /** A drop across all trees (main and floating), excluding a window being docked. */
  private tryDrop(subject: DragSubject, target: DropTarget): ForestResult | null {
    return this.ws.tryDrop(subject, target, this.drag?.win);
  }

  /**
   * `natural` tells, per axis, whether this node's size along that axis is determined by its
   * content (inside a scroll split along that axis) rather than by the space available.
   */
  private renderNode(
    node: LayoutNode,
    natural: Record<"row" | "column", boolean> = { row: false, column: false },
    sizedByContent = false,
    inFloat = false,
  ): HTMLElement {
    const el = document.createElement("div");
    el.dataset.id = node.id;
    el.style.flex = sizedByContent ? "none" : `${node.weight} 1 0`;
    el.style.setProperty("--accent", accent(node.id));
    if (node.type === "pane") {
      el.className = "carreau-pane";
      el.append(this.renderTabBar(node, inFloat));
      const body = document.createElement("div");
      body.className = "carreau-body";
      // Filled by placeContents() once the tree is attached.
      el.append(body);
      el.addEventListener("pointerdown", () => {
        if (this.ws.selection.id !== node.id) this.ws.select({ id: node.id });
      });
      return el;
    }
    const axis = axisOf(node.type);
    const scroll = isScroll(node.type);
    el.className = `carreau-split carreau-${axis}` + (scroll ? ` carreau-scroll carreau-${node.type}` : "");
    // Children of a scroll split, or of a plain split whose own size along its axis is
    // natural, size themselves along that axis. Weights mean nothing there: no splitters.
    const childNatural = { ...natural, [axis]: natural[axis] || scroll };
    const byContent = scroll || natural[axis];
    node.children.forEach((c, i) => {
      if (i > 0) {
        if (byContent) {
          const gap = document.createElement("div");
          gap.className = "carreau-gap";
          el.append(gap);
        } else {
          el.append(this.renderSplitter(node, i));
        }
      }
      const child = this.renderNode(c, childNatural, byContent, inFloat);
      if (byContent) child.classList.add(`carreau-natural-${axis}`);
      el.append(child);
    });
    return el;
  }

  private renderTabBar(node: PaneNode, inFloat: boolean): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "carreau-tabbar";
    node.tabs.forEach((t, i) => {
      const tab = document.createElement("div");
      tab.className = "carreau-tab" + (i === node.active ? " active" : "");
      tab.dataset.tab = t.id;
      tab.textContent = t.title;
      tab.addEventListener("click", () => {
        node.active = i;
        if (inFloat) this.ws.emit();
        else this.ws.select({ id: node.id });
      });
      tab.addEventListener("pointerdown", (e) =>
        this.armDrag(e, { kind: "tab", tabId: t.id }, t.title, tab),
      );
      if (!inFloat) {
        // Double click: maximize the pane (or restore it if it already is).
        tab.addEventListener("dblclick", () => {
          this.ws.select({ id: node.id });
          if (this.ws.maximized?.id === node.id && !this.ws.maximized.range) this.ws.restore();
          else this.ws.maximize();
        });
      }
      bar.append(tab);
    });
    // The empty part of the header moves the pane (there is no separate handle). It always
    // keeps some room: tabs shrink (with an ellipsis) before it disappears.
    const space = document.createElement("div");
    space.className = "carreau-tabspace";
    space.title = "Drag to move this pane";
    space.addEventListener("pointerdown", (e) =>
      this.armDrag(e, { kind: "pane", paneId: node.id }, node.tabs[node.active]?.title ?? "pane", bar.parentElement!),
    );
    bar.append(space);
    if (!inFloat) {
      // "More" button at the right end: opens the pane menu.
      const more = document.createElement("div");
      more.className = "carreau-more";
      more.title = "Pane options";
      more.textContent = "⋯";
      more.addEventListener("pointerdown", (e) => e.stopPropagation());
      more.addEventListener("click", () => {
        if (this.menuAnchor === more) this.closeMenu();
        else this.openMenu(more, node);
      });
      bar.append(more);
    }
    return bar;
  }

  // -------------------------------------------------------------------------
  // Pane menu

  private openMenu(anchor: HTMLElement, node: PaneNode): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "carreau-menu";
    const item = (label: string, enabled: boolean, action: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.disabled = !enabled;
      b.addEventListener("click", () => {
        this.closeMenu();
        action();
      });
      menu.append(b);
    };
    const canFloat = !!find(this.ws.root, node.id)?.parent;
    item("Float", canFloat, () => this.ws.float(node.id, this.floatRect(node.id)!));
    const g = anchor.getBoundingClientRect();
    const b = this.el.getBoundingClientRect();
    menu.style.right = `${b.right - g.right}px`;
    menu.style.top = `${g.bottom - b.top + 2}px`;
    this.el.append(menu);
    this.menu = menu;
    this.menuAnchor = anchor;
    anchor.classList.add("open");
  }

  /** Where a pane floated out of the layout appears: its rect at 80%, centered on it. */
  private floatRect(paneId: string): Rect | null {
    const r = this.pxRect(paneId);
    if (!r) return null;
    const w = Math.max(240, r.w * 0.8);
    const h = Math.max(160, r.h * 0.8);
    return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    this.menuAnchor?.classList.remove("open");
    this.menuAnchor = null;
  }

  // -------------------------------------------------------------------------
  // Floating windows

  private renderFloat(win: FloatingWindow): HTMLElement {
    const el = document.createElement("div");
    el.className = "carreau-float";
    this.placeFloat(el, win);
    // Title bar: moves the window; holding it still for a second docks the whole window.
    const bar = document.createElement("div");
    bar.className = "carreau-float-bar";
    bar.title = "Drag to move; hold still for a second to dock";
    bar.style.setProperty("--accent", accent(firstPaneId(win.root)));
    bar.addEventListener("pointerdown", (e) => this.armFloatMove(e, win));
    el.append(bar);
    const content = this.renderNode(win.root, undefined, false, true);
    content.style.flex = "1 1 0";
    el.append(content);
    el.addEventListener("pointerdown", () => this.raiseFloat(win, el), { capture: true });
    // Resize from the bottom-right corner.
    const handle = document.createElement("div");
    handle.className = "carreau-float-resize";
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      this.el.classList.add("is-resizing");
      const { w, h } = win.rect;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const move = (ev: PointerEvent) => {
        win.rect.w = Math.max(160, w + ev.clientX - x0);
        win.rect.h = Math.max(100, h + ev.clientY - y0);
        this.placeFloat(el, win);
      };
      const up = () => {
        this.el.classList.remove("is-resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        this.ws.emit();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    el.append(handle);
    return el;
  }

  private placeFloat(el: HTMLElement, win: FloatingWindow): void {
    Object.assign(el.style, {
      left: `${win.rect.x}px`,
      top: `${win.rect.y}px`,
      width: `${win.rect.w}px`,
      height: `${win.rect.h}px`,
    });
  }

  /** Bring a window to the front without re-rendering (which would interrupt the click). */
  private raiseFloat(win: FloatingWindow, el: HTMLElement): void {
    if (this.ws.floating[this.ws.floating.length - 1] === win) return;
    this.ws.floating.splice(this.ws.floating.indexOf(win), 1);
    this.ws.floating.push(win);
    // Reordering with appendChild would reload the window's iframes: use moveBefore.
    move(this.floatLayer, el);
  }

  /**
   * Drag a floating window by its grip. It moves freely; holding it still for a second
   * switches to docking: the window turns translucent and the usual drop indicators appear.
   * Releasing on one docks the pane back into the hierarchy; elsewhere, it stays floating.
   */
  private armFloatMove(e: PointerEvent, win: FloatingWindow): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement; // the window's title bar
    grip.setPointerCapture(e.pointerId);
    const el = grip.closest(".carreau-float") as HTMLElement;
    const { x, y } = win.rect;
    const x0 = e.clientX;
    const y0 = e.clientY;
    this.el.classList.add("is-moving-float");
    let anchor = { x: e.clientX, y: e.clientY };
    let ring: HTMLElement | null = null;
    let timers: number[] = [];
    let docking = false;
    const clearHold = () => {
      timers.forEach(clearTimeout);
      timers = [];
      ring?.remove();
      ring = null;
    };
    const startHold = (cx: number, cy: number) => {
      clearHold();
      if (docking) return;
      // Show a filling ring after a short pause, dock after one second still.
      timers.push(
        window.setTimeout(() => {
          ring = document.createElement("div");
          ring.className = "carreau-hold";
          ring.style.left = `${cx}px`;
          ring.style.top = `${cy}px`;
          ring.style.setProperty("--accent", accent(firstPaneId(win.root)));
          ring.innerHTML = `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" /></svg>`;
          document.body.append(ring);
        }, HOLD_RING_DELAY),
        window.setTimeout(() => {
          clearHold();
          docking = true;
          el.classList.add("docking");
          this.startDrag({ kind: "external", node: win.root }, "", el, win);
          if (last) this.dragMove(last);
        }, HOLD_TO_DOCK),
      );
    };
    let last: PointerEvent | null = null;
    const move = (ev: PointerEvent) => {
      last = ev;
      win.rect.x = x + ev.clientX - x0;
      win.rect.y = y + ev.clientY - y0;
      this.placeFloat(el, win);
      if (docking) {
        if (this.drag) this.dragMove(ev);
      } else if (Math.hypot(ev.clientX - anchor.x, ev.clientY - anchor.y) > HOLD_TOLERANCE) {
        anchor = { x: ev.clientX, y: ev.clientY };
        startHold(ev.clientX, ev.clientY);
      }
    };
    const up = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      clearHold();
      this.el.classList.remove("is-moving-float");
      el.classList.remove("docking");
      if (this.drag) {
        this.dragMove(ev);
        this.endDrag(true);
      } else {
        this.ws.emit();
      }
    };
    // The hold timer only starts once the window has actually been dragged.
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
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
      const horiz = axisOf(parent.type) === "row";
      const size = (el: HTMLElement) =>
        horiz ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
      const pa = size(ea);
      const pb = size(eb);
      const wTot = a.weight + b.weight;
      const start = horiz ? e.clientX : e.clientY;
      s.setPointerCapture(e.pointerId);
      this.el.classList.add("is-resizing");
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
        this.el.classList.remove("is-resizing");
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
    // Only the visible parts (selected nodes may be partly scrolled out).
    const rs = nodes.map((n) => this.visRect(n.id)).filter((r): r is Rect => !!r);
    if (rs.length) {
      const x0 = Math.min(...rs.map((r) => r.x));
      const y0 = Math.min(...rs.map((r) => r.y));
      const x1 = Math.max(...rs.map((r) => r.x + r.w));
      const y1 = Math.max(...rs.map((r) => r.y + r.h));
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

  private armDrag(
    e: PointerEvent,
    subject: DragSubject,
    label: string,
    sourceEl: HTMLElement,
  ): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    // Capture the pointer so that moving over an iframe doesn't swallow the events.
    const capturer = e.currentTarget as HTMLElement | null;
    capturer?.setPointerCapture(e.pointerId);
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

  private startDrag(subject: DragSubject, label: string, sourceEl: HTMLElement, win?: FloatingWindow): void {
    const ghost = document.createElement("div");
    ghost.className = "carreau-ghost";
    ghost.textContent = label;
    // A docking window follows the cursor itself: no label needed.
    if (win) ghost.style.display = "none";
    document.body.append(ghost);
    sourceEl.classList.add("carreau-drag-source");
    this.el.classList.add("is-dragging");
    this.drag = { subject, label, ghost, sourceEl, win, hoverPane: null, lines: [], tabBar: null, zones: null, inCenter: false, near: null, active: null };
  }

  private endDrag(commit: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.ghost.remove();
    d.sourceEl.classList.remove("carreau-drag-source");
    this.el.classList.remove("is-dragging");
    this.overlay.replaceChildren();
    if (commit && d.active) {
      const t = d.active.target;
      const rect = t.kind === "float" ? this.floatRect(t.paneId) ?? undefined : undefined;
      this.ws.commitDrop(d.active.result, d.win, rect);
    }
  }

  private dragMove(ev: PointerEvent): void {
    const d = this.drag!;
    d.lastEvent = ev;
    d.ghost.style.left = `${ev.clientX + 12}px`;
    d.ghost.style.top = `${ev.clientY + 8}px`;
    const base = this.el.getBoundingClientRect();
    const px = ev.clientX - base.left;
    const py = ev.clientY - base.top;

    // Which pane is under the cursor? Over a gap (splitter), keep the current one.
    let hover: string | null = null;
    for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
      const p = (el as HTMLElement).closest?.(".carreau-pane") as HTMLElement | null;
      if (p && (this.rootEl.contains(p) || this.floatLayer.contains(p))) {
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
      d.zones = hover ? this.buildZones(hover, d.subject) : null;
    }
    d.near = null;
    d.active = null;
    d.inCenter = false;
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
      } else if (d.zones && inRect(d.zones.rect, px, py)) {
        // The pane's own zones: thirds of the box. Edge thirds insert beside the pane
        // (corners go to the nearer edge); the center shows the swap icon.
        const Z = d.zones;
        const fx = (px - Z.rect.x) / Z.rect.w;
        const fy = (py - Z.rect.y) / Z.rect.h;
        const cands: [Side, number][] = [];
        if (fx < 1 / 3) cands.push(["left", fx]);
        if (fx > 2 / 3) cands.push(["right", 1 - fx]);
        if (fy < 1 / 3) cands.push(["top", fy]);
        if (fy > 2 / 3) cands.push(["bottom", 1 - fy]);
        if (cands.length) {
          cands.sort((a, b) => a[1] - b[1]);
          d.active = Z.sides[cands[0][0]] ?? null;
        } else {
          d.inCenter = true;
          if (Z.center && Math.hypot(px - Z.center.cx, py - Z.center.cy) <= Z.center.r) d.active = Z.center.choice;
        }
      }
    }
    this.drawOverlay();
  }

  private inLine(line: SideLine, px: number, py: number): boolean {
    const u = sideAxis[line.side] === "row" ? px : py;
    return u >= line.hit[0] && u <= line.hit[1];
  }

  /** The part of a node that is visible, i.e. not scrolled out of its scroll ancestors. */
  private visRect(id: string): Rect | null {
    const el = this.elOf(id);
    let r = this.pxRect(id);
    if (!el || !r) return null;
    const b = this.el.getBoundingClientRect();
    for (let p = el.parentElement; p && p !== this.rootEl && p !== this.floatLayer; p = p.parentElement) {
      if (!p.classList.contains("carreau-scroll")) continue;
      const c = p.getBoundingClientRect();
      r = intersect(r, { x: c.left - b.left, y: c.top - b.top, w: p.clientWidth, h: p.clientHeight });
      if (!r) return null;
    }
    return r;
  }

  private pxRect(id: string): Rect | null {
    const el = this.elOf(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const b = this.el.getBoundingClientRect();
    return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
  }

  /** Dots before the first tab, between tabs, and after the last tab. */
  private buildTabBar(paneId: string, subject: DragSubject): TabBar | null {
    const root = this.ws.treeOf(paneId) ?? this.ws.root;
    const paneEl = this.elOf(paneId)!;
    const tabs = [...paneEl.querySelectorAll<HTMLElement>(".carreau-tab")];
    const bar = paneEl.querySelector<HTMLElement>(".carreau-tabbar")!;
    const b = this.el.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const rects = tabs.map((t) => t.getBoundingClientRect());
    const xs = rects.length ? [rects[0].left, ...rects.map((r) => r.right)] : [br.left + 24];
    const y = br.top + br.height / 2 - b.top;
    // The tab bar may be (partly) scrolled out of view.
    const visible = this.visRect(paneId);
    const barRect = visible && intersect({ x: br.left - b.left, y: br.top - b.top, w: br.width, h: br.height }, visible);
    if (!barRect) return null;
    const dots: TabDot[] = [];
    xs.forEach((cx, index) => {
      if (cx > br.right - 4) return; // overflowed out of the bar
      if (cx - b.left < barRect.x - 1 || cx - b.left > barRect.x + barRect.w + 1) return; // scrolled out
      const target: DropTarget = { kind: "tab", paneId, index };
      const result = this.tryDrop(subject, target);
      dots.push({
        choice: result ? { target, result, ownerId: paneId, span: [cx, cx] } : null,
        x: cx - b.left,
        y,
      });
    });
    return { rect: barRect, dots };
  }

  private buildZones(paneId: string, subject: DragSubject): Zones | null {
    const root = this.ws.treeOf(paneId) ?? this.ws.root;
    const rect = this.visRect(paneId);
    if (!rect) return null;
    const sides: Zones["sides"] = {};
    for (const side of SIDES) {
      const target: DropTarget = { kind: "side", targetId: paneId, side };
      const result = this.tryDrop(subject, target);
      if (result) sides[side] = { target, result, ownerId: paneId, span: [0, 0] };
    }
    // Over its own pane, the center floats the dragged thing; elsewhere it swaps.
    const own =
      (subject.kind === "pane" && subject.paneId === paneId) ||
      (subject.kind === "tab" && findTab(root, subject.tabId)?.pane.id === paneId);
    const kind = own ? "float" : "swap";
    const target: DropTarget = { kind, paneId };
    const result = this.tryDrop(subject, target);
    const center = result
      ? { kind, choice: { target, result, ownerId: paneId, span: [0, 0] as [number, number] }, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, r: SWAP_R } as Zones["center"]
      : null;
    return { rect, sides, center };
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
    const root = this.ws.treeOf(paneId) ?? this.ws.root;
    const P = this.pxRect(paneId);
    const Pvis = this.visRect(paneId);
    if (!P || !Pvis) return [];
    const lines: SideLine[] = [];
    const edgeOf = (r: Rect, side: Side) =>
      side === "left" ? r.x : side === "right" ? r.x + r.w : side === "top" ? r.y : r.y + r.h;

    for (const side of onlySide ? [onlySide] : SIDES) {
      const axis = sideAxis[side];
      const start = sideIsStart[side];
      const horizontal = axis === "row";
      // A border scrolled out of view gets no line.
      if (Math.abs(edgeOf(P, side) - edgeOf(Pvis, side)) > 0.5) continue;
      // Spans are compared on full rects (to tell boundaries apart) but drawn clipped to
      // what is visible.
      const spanOf = (r: Rect | null): [number, number] | null =>
        r ? (horizontal ? [r.y, r.y + r.h] : [r.x, r.x + r.w]) : null;
      const span = (id: string) => spanOf(this.visRect(id));
      const fullSpan = (id: string) => spanOf(this.pxRect(id));

      const chain: LayoutNode[] = [];
      let between: { split: SplitNode; index: number; before: LayoutNode; after: LayoutNode } | null = null;
      let x: LayoutNode = find(root, paneId)!.node;
      for (;;) {
        chain.unshift(x);
        const loc = find(root, x.id)!;
        if (!loc.parent) break;
        if (axisOf(loc.parent.type) === axis) {
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
        const result = this.tryDrop(subject, target);
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
      // The pane's own boundary (and any ancestor sharing exactly that boundary) is left
      // out: the pane's edge thirds already offer it. Lines only show enclosing groups.
      let group: { span: [number, number]; best: Choice | null; self: boolean } | null = null;
      const flush = () => {
        if (group?.best && !group.self) levels.push(group.best);
      };
      for (const n of rest) {
        const full = fullSpan(n.id);
        const sp = span(n.id);
        if (!full || !sp) continue;
        if (!group || Math.abs(full[0] - group.span[0]) > 1 || Math.abs(full[1] - group.span[1]) > 1) {
          flush();
          group = { span: full, best: null, self: false };
        }
        if (n.id === paneId) group.self = true;
        const target: DropTarget = { kind: "side", targetId: n.id, side };
        const result = this.tryDrop(subject, target);
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
          const Qvis = this.visRect(q.id);
          if (!Q || !Qvis) continue;
          const facing =
            otherSide === "left" ? Q.x : otherSide === "right" ? Q.x + Q.w
              : otherSide === "top" ? Q.y : Q.y + Q.h;
          if (Math.abs(facing - otherEdge) > 1.5) continue;
          const qs: [number, number] = horizontal ? [Qvis.y, Qvis.y + Qvis.h] : [Qvis.x, Qvis.x + Qvis.w];
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
      if (t.kind === "tab" || t.kind === "swap") r = null; // dot / swap outlines are the preview
      else if (t.kind === "float") r = this.floatRect(t.paneId); // where the window will appear
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
      } else if (t.kind === "between" && d.active.straddle) {
        // Straddle the boundary: last third of the node before, first third of the one after.
        const a = this.pxRect(d.active.straddle[0])!;
        const b = this.pxRect(d.active.straddle[1])!;
        const split = find(this.ws.treeOf(t.splitId) ?? this.ws.root, t.splitId)!.node;
        r =
          split.type !== "pane" && axisOf(split.type) === "row"
            ? { x: a.x + (a.w * 2) / 3, y: a.y, w: b.x + b.w / 3 - (a.x + (a.w * 2) / 3), h: a.h }
            : { x: a.x, y: a.y + (a.h * 2) / 3, w: a.w, h: b.y + b.h / 3 - (a.y + (a.h * 2) / 3) };
      }
      // Clip to what is visible of the nodes involved.
      if (t.kind !== "float") {
        const clipId = t.kind === "side" ? t.targetId : t.kind === "between" ? t.splitId : null;
        const clipR = clipId ? this.visRect(clipId) : null;
        r = r && clipR ? intersect(r, clipR) : null;
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

    // Swap: outline both panes that trade contents.
    if (d.active?.target.kind === "swap") {
      const src =
        d.subject.kind === "pane" ? d.subject.paneId
          : d.subject.kind === "tab"
            ? this.ws.trees().map((tr) => findTab(tr, (d.subject as { tabId: string }).tabId)).find(Boolean)?.pane.id
            : undefined;
      for (const id of [d.active.target.paneId, src]) {
        const r = id ? this.visRect(id) : null;
        if (r)
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
    // Center icon (swap, or float over its own pane), while in the center third of a pane.
    if (d.inCenter && d.zones?.center) {
      const { cx, cy, r, choice, kind } = d.zones.center;
      const active = d.active === choice;
      const g = mk("g", { class: "carreau-indicator carreau-swap" + (active ? " active" : "") });
      mk("circle", {
        cx, cy, r: active ? r + 3 : r,
        fill: accent(choice.ownerId, active ? 0.95 : 0.7, active ? 0.8 : 0.62),
        stroke: "#0009", "stroke-width": 1,
      }, g);
      if (kind === "float") {
        // A cloud: overlapping circles over a flat base.
        for (const [x, y, rr] of [[-6, 2, 5.5], [1, -3, 7.5], [8, 2, 5.5]] as const)
          mk("circle", { cx: cx + x, cy: cy + y, r: rr, fill: "#111" }, g);
        mk("rect", { x: cx - 6, y: cy + 2, width: 14, height: 5.5, fill: "#111" }, g);
        return;
      }
      // Two opposed arrows.
      const a = r * 0.5;
      const arrow = (y: number, dir: 1 | -1) =>
        `M ${cx - dir * a} ${y} L ${cx + dir * a} ${y} M ${cx + dir * a - dir * 6} ${y - 5} L ${cx + dir * a} ${y} L ${cx + dir * a - dir * 6} ${y + 5}`;
      mk("path", {
        d: `${arrow(cy - 6, 1)} ${arrow(cy + 6, -1)}`,
        stroke: "#111", "stroke-width": 2.5, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round",
      }, g);
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


function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Move a node, preserving its state (iframes, focus, ...) where `moveBefore` exists. */
function move(parent: HTMLElement, node: HTMLElement): void {
  const p = parent as HTMLElement & { moveBefore?: (n: Node, ref: Node | null) => void };
  if (p.moveBefore && node.isConnected && parent.isConnected) {
    try {
      p.moveBefore(node, null);
      return;
    } catch {
      // fall through
    }
  }
  parent.appendChild(node);
}

export const hasMoveBefore = typeof (Element.prototype as { moveBefore?: unknown }).moveBefore === "function";

function firstPaneId(n: LayoutNode): string {
  return n.type === "pane" ? n.id : firstPaneId(n.children[0]);
}
