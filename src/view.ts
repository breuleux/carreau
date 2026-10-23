// DOM rendering: layout (through node kinds and the contexts they give their children),
// persistent tab contents, floating windows, the pane menu, in-place editing, and CSS-only
// selection & maximization. Drag & drop is in dnd.ts.

import { cellAccent } from "./colors";
import { DndHost, DragDrop, LINK_PATHS } from "./dnd";
import {
  Ctx,
  FloatingWindow,
  LayoutNode,
  PaneNode,
  Rect,
  SplitNode,
  Tab,
  activeGroup,
  clamp,
  complexAt,
  complexType,
  find,
  intersect,
  isCell,
  isSplit,
  isSticky,
  kind,
  panes,
  paneDisplay,
  pathTo,
  rootCtx,
  shownIndex,
  union,
} from "./model";
import { Workspace } from "./workspace";

export { cellAccent } from "./colors";

export interface ViewOptions {
  /** Content of a tab body. */
  renderTab?: (tab: PaneNode["tabs"][number], pane: PaneNode) => HTMLElement | string;
  /**
   * Content of an empty pane's body (a named one stays, empty), instead of the hint; null: the
   * hint. Made once per pane and kept while it stays empty (like a tab's content).
   */
  renderEmpty?: (pane: PaneNode) => HTMLElement | null;
}

/** A menu's item: an action, or a "Send to" submenu (for a tab or a pane, by id). */
type MenuItem = { label: string; enabled?: boolean; run: () => void } | { label: string; sendTo: string };

/** How the view renders a leaf node type other than panes (see `registerRenderer`). */
export interface NodeRenderer {
  /** Fill the node's element (made by the view: it has the node's id, flex and size classes). */
  fill(el: HTMLElement, node: LayoutNode, view: View, ctx: Ctx): void;
  /**
   * Once the new tree is attached (the old one still is): place persistent elements into the
   * node's element (`view.persist`), so that their state survives re-renders.
   */
  attached?(el: HTMLElement, node: LayoutNode, view: View): void;
  /** Leaving navigation mode with the node selected: give it the keyboard focus. */
  commitFocus?(node: LayoutNode, view: View): void;
}

const RENDERERS: Record<string, NodeRenderer> = {};

/** Render a leaf node type (see `NodeTypes` in types.ts). */
export function registerRenderer(type: LayoutNode["type"], r: NodeRenderer): void {
  RENDERERS[type] = r;
}

/**
 * Elements created once and moved around across renders, never recreated (their state, e.g.
 * an iframe's, or what's typed in a field, survives). One that isn't placed during a render
 * goes away after it.
 */
class Persistent {
  private els = new Map<string, HTMLElement>();
  private disposers = new Map<string, () => void>();
  private seen = new Set<string>();

  get(key: string): HTMLElement | undefined {
    return this.els.get(key);
  }

  /**
   * The element for `key` (made by `create` the first time), put into `parent`. `dispose`: run
   * when it goes away.
   */
  place<E extends HTMLElement>(key: string, parent: HTMLElement, create: () => E, dispose?: () => void): E {
    this.seen.add(key);
    let el = this.els.get(key) as E | undefined;
    if (!el) {
      el = create();
      this.els.set(key, el);
      if (dispose) this.disposers.set(key, dispose);
    }
    if (el.parentElement !== parent) move(parent, el);
    return el;
  }

  /** Remove the elements not placed since the last sweep. */
  sweep(): void {
    for (const [key, el] of this.els)
      if (!this.seen.has(key)) {
        el.remove();
        this.els.delete(key);
        this.disposers.get(key)?.();
        this.disposers.delete(key);
      }
    this.seen.clear();
  }
}

/** Docking a floating window: hold it still this long (ms), within this many pixels. */
const HOLD_TO_DOCK = 1000;
const HOLD_TOLERANCE = 4;
/** When the progress ring appears while holding still (ms). */
const HOLD_RING_DELAY = 150;
/** A cell of a scroll split (its direct child), and its element. */
interface ScrollCell {
  node: PaneNode | SplitNode;
  el: HTMLElement;
  /** the scroll split's axis */
  axis: "row" | "column";
}

/** Two presses on a cell's bar within this long (ms) are a double click. */
const DOUBLE_PRESS = 400;
/** A resized scroll-column cell's minimum height. */
const MIN_CELL = 40;
/** Minimum size of a floating window. */
const FLOAT_MIN_W = 160;
const FLOAT_MIN_H = 100;

export class View implements DndHost {
  readonly el: HTMLElement;
  readonly rootEl: HTMLElement;
  readonly floatLayer: HTMLElement;
  readonly overlay: SVGSVGElement;
  private selBox: HTMLElement;
  private opts: Required<Pick<ViewOptions, "renderTab">> & ViewOptions;
  readonly dnd: DragDrop;
  /** Navigation mode (driven by the keyboard controller). */
  private navMode: "off" | "held" | "sticky" = "off";
  private menu: HTMLElement | null = null;
  private menuAnchor: HTMLElement | null = null;
  /** One persistent element per tab, by tab id. */
  private contents = new Persistent();
  /** Other persistent elements, for renderers (`persist`). */
  private extras = new Persistent();
  /** Renderers' `attached` calls, for after the new tree is attached. */
  private pendingAttach: (() => void)[] = [];
  private renderingNow = false;
  /** A render was asked for during one: do it again after. */
  private renderAgain = false;
  /** The latest press on a cell's bar, to tell a double click (see `resizeCell`). */
  private lastBarPress: { id: string; t: number } | null = null;
  /** Last known scroll position of each scroll split / tab scroller, by node id. */
  private scrollPos = new Map<string, { left: number; top: number; atEnd: boolean }>();
  /** Keeps sticky (reverse) scroll splits at their end while their content grows. */
  private sticky = new ResizeObserver((entries) => {
    for (const e of entries) {
      // (The scroller itself, when its viewport changes size, or one of its children.)
      const t = e.target as HTMLElement;
      const sc = t.classList.contains("carreau-reverse") ? t : t.parentElement;
      if (sc && this.stuck(sc)) toEnd(sc);
    }
  });
  /** Keeps scroll splits' edge fades in line with what's scrolled off (content resizing). */
  private fader = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      updateFade(el.classList.contains("carreau-scroll") ? el : el.parentElement!);
    }
  });
  private lastSelection = "";
  private lastTab = "";

  /** The current drag, if any (for tests and debugging). */
  get drag() {
    return this.dnd.state;
  }

  /**
   * Whether a render is going on. Moving a focused text field re-focuses it (see `move`),
   * which fires its focus handlers: they should do nothing then (no re-render within a render).
   */
  get rendering(): boolean {
    return this.renderingNow;
  }

  /**
   * For renderers (in `attached`): a persistent element by key, put into `parent`. `dispose`:
   * run when it goes away (a render that doesn't place it).
   */
  persist<E extends HTMLElement>(key: string, parent: HTMLElement, create: () => E, dispose?: () => void): E {
    return this.extras.place(key, parent, create, dispose);
  }

  /** A renderer's persistent element, if it exists. */
  persisted(key: string): HTMLElement | undefined {
    return this.extras.get(key);
  }

  constructor(
    readonly ws: Workspace,
    host: HTMLElement,
    opts: ViewOptions = {},
  ) {
    this.opts = { ...opts, renderTab: opts.renderTab ?? ((t) => t.content ?? t.title) };
    const div = (cls: string) => Object.assign(document.createElement("div"), { className: cls });
    this.el = div("carreau");
    this.rootEl = div("carreau-root");
    this.selBox = div("carreau-selection");
    this.floatLayer = div("carreau-floats");
    this.overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.overlay.classList.add("carreau-overlay");
    this.el.append(this.rootEl, this.selBox, this.floatLayer, this.overlay);
    this.dnd = new DragDrop(this);
    host.append(this.el);

    // In navigation mode, pressing anywhere inside a pane drags it; anywhere inside a floating
    // window moves the window. (Capture phase: before the content.) Headers keep their usual
    // behaviour, and so do window resize handles.
    this.el.addEventListener(
      "pointerdown",
      (e) => {
        if (this.navMode === "off" || e.button !== 0) return;
        const t = e.target as HTMLElement;
        if (t.closest(".carreau-tabbar, .carreau-float-resize, .carreau-gutter, .carreau-cell-close")) return;
        const floatEl = t.closest<HTMLElement>(".carreau-float");
        if (floatEl) {
          const win = this.ws.floating[[...this.floatLayer.children].indexOf(floatEl)];
          if (win) {
            this.raiseFloat(win, floatEl);
            this.armFloatMove(e, win, floatEl);
          }
          return;
        }
        // (The innermost cell: a press on another kind of cell isn't one on its holder pane.)
        const paneEl = t.closest<HTMLElement>(".carreau-cell");
        const node = paneEl && this.ws.node(paneEl.dataset.id!);
        if (node?.type !== "pane") return;
        e.preventDefault();
        this.dnd.arm(e, { kind: "pane", paneId: node.id }, node.tabs[node.active]?.title ?? "pane", paneEl!, paneEl!);
      },
      { capture: true },
    );
    // Close the pane menu on any outside interaction (its anchor toggles it).
    window.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as Node;
        if (this.menu && !this.menu.contains(t) && !this.menuAnchor?.contains(t)) this.closeMenu();
      },
      { capture: true },
    );
    ws.onChange(() => this.render());
    new ResizeObserver(() => {
      // Keep floating windows inside a workspace that changed size.
      const els = [...this.floatLayer.children] as HTMLElement[];
      this.ws.floating.forEach((w, i) => els[i] && this.placeFloat(els[i], w));
      this.decorate();
    }).observe(this.el);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.dnd.cancel();
    });
    // Clicking into an iframe fires nothing here: the window loses focus and the iframe
    // becomes the active element. Select its pane.
    window.addEventListener("blur", () =>
      setTimeout(() => {
        const a = document.activeElement;
        if (a instanceof HTMLIFrameElement && this.el.contains(a)) {
          const id = (a.closest(".carreau-pane") as HTMLElement | null)?.dataset.id;
          if (id && this.ws.selection.id !== id) this.ws.select({ id });
        }
      }),
    );
    // Scrolling moves things around: refresh the outline, and the drop indicators.
    this.el.addEventListener(
      "scroll",
      (e) => {
        this.rememberScroll(e.target as HTMLElement);
        updateFade(e.target as HTMLElement);
        this.decorate();
        this.dnd.refresh();
      },
      { capture: true },
    );
    this.render();
  }

  // -------------------------------------------------------------------------
  // Geometry (DndHost)

  elOf(id: string): HTMLElement | null {
    const sel = `[data-id="${id}"]`;
    return this.rootEl.querySelector(sel) ?? this.floatLayer.querySelector(sel);
  }

  pxRect(id: string): Rect | null {
    const el = this.elOf(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const b = this.el.getBoundingClientRect();
    return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
  }

  /** The part of a node that is visible, i.e. not scrolled out of its scroll ancestors. */
  visRect(id: string): Rect | null {
    const el = this.elOf(id);
    let r = this.pxRect(id);
    if (!el || !r) return null;
    const b = this.el.getBoundingClientRect();
    for (let p = el.parentElement; p && p !== this.el; p = p.parentElement) {
      if (!p.classList.contains("carreau-scroll")) continue;
      const c = p.getBoundingClientRect();
      r = intersect(r, { x: c.left - b.left, y: c.top - b.top, w: p.clientWidth, h: p.clientHeight });
      if (!r) return null;
    }
    return r;
  }

  /** Where a pane floated out of the layout appears: its rect at 80%, centered on it. */
  floatRect(paneId: string): Rect | null {
    const r = this.pxRect(paneId);
    if (!r) return null;
    const w = Math.max(240, r.w * 0.8);
    const h = Math.max(160, r.h * 0.8);
    return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
  }

  // -------------------------------------------------------------------------
  // Rendering

  render(): void {
    // Asked for during a render (e.g. by a focus handler, as moving a focused element
    // re-focuses it): once it's done, not within it (its sweep would drop what the inner one
    // placed).
    if (this.renderingNow) {
      this.renderAgain = true;
      return;
    }
    do {
      this.renderAgain = false;
      this.renderingNow = true;
      this.pendingAttach = [];
      try {
        this.renderNow();
      } finally {
        this.renderingNow = false;
      }
    } while (this.renderAgain);
  }

  private renderNow(): void {
    // Carry scroll positions over (only visible elements: hidden ones read 0).
    for (const el of this.el.querySelectorAll<HTMLElement>(".carreau-scroll, .carreau-tabs"))
      if (el.getClientRects().length) this.rememberScroll(el);
    // Attach the new elements *before* removing the old ones, so that tab contents (iframes)
    // can be moved across while staying connected (moveBefore only preserves state then).
    const old = [...this.rootEl.childNodes, ...this.floatLayer.childNodes];
    const tree = this.renderNode(this.ws.root, rootCtx());
    const floats = this.ws.floating.map((w) => this.renderFloat(w));
    this.rootEl.append(tree);
    this.floatLayer.append(...floats);
    this.placeContents([tree, ...floats]);
    for (const fn of this.pendingAttach) fn();
    this.extras.sweep();
    for (const n of old) n.remove();
    this.restoreScroll();
    // Keep the selected tab (active tab of the focused pane) in view when it changes.
    const cur = this.ws.node(this.ws.selection.id);
    const tabKey = cur?.type === "pane" ? `${cur.id}:${cur.active}` : "";
    if (tabKey && tabKey !== this.lastTab) {
      const scroller = this.elOf(cur!.id)?.querySelector<HTMLElement>(".carreau-tabs");
      const tab = scroller?.querySelectorAll<HTMLElement>(":scope > .carreau-tab")[(cur as PaneNode).active];
      if (scroller && tab) {
        if (tab.offsetLeft < scroller.scrollLeft) scroller.scrollLeft = tab.offsetLeft;
        else if (tab.offsetLeft + tab.offsetWidth > scroller.scrollLeft + scroller.clientWidth)
          scroller.scrollLeft = tab.offsetLeft + tab.offsetWidth - scroller.clientWidth;
      }
    }
    this.lastTab = tabKey;
    this.decorate();
    // Bring a newly selected node into view (it may be scrolled out in a scroll split).
    const key = JSON.stringify(this.ws.selection);
    if (key !== this.lastSelection) {
      this.lastSelection = key;
      this.elOf(this.ws.selection.id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  private scrollKey(el: HTMLElement): string | null {
    // (A framed split's inner scroller is keyed by the split's id: `data-scroll`.)
    if (el.classList?.contains("carreau-scroll")) return el.dataset.scroll ?? el.dataset.id ?? null;
    if (el.classList?.contains("carreau-tabs")) return el.dataset.pane ? `tabs:${el.dataset.pane}` : null;
    return null;
  }

  private rememberScroll(el: HTMLElement): void {
    const key = this.scrollKey(el);
    if (!key) return;
    const prev = this.scrollPos.get(key);
    const pos = { left: el.scrollLeft, top: el.scrollTop };
    // Once at its end, a scroller stays there until scrolled back. Content growing below doesn't
    // unstick it, even if this is measured before the sticky observer catches up: `toEnd`'s
    // scroll event comes a frame later, and a render can measure in between, both possibly
    // after more content arrived (a terminal printing away at the bottom).
    const row = el.classList.contains("carreau-scroll-row");
    const held = !!prev?.atEnd && (row ? pos.left >= prev.left : pos.top >= prev.top);
    this.scrollPos.set(key, { ...pos, atEnd: held || atEnd(el) });
  }

  /** A sticky scroll split that should be at its end: it was (or it was never scrolled). */
  private stuck(el: HTMLElement): boolean {
    if (!el.classList.contains("carreau-reverse") || !el.getClientRects().length) return false;
    return this.scrollPos.get(this.scrollKey(el) ?? "")?.atEnd ?? true;
  }

  private restoreScroll(): void {
    this.sticky.disconnect();
    this.fader.disconnect();
    for (const el of this.el.querySelectorAll<HTMLElement>(".carreau-scroll, .carreau-tabs")) {
      if (el.classList.contains("carreau-reverse")) for (const c of [el, ...el.children]) this.sticky.observe(c);
      const pos = this.scrollPos.get(this.scrollKey(el) ?? "");
      if (this.stuck(el)) toEnd(el);
      else if (pos && el.getClientRects().length) [el.scrollLeft, el.scrollTop] = [pos.left, pos.top];
      if (el.classList.contains("carreau-scroll")) {
        for (const x of [el, ...el.children]) this.fader.observe(x);
        updateFade(el);
      }
    }
  }

  /**
   * Put every content tab's element into its pane's body; only the shown one shows (the active
   * tab's, or its complex's first one's: see `shownIndex`), updated by its complex type's `show`.
   */
  private placeContents(trees: HTMLElement[]): void {
    // The old elements are still attached: look panes up in the new ones only.
    const paneEls = new Map<string, HTMLElement>();
    for (const t of trees) for (const el of [t, ...t.querySelectorAll<HTMLElement>(".carreau-pane")]) if (el.classList.contains("carreau-pane")) paneEls.set(el.dataset.id!, el);
    for (const p of this.ws.trees().flatMap((t) => panes(t))) {
      const body = paneEls.get(p.id)?.querySelector<HTMLElement>(":scope > .carreau-body");
      if (!body) continue;
      const shown = shownIndex(p);
      p.tabs.forEach((tab, i) => {
        if (tab.group) return; // group tabs show a layout, rendered with the pane
        const el = this.contents.place(tab.id, body, () => {
          const el = Object.assign(document.createElement("div"), { className: "carreau-content" });
          el.dataset.tab = tab.id;
          el.style.setProperty("--accent", cellAccent(tab));
          const c = this.opts.renderTab(tab, p);
          if (typeof c === "string") el.textContent = c;
          else el.append(c);
          return el;
        });
        el.hidden = i !== shown;
        if (i === shown) {
          const c = complexAt(p, i);
          complexType(c.key)?.show?.(c, el);
        }
      });
    }
    this.contents.sweep();
  }

  /**
   * Render a node, given the context its parent gave it (see kinds.ts). `cell`: the scroll
   * split's cell it is in (through splits), if any: see `decorateScrollCell`.
   */
  private renderNode(node: LayoutNode, ctx: Ctx, cell?: ScrollCell): HTMLElement {
    const el = document.createElement("div");
    el.dataset.id = node.id;
    el.style.flex = ctx.sizedAlong ? "none" : `${node.weight} 1 0`;
    if (ctx.sizedAlong) el.classList.add(`carreau-natural-${ctx.sizedAlong}`);
    if (isCell(node)) el.classList.add("carreau-cell");
    // A direct child of a scroll split is one of its cells (a pane, or a split of panes). In a
    // scroll-column, its height can be set (`size`): by any of its panes' bars.
    if (ctx.cellOf && (node.type === "pane" || isSplit(node))) {
      cell = { node, el, axis: ctx.cellOf };
      if (ctx.cellOf === "column" && node.size) {
        el.style.height = `${node.size}px`;
        el.classList.add("carreau-cell-sized");
      }
    }
    if (node.type === "pane") this.fillPane(el, node, ctx, cell);
    else if (isSplit(node)) this.fillSplit(el, node, ctx, cell);
    else {
      const r = RENDERERS[(node as LayoutNode).type];
      if (!r) throw new Error(`No renderer for ${(node as LayoutNode).type} (see registerRenderer)`);
      r.fill(el, node, this, ctx);
      if (r.attached) this.pendingAttach.push(() => r.attached!(el, node, this));
    }
    return el;
  }

  private fillSplit(el: HTMLElement, node: SplitNode, ctx: Ctx, cell?: ScrollCell): void {
    const k = kind(node);
    el.classList.add("carreau-split", `carreau-${k.axis}`);
    const childCtx = k.childContext(node, ctx);
    // A scroll split is a frame that doesn't scroll (with the panel's look), holding an inner
    // element that scrolls (its edges fade where there's more: see `updateFade`). The inner
    // element keeps the scroll position, by the split's id (`data-scroll`). A fixed last child
    // sits below the inner element, outside, so that it stays put (overscroll bounce included).
    const fixed = k.lastFixed ? node.children[node.children.length - 1] : undefined;
    const kids = fixed ? node.children.slice(0, -1) : node.children;
    let scroller = el;
    if (k.scroll || fixed) {
      el.classList.add("carreau-framed");
      scroller = Object.assign(document.createElement("div"), { className: `carreau-split carreau-${k.axis} carreau-frame-inner` });
      scroller.dataset.scroll = node.id;
      el.append(scroller);
    }
    if (k.scroll) scroller.classList.add("carreau-scroll", `carreau-scroll-${k.axis}`);
    if (isSticky(node)) scroller.classList.add("carreau-reverse");
    kids.forEach((c, i) => {
      // Children sized by their content get a fixed gap; others, a splitter.
      if (i > 0) scroller.append(childCtx.sizedAlong ? Object.assign(document.createElement("div"), { className: "carreau-gap" }) : this.renderSplitter(node, i));
      scroller.append(this.renderNode(c, childCtx, cell));
    });
    if (fixed) el.append(this.renderNode(fixed, childCtx));
  }

  /** A pane: its tab bar (at the bottom) and body. It decides its display from its context. */
  private fillPane(el: HTMLElement, node: PaneNode, ctx: Ctx, cell?: ScrollCell): void {
    el.classList.add("carreau-pane");
    const display = paneDisplay(node, ctx);
    const activeTab = node.tabs[node.active];
    if (activeTab) el.style.setProperty("--focus-accent", cellAccent(activeTab));
    if (cell) this.decorateScrollCell(el, node, cell);
    const bar = this.renderTabBar(node, ctx);
    if (!display.showTabBar) {
      bar.hidden = true;
      el.classList.add("no-tabbar");
    }
    el.append(bar);
    const body = Object.assign(document.createElement("div"), { className: "carreau-body" });
    // With no tab bar, a strip on top (the cell's `long`, or an empty one) is the handle.
    if (activeTab && ((display.showLong && activeTab.long) || !display.showTabBar)) {
      const long = Object.assign(document.createElement("div"), { className: "carreau-long", title: "Drag to move this pane" });
      if (display.showLong && activeTab.long) long.innerHTML = activeTab.long;
      else long.classList.add("empty");
      // No tab bar: the closing indicator goes on the strip.
      const closingTab = node.tabs.find((t) => this.ws.isClosing(t.id));
      if (closingTab) {
        long.classList.add("closing");
        long.append(this.closingSpinner(closingTab.id));
      }
      long.style.setProperty("--cell-accent", cellAccent(activeTab));
      long.addEventListener("pointerdown", (e) => this.dnd.arm(e, { kind: "pane", paneId: node.id }, activeTab.title, el));
      body.append(long);
    }
    // Group tabs: their layouts, all rendered (inactive ones hidden, so that the contents
    // inside stay in the document). Content tabs are placed by placeContents().
    const childCtx = kind(node).childContext(node, ctx);
    node.tabs.forEach((t, i) => {
      const inner = t.group?.children[0];
      if (!inner) return;
      const g = Object.assign(document.createElement("div"), { className: "carreau-group", hidden: i !== shownIndex(node) });
      g.dataset.groupTab = t.id;
      g.classList.toggle("natural-row", ctx.natural.row);
      g.classList.toggle("natural-column", ctx.natural.column);
      g.append(this.renderNode(inner, kind(t.group!).childContext(t.group!, childCtx)));
      body.append(g);
    });
    body.classList.toggle("shows-group", !!activeGroup(node));
    // An empty pane (a named one stays, empty): a hint.
    if (!node.tabs.length) {
      const own = this.opts.renderEmpty;
      if (own) this.persist(`empty:${node.id}`, body, () => own(node) ?? hint());
      else body.append(hint());
    }
    el.append(body);
    el.addEventListener("pointerdown", (e) => {
      // Primary button only (selecting re-renders, which would break a middle click), and
      // only the innermost cell (presses bubble through group holders too; other kinds of
      // cells in the group select themselves).
      if (e.button !== 0 || (e.target as HTMLElement).closest(".carreau-cell") !== el) return;
      if (this.ws.selection.id !== node.id) this.ws.select({ id: node.id });
    });
  }

  /**
   * A pane in a cell of a scroll split (the cell itself, or in a split that is the cell): an
   * accent bar on the left, with its status on top (like buche's echo-box), and a close button
   * at the top right. In a scroll-column, the bar resizes the cell (all the bars of a split
   * cell resize the same cell, so they stay in sync): dragging outward (up from its top half,
   * down from its bottom half) grows it, inward shrinks it, and the dragged edge stays put on
   * screen. Double-click: back to its natural height.
   */
  private decorateScrollCell(el: HTMLElement, node: PaneNode, cell: ScrollCell): void {
    el.classList.add("carreau-scrollcell", `carreau-scrollcell-${cell.axis}`);
    const status = node.tabs[node.active]?.status;
    if (status) el.dataset.status = status;
    const gutter = Object.assign(document.createElement("div"), { className: "carreau-gutter" });
    gutter.append(Object.assign(document.createElement("div"), { className: "carreau-gutter-status" }));
    el.append(gutter);
    if (cell.axis === "column") {
      gutter.classList.add("resizes");
      gutter.title = "Drag to resize; double-click: natural height";
      gutter.addEventListener("pointerdown", (e) => this.resizeCell(e, cell, gutter));
    }
    if (this.ws.canClosePane(node.id) && !node.tabs.some((t) => this.ws.isClosing(t.id))) {
      const close = Object.assign(document.createElement("span"), { className: "carreau-cell-close", title: "Close" });
      close.addEventListener("pointerdown", (e) => e.stopPropagation()); // not a drag, nor a selection
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.ws.closePane(node.id);
      });
      el.append(close);
    }
  }

  /**
   * Drag a bar in a scroll-column's cell: resize the cell (see `decorateScrollCell`). A double
   * press (a double click) puts it back to its natural height. (Detected here, by the cell, not
   * by `dblclick`: a re-render between the two presses would replace the bar.)
   */
  private resizeCell(e: PointerEvent, cell: ScrollCell, gutter: HTMLElement): void {
    const { el, node } = cell;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    const last = this.lastBarPress;
    this.lastBarPress = { id: node.id, t: now };
    if (last?.id === node.id && now - last.t < DOUBLE_PRESS) {
      this.lastBarPress = null;
      if (node.size === undefined) return;
      // (Its own undo step: not merged with a drag of the bar just before.)
      const token = this.ws.beginResize(`cell-reset:${node.id}`);
      delete node.size;
      this.ws.endResize(token);
      this.ws.emit();
      return;
    }
    gutter.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const startHeight = node.size ?? rect.height;
    // From the top half, up is outward; from the bottom half, down is.
    const topHalf = startY < rect.top + rect.height / 2;
    const sign = topHalf ? 1 : -1;
    // The dragged half stays put: measure the anchored edge, and scroll away its drift.
    const scroller = el.closest<HTMLElement>(".carreau-scroll");
    const anchorEdge = () => (topHalf ? el.getBoundingClientRect().bottom : el.getBoundingClientRect().top);
    let anchor = anchorEdge();
    const token = this.ws.beginResize(`cell:${node.id}`);
    this.el.classList.add("is-resizing");
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      const h = Math.max(MIN_CELL, Math.round(startHeight + (startY - ev.clientY) * sign));
      node.size = h;
      el.style.height = `${h}px`;
      el.classList.add("carreau-cell-sized");
      if (scroller && scroller.scrollHeight > scroller.clientHeight) scroller.scrollTop += anchorEdge() - anchor;
      else anchor = anchorEdge(); // (not scrollable: the browser holds the view)
      this.decorate();
    };
    const up = () => {
      gutter.removeEventListener("pointermove", move);
      gutter.removeEventListener("pointerup", up);
      gutter.removeEventListener("pointercancel", up);
      this.el.classList.remove("is-resizing");
      if (!moved) return; // a mere press (maybe half a double click): nothing to re-render
      this.ws.endResize(token);
      this.ws.emit();
    };
    gutter.addEventListener("pointermove", move);
    gutter.addEventListener("pointerup", up);
    gutter.addEventListener("pointercancel", up);
  }

  private renderTabBar(node: PaneNode, ctx: Ctx): HTMLElement {
    const bar = Object.assign(document.createElement("div"), { className: "carreau-tabbar" });
    // Tabs never shrink: they scroll horizontally (scrollbar hidden), with shadows.
    const wrap = Object.assign(document.createElement("div"), { className: "carreau-tabs-wrap" });
    const scroller = Object.assign(document.createElement("div"), { className: "carreau-tabs" });
    scroller.dataset.pane = node.id;
    scroller.addEventListener("scroll", () => updateTabShadows(scroller));
    scroller.addEventListener(
      "wheel",
      (e) => {
        // A plain mouse wheel scrolls the tabs sideways.
        if (e.deltaX !== 0 || scroller.scrollWidth <= scroller.clientWidth) return;
        scroller.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
    wrap.append(scroller);
    // Its name, if it has one: left of the tabs (double-click: edit it). It's a handle, like the
    // header's empty part.
    if (node.name) {
      const name = Object.assign(document.createElement("span"), { className: "carreau-pane-name", textContent: node.name, title: `${node.name} (double-click to rename)` });
      name.addEventListener("pointerdown", (e) => this.dnd.arm(e, { kind: "pane", paneId: node.id }, node.name!, bar.parentElement!));
      name.addEventListener("dblclick", () => this.editPaneName(node.id));
      bar.append(name);
    }
    bar.append(wrap);
    node.tabs.forEach((t, i) => {
      // Merged tabs (a complex): a link icon between them, which drags the whole complex.
      if (i > 0 && t.link && t.link === node.tabs[i - 1].link) {
        const link = linkIcon();
        const members = complexAt(node, i).tabs;
        link.addEventListener("pointerdown", (e) => this.dnd.arm(e, { kind: "complex", link: t.link! }, members.map((m) => m.title).join(" + "), link));
        scroller.append(link);
      }
      scroller.append(this.renderTab(node, t, i, ctx));
    });
    // The empty part of the header moves the pane.
    const space = Object.assign(document.createElement("div"), { className: "carreau-tabspace", title: "Drag to move this pane" });
    space.addEventListener("pointerdown", (e) => this.dnd.arm(e, { kind: "pane", paneId: node.id }, node.tabs[node.active]?.title ?? node.name ?? "pane", bar.parentElement!));
    bar.append(space);
    if (!ctx.floating) {
      // "More" button at the right end: opens the pane menu.
      const more = Object.assign(document.createElement("div"), { className: "carreau-more", title: "Pane options", textContent: "⋯" });
      more.addEventListener("pointerdown", (e) => e.stopPropagation());
      more.addEventListener("click", () => (this.menuAnchor === more ? this.closeMenu() : this.openMenu(more, node)));
      bar.append(more);
    }
    return bar;
  }

  /** A tab: [icon][short][×]. The status changes how the icon looks (see the CSS). */
  private renderTab(node: PaneNode, t: PaneNode["tabs"][number], i: number, ctx: Ctx): HTMLElement {
    const tab = Object.assign(document.createElement("div"), { className: "carreau-tab" + (i === node.active ? " active" : "") });
    tab.dataset.tab = t.id;
    const icon = t.icon ?? (t.group ? "▦" : null);
    if (icon) tab.append(Object.assign(document.createElement("span"), { className: "carreau-tab-icon", innerHTML: icon }));
    const short = Object.assign(document.createElement("span"), { className: "carreau-tab-short" });
    if (t.short) short.innerHTML = t.short;
    else short.textContent = t.title;
    tab.append(short);
    if (t.group) tab.classList.add("is-group");
    if (t.link && complexAt(node, i).tabs.length > 1) tab.classList.add("linked");
    if (t.status) tab.classList.add(`status-${t.status}`);
    tab.style.setProperty("--tab-accent", cellAccent(t));
    if (this.ws.isClosing(t.id)) {
      tab.classList.add("closing");
      tab.append(this.closingSpinner(t.id));
    } else if (this.ws.canCloseTab(t.id)) {
      const close = Object.assign(document.createElement("span"), { className: "carreau-tab-close", title: "Close tab" });
      close.addEventListener("pointerdown", (e) => e.stopPropagation()); // not a drag
      close.addEventListener("click", (e) => {
        e.stopPropagation(); // not an activation
        this.ws.closeTab(t.id);
      });
      tab.append(close);
    }
    tab.addEventListener("auxclick", (e) => e.button === 1 && this.ws.closeTab(t.id)); // middle click
    tab.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault()); // no autoscroll
    tab.addEventListener("click", () => {
      this.ws.activateTab(node.id, i);
      this.focusShownGroup(node.id);
    });
    // Right click: the tab's menu (close, send to, collapse its group).
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openTabMenu(e, node, t);
    });
    tab.addEventListener("pointerdown", (e) => this.dnd.arm(e, { kind: "tab", tabId: t.id }, t.title, tab));
    if (!ctx.floating)
      // Double click: maximize the pane (or restore it if it already is).
      tab.addEventListener("dblclick", () => {
        this.ws.select({ id: node.id });
        if (this.ws.maximized?.id === node.id && !this.ws.maximized.range) this.ws.restore();
        else this.ws.maximize();
      });
    return tab;
  }

  /**
   * Shown instead of a tab's × while it closes: a rotating arc. Hovered, it shows a red ×:
   * clicking it closes forcefully, without waiting.
   */
  private closingSpinner(tabId: string): HTMLElement {
    const s = Object.assign(document.createElement("span"), { className: "carreau-closing", title: "Closing… click to force close" });
    // Re-rendering recreates it: keep the rotation continuous, in phase with the clock.
    s.style.setProperty("--phase", `-${performance.now() % 900}ms`);
    s.addEventListener("pointerdown", (e) => e.stopPropagation()); // not a drag
    s.addEventListener("click", (e) => {
      e.stopPropagation();
      this.ws.forceClose(tabId);
    });
    return s;
  }

  private renderSplitter(parent: SplitNode, i: number): HTMLElement {
    const s = Object.assign(document.createElement("div"), { className: "carreau-splitter" });
    s.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const [a, b] = [parent.children[i - 1], parent.children[i]];
      const [ea, eb] = [this.elOf(a.id)!, this.elOf(b.id)!];
      const horiz = kind(parent).axis === "row";
      const size = (el: HTMLElement) => (horiz ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);
      const [pa, pb] = [size(ea), size(eb)];
      const wTot = a.weight + b.weight;
      const start = horiz ? e.clientX : e.clientY;
      s.setPointerCapture(e.pointerId);
      this.el.classList.add("is-resizing");
      // Undoable; consecutive resizes of this same splitter coalesce into one step.
      const token = this.ws.beginResize(`${parent.id}:${i}`);
      const move = (ev: PointerEvent) => {
        const na = clamp(pa + (horiz ? ev.clientX : ev.clientY) - start, 30, pa + pb - 30);
        a.weight = (wTot * na) / (pa + pb);
        b.weight = wTot - a.weight;
        ea.style.flex = `${a.weight} 1 0`;
        eb.style.flex = `${b.weight} 1 0`;
        this.decorate();
      };
      const up = () => {
        this.el.classList.remove("is-resizing");
        this.ws.endResize(token);
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
    for (const sc of this.el.querySelectorAll<HTMLElement>(".carreau-tabs")) updateTabShadows(sc);
    for (const el of this.el.querySelectorAll(".max-hidden, .max-path, .max-through, .selected, .secondary, .focus-path"))
      el.classList.remove("max-hidden", "max-path", "max-through", "selected", "secondary", "focus-path");
    const max = this.ws.maximized;
    this.el.classList.toggle("is-maximized", !!max);
    if (max) {
      const path = pathTo(this.ws.root, max.id) ?? [];
      const keep = new Set(path.map((n) => n.id));
      const hide = (id: string) => this.elOf(id)?.classList.add("max-hidden");
      const target = path[path.length - 1];
      if (target && isSplit(target) && max.range)
        target.children.forEach((c, i) => (i < max.range![0] || i > max.range![1]) && hide(c.id));
      for (const n of path.slice(0, -1)) {
        // A group's holder the maximization passes through: only its group's part shows.
        if (n.type === "pane") this.elOf(n.id)?.classList.add("max-through");
        else if (isSplit(n)) for (const c of n.children) if (!keep.has(c.id)) hide(c.id);
      }
      for (const n of path) this.elOf(n.id)?.classList.add("max-path");
    }
    // Splitters next to hidden children are hidden too.
    for (const s of this.rootEl.querySelectorAll<HTMLElement>(".carreau-splitter"))
      s.classList.toggle("max-hidden", !!max && !![s.previousElementSibling, s.nextElementSibling].some((x) => x?.classList.contains("max-hidden")));

    // Selection outline (rows, columns, ranges; a selected pane shows by its tab accent),
    // over the visible parts.
    const nodes = this.ws.selectedNodes();
    const r = union(nodes.map((n) => this.visRect(n.id)).filter((r): r is Rect => !!r));
    const sel = this.ws.selection;
    const selNode = this.ws.node(sel.id);
    const kindName = sel.range ? "range" : (selNode?.type ?? "");
    // A cell shows its focus itself (a pane by its tab line): no box for it.
    const box = r && (sel.range || (selNode && !isCell(selNode)));
    Object.assign(this.selBox.style, box ? { display: "block", left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } : { display: "none" });
    this.selBox.dataset.kind = kindName;
    this.selBox.classList.toggle("in-float", !find(this.ws.root, sel.id));
    for (const n of nodes) this.elOf(n.id)?.classList.add("selected");
    // The panes holding the groups the selection is in: their tabs show the focus too.
    const tree = this.ws.treeOf(sel.id);
    for (const n of (tree && pathTo(tree, sel.id)?.slice(0, -1)) ?? []) if (n.type === "pane") this.elOf(n.id)?.classList.add("focus-path");
    // Marks (stored selections): numbered, in the order marked, on the tab (or the pane's tab
    // bar); where the tab bar is hidden, on the cell's long strip.
    for (const el of this.el.querySelectorAll("[data-mark]")) el.removeAttribute("data-mark");
    this.ws.validMarks().forEach((id, i) => {
      const mark = String(i + 1);
      const tabEl = this.el.querySelector<HTMLElement>(`.carreau-tab[data-tab="${id}"]`);
      const paneEl = tabEl ? tabEl.closest<HTMLElement>(".carreau-pane") : this.elOf(id);
      if (tabEl && !tabEl.closest<HTMLElement>(".carreau-tabbar")!.hidden) tabEl.dataset.mark = mark;
      else if (!tabEl && paneEl?.querySelector<HTMLElement>(":scope > .carreau-tabbar:not([hidden])")) paneEl.querySelector<HTMLElement>(":scope > .carreau-tabbar")!.dataset.mark = mark;
      else {
        const strip = paneEl?.querySelector<HTMLElement>(":scope > .carreau-body > .carreau-long");
        if (strip) strip.dataset.mark = mark;
      }
    });
    // What cell operations act on, if not the selection (see `Workspace.operand`): shown in
    // navigation mode, as a secondary focus.
    const op = this.ws.operand();
    if (op && (op.id !== sel.id || op.range?.join() !== sel.range?.join()))
      for (const n of this.ws.selectedNodes(op)) this.elOf(n.id)?.classList.add("secondary");
  }

  // -------------------------------------------------------------------------
  // Pane menu, in-place editing, navigation mode

  /** The pane menu (its ⋯ button). */
  private openMenu(anchor: HTMLElement, node: PaneNode): void {
    const items: MenuItem[] = [
      { label: "Float", enabled: panes(this.ws.root).length > 1 && !!find(this.ws.root, node.id), run: () => this.floatPane(node.id) },
    ];
    if (this.ws.canCollapse(node.id)) items.push({ label: "Collapse group", run: () => this.ws.collapse(node.id) });
    items.push({ label: "Close pane", enabled: this.ws.canClosePane(node.id), run: () => this.ws.closePane(node.id) });
    const sc = this.ws.scrollOf(node.id);
    if (sc && !kind(sc).alwaysSticky) {
      const [start, end] = kind(sc).axis === "row" ? ["left", "right"] : ["top", "bottom"];
      items.push({ label: `Stick to ${sc.reverse ? start : end}`, run: () => this.ws.toggleReverse(sc.id) });
    }
    items.push({ label: node.name ? "Rename pane…" : "Name pane…", run: () => this.editPaneName(node.id) });
    if (node.name) items.push({ label: "Remove name", run: () => this.ws.namePane(node.id, null) });
    items.push({ label: "Send to", sendTo: node.id });
    // The header is at the bottom of panes: open upwards.
    const g = anchor.getBoundingClientRect();
    const b = this.el.getBoundingClientRect();
    this.showMenu(items, { right: b.right - g.right, bottom: b.bottom - g.top + 2 }, anchor);
  }

  /** A tab's menu (right click): close it, send it somewhere, collapse its group. */
  private openTabMenu(e: MouseEvent, node: PaneNode, t: Tab): void {
    const items: MenuItem[] = [{ label: "Close tab", enabled: this.ws.canCloseTab(t.id), run: () => this.ws.closeTab(t.id) }];
    items.push({ label: "Send to", sendTo: t.id });
    if (t.group && this.ws.canCollapse(node.id)) items.push({ label: "Collapse group", run: () => this.ws.collapse(node.id) });
    const b = this.el.getBoundingClientRect();
    this.showMenu(items, { left: e.clientX - b.left, top: e.clientY - b.top });
  }

  /**
   * Show a menu, at a position in the workspace (from its left/top, or its right/bottom). A
   * "Send to" item opens a submenu: arrows (to the neighbour on that side), then the named
   * panes. `anchor`: the button that opened it (it toggles it).
   */
  private showMenu(items: MenuItem[], at: { left?: number; top?: number; right?: number; bottom?: number }, anchor?: HTMLElement): void {
    this.closeMenu();
    const menu = Object.assign(document.createElement("div"), { className: "carreau-menu" });
    const button = (label: string, enabled: boolean, run: () => void, cls = "") => {
      const b = Object.assign(document.createElement("button"), { textContent: label, disabled: !enabled, className: cls });
      b.addEventListener("click", () => {
        this.closeMenu();
        run();
      });
      return b;
    };
    for (const it of items) {
      if ("run" in it) menu.append(button(it.label, it.enabled !== false, it.run));
      else menu.append(this.sendToItem(it.label, it.sendTo, button));
    }
    for (const [k, v] of Object.entries(at)) if (v !== undefined) menu.style.setProperty(k, `${v}px`);
    this.el.append(menu);
    // (Kept inside the workspace.)
    const r = menu.getBoundingClientRect();
    const b = this.el.getBoundingClientRect();
    if (r.right > b.right) menu.style.left = `${Math.max(0, b.width - r.width - 4)}px`;
    if (r.bottom > b.bottom) menu.style.top = `${Math.max(0, b.height - r.height - 4)}px`;
    this.menu = menu;
    this.menuAnchor = anchor ?? null;
    anchor?.classList.add("open");
  }

  /** A "Send to" item: its submenu (shown on hover) has the four sides, then the named panes. */
  private sendToItem(label: string, id: string, button: (label: string, enabled: boolean, run: () => void, cls?: string) => HTMLButtonElement): HTMLElement {
    const row = Object.assign(document.createElement("div"), { className: "carreau-menu-sub" });
    row.append(Object.assign(document.createElement("button"), { textContent: `${label}  ▸`, className: "carreau-menu-subtitle" }));
    const sub = Object.assign(document.createElement("div"), { className: "carreau-submenu" });
    const arrows = Object.assign(document.createElement("div"), { className: "carreau-menu-arrows" });
    for (const [side, glyph] of [["left", "←"], ["right", "→"], ["up", "↑"], ["down", "↓"]]) {
      const b = button(glyph, this.ws.canSendTo(id, side), () => this.ws.sendTo(id, side), "carreau-menu-arrow");
      b.title = `Send ${side}`;
      arrows.append(b);
    }
    sub.append(arrows);
    const names = this.ws
      .trees()
      .flatMap((t) => panes(t))
      .filter((p) => p.name && p.id !== id && !p.tabs.some((x) => x.id === id))
      .map((p) => p.name!)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) sub.append(button(name, this.ws.canSendTo(id, name), () => this.ws.sendTo(id, name), "carreau-menu-name"));
    if (!names.length) sub.append(Object.assign(document.createElement("div"), { className: "carreau-menu-note", textContent: "No named panes" }));
    row.append(sub);
    // Open on the side where there's room.
    row.addEventListener("pointerenter", () => {
      sub.classList.remove("to-right");
      const r = sub.getBoundingClientRect();
      if (r.left < this.el.getBoundingClientRect().left) sub.classList.add("to-right");
    });
    return row;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    this.menuAnchor?.classList.remove("open");
    this.menuAnchor = null;
  }

  /** Float a pane of the main tree into a window. */
  floatPane(paneId: string): boolean {
    const r = this.floatRect(paneId);
    return !!r && this.ws.float(paneId, r);
  }

  /** Group the selection under a random name, then edit the new tab's title in place. */
  groupAndName(): void {
    if (!this.ws.group(randomWord())) return;
    const holder = this.ws.node(this.ws.selection.id);
    // Naming is part of grouping: Escape, or an empty name, cancels the grouping itself.
    if (holder?.type === "pane") this.editTabTitle(holder.tabs[holder.active].id, () => this.ws.discardLastStep());
  }

  /**
   * Edit a pane's name in place, left of its tabs (a new one, if it has none). Enter (or leaving
   * the field) confirms, Escape cancels; blank: no name. A name it can't have (reserved, or
   * another pane's) shows as invalid, and isn't taken.
   */
  editPaneName(paneId: string): void {
    const p = this.ws.node(paneId);
    const bar = this.elOf(paneId)?.querySelector<HTMLElement>(":scope > .carreau-tabbar");
    if (p?.type !== "pane" || !bar) return;
    bar.hidden = false; // (a cell's hidden tab bar: shown while naming)
    const input = Object.assign(document.createElement("input"), { className: "carreau-pane-name-edit", value: p.name ?? "", placeholder: "Name", spellcheck: false });
    const fit = () => (input.size = Math.max(6, input.value.length + 1));
    const valid = () => !input.value.trim() || this.ws.canNamePane(paneId, input.value);
    fit();
    input.addEventListener("input", () => {
      fit();
      input.classList.toggle("invalid", !valid());
    });
    for (const ev of ["pointerdown", "click", "dblclick", "auxclick", "contextmenu"]) input.addEventListener(ev, (e) => e.stopPropagation());
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      if (commit && !valid()) return; // (Enter on an invalid name: keep editing)
      done = true;
      if (!commit || !this.ws.namePane(paneId, input.value)) this.ws.emit(); // re-render: back to how it was
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finish(e.key === "Enter");
      }
    });
    input.addEventListener("blur", () => (valid() ? finish(true) : finish(false)));
    const label = bar.querySelector(".carreau-pane-name");
    if (label) label.replaceWith(input);
    else bar.prepend(input);
    input.focus();
    input.select();
  }

  /**
   * Edit a tab's title in place. Enter or leaving the field confirms; Escape keeps the
   * current title. With `onCancel`, Escape or an empty name call it instead.
   */
  editTabTitle(tabId: string, onCancel?: () => void): void {
    const tab = this.el.querySelector<HTMLElement>(`.carreau-tab[data-tab="${tabId}"]`);
    const text = tab?.querySelector<HTMLElement>(".carreau-tab-short");
    if (!tab || !text || !tab.getClientRects().length) return; // hidden tab bar: nothing to edit
    const input = Object.assign(document.createElement("input"), { className: "carreau-tab-edit", value: text.textContent ?? "", spellcheck: false });
    const before = input.value;
    const fit = () => (input.size = Math.max(4, input.value.length + 1));
    fit();
    input.addEventListener("input", fit);
    // Interacting with the field is neither a drag nor a click on the tab.
    for (const ev of ["pointerdown", "click", "dblclick", "auxclick"]) input.addEventListener(ev, (e) => e.stopPropagation());
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (onCancel && (!commit || !title)) onCancel();
      else if (commit && title && title !== before) this.ws.renameTab(tabId, title);
      else this.ws.emit(); // re-render: back to the plain title
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finish(e.key === "Enter");
      }
    });
    input.addEventListener("blur", () => finish(true));
    tab.replaceChild(input, text);
    tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    input.focus();
    input.select();
  }

  /**
   * Leaving navigation mode: let the focused cell take the keyboard focus. The selected pane's
   * active tab, through the host's `lifecycle.commitFocus`; other cells, through their renderer.
   */
  commitFocus(): void {
    // Editing something in place (a tab's title, a pane's name): the field keeps the focus.
    if (document.activeElement?.matches?.(".carreau-tab-edit, .carreau-pane-name-edit") && this.el.contains(document.activeElement)) return;
    const n = this.ws.selection.range ? null : this.ws.node(this.ws.selection.id);
    if (n && n.type !== "pane") return RENDERERS[n.type]?.commitFocus?.(n, this);
    if (n?.type !== "pane") return;
    const tab = n.tabs[n.active];
    const shown = n.tabs[shownIndex(n)];
    if (tab) this.ws.lifecycle.commitFocus?.(tab, (shown && this.contents.get(shown.id)) ?? null);
  }

  /**
   * A tab was clicked: if the pane now shows a group whose root has a focus child (e.g. a
   * prompt-column's prompt), select it, and (out of navigation mode) give it the keyboard focus.
   */
  private focusShownGroup(paneId: string): void {
    const p = this.ws.node(paneId);
    const root = p?.type === "pane" ? activeGroup(p)?.children[0] : undefined;
    const target = root && kind(root).focusChild?.(root);
    if (!target) return;
    this.ws.select({ id: target.id });
    if (this.navMode === "off") this.commitFocus();
  }

  /** Enter or leave navigation mode (see keyboard.ts). */
  setNavMode(mode: "off" | "held" | "sticky"): void {
    this.navMode = mode;
    this.el.classList.toggle("nav-mode", mode !== "off");
    this.el.classList.toggle("nav-sticky", mode === "sticky");
  }

  // -------------------------------------------------------------------------
  // Floating windows

  private renderFloat(win: FloatingWindow): HTMLElement {
    const el = Object.assign(document.createElement("div"), { className: "carreau-float" });
    this.placeFloat(el, win);
    // Title bar: moves the window; holding it still for a second docks the whole window.
    const bar = Object.assign(document.createElement("div"), { className: "carreau-float-bar", title: "Drag to move; hold still for a second to dock" });
    bar.addEventListener("pointerdown", (e) => this.armFloatMove(e, win));
    el.append(bar);
    const content = this.renderNode(win.root, rootCtx(true));
    content.style.flex = "1 1 0";
    el.append(content);
    el.addEventListener("pointerdown", () => this.raiseFloat(win, el), { capture: true });
    // Resize from any corner or edge; the window never leaves the workspace.
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const handle = Object.assign(document.createElement("div"), { className: `carreau-float-resize carreau-resize-${dir}` });
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        this.el.classList.add("is-resizing");
        const start = { ...win.rect };
        const [x0, y0] = [e.clientX, e.clientY];
        const move = (ev: PointerEvent) => {
          const { clientWidth: W, clientHeight: H } = this.el;
          const [dx, dy] = [ev.clientX - x0, ev.clientY - y0];
          const r = { ...start };
          if (dir.includes("e")) r.w = clamp(start.w + dx, FLOAT_MIN_W, W - start.x);
          if (dir.includes("s")) r.h = clamp(start.h + dy, FLOAT_MIN_H, H - start.y);
          if (dir.includes("w")) {
            r.x = clamp(start.x + dx, 0, start.x + start.w - FLOAT_MIN_W);
            r.w = start.x + start.w - r.x;
          }
          if (dir.includes("n")) {
            r.y = clamp(start.y + dy, 0, start.y + start.h - FLOAT_MIN_H);
            r.h = start.y + start.h - r.y;
          }
          win.rect = r;
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
    }
    return el;
  }

  /** Place a window, fitting it inside the workspace (shrinking it if needed). */
  private placeFloat(el: HTMLElement, win: FloatingWindow): void {
    const { clientWidth: W, clientHeight: H } = this.el;
    const r = win.rect;
    if (W && H) {
      r.w = Math.min(r.w, W);
      r.h = Math.min(r.h, H);
      r.x = clamp(r.x, 0, W - r.w);
      r.y = clamp(r.y, 0, H - r.h);
    }
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  /** Bring a window to the front without re-rendering (which would interrupt the click). */
  private raiseFloat(win: FloatingWindow, el: HTMLElement): void {
    const f = this.ws.floating;
    if (f[f.length - 1] === win) return;
    f.splice(f.indexOf(win), 1);
    f.push(win);
    move(this.floatLayer, el); // (appendChild would reload the window's iframes)
  }

  /**
   * Drag a floating window. It moves freely; holding it still for a second switches to
   * docking: the window turns translucent and the usual drop indicators appear. Releasing
   * on one docks the window's tree; elsewhere, it stays floating.
   */
  private armFloatMove(e: PointerEvent, win: FloatingWindow, handle?: HTMLElement): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = handle ?? (e.currentTarget as HTMLElement); // the title bar, or the window
    grip.setPointerCapture(e.pointerId);
    const el = grip.closest(".carreau-float") as HTMLElement;
    const { x, y } = win.rect;
    const [x0, y0] = [e.clientX, e.clientY];
    this.el.classList.add("is-moving-float");
    let anchor = { x: x0, y: y0 };
    let ring: HTMLElement | null = null;
    let timers: number[] = [];
    let docking = false;
    let last: PointerEvent | null = null;
    const clearHold = () => {
      timers.forEach(clearTimeout);
      timers = [];
      ring?.remove();
      ring = null;
    };
    const startHold = (cx: number, cy: number) => {
      clearHold();
      if (docking) return;
      timers.push(
        window.setTimeout(() => {
          ring = Object.assign(document.createElement("div"), { className: "carreau-hold", innerHTML: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" /></svg>` });
          Object.assign(ring.style, { left: `${cx}px`, top: `${cy}px` });
          document.body.append(ring);
        }, HOLD_RING_DELAY),
        window.setTimeout(() => {
          clearHold();
          docking = true;
          el.classList.add("docking");
          this.dnd.start({ kind: "external", node: win.root }, "", el, win);
          if (last) this.dnd.move(last);
        }, HOLD_TO_DOCK),
      );
    };
    const moveWin = (ev: PointerEvent) => {
      last = ev;
      win.rect.x = x + ev.clientX - x0;
      win.rect.y = y + ev.clientY - y0;
      this.placeFloat(el, win);
      if (docking && !this.dnd.state) {
        // Docking was cancelled (Esc): back to moving; docking needs a new hold.
        docking = false;
        el.classList.remove("docking");
        anchor = { x: ev.clientX, y: ev.clientY };
        startHold(ev.clientX, ev.clientY);
      } else if (docking) this.dnd.move(ev);
      else if (Math.hypot(ev.clientX - anchor.x, ev.clientY - anchor.y) > HOLD_TOLERANCE) {
        anchor = { x: ev.clientX, y: ev.clientY };
        startHold(ev.clientX, ev.clientY);
      }
    };
    const up = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", moveWin);
      grip.removeEventListener("pointerup", up);
      clearHold();
      // Final hit test and commit *while the window is still see-through*: otherwise the
      // hit test would find the window itself, and nothing would dock.
      if (this.dnd.state) {
        this.dnd.move(ev);
        this.dnd.end(true);
      }
      this.el.classList.remove("is-moving-float");
      el.classList.remove("docking");
      if (!this.dnd.state) this.ws.emit();
    };
    grip.addEventListener("pointermove", moveWin);
    grip.addEventListener("pointerup", up);
  }
}

/** Move a node, preserving its state (iframes, focus, ...) where `moveBefore` exists. */
function move(parent: HTMLElement, node: HTMLElement): void {
  // A focused text field moved by moveBefore keeps the focus but stops taking text (Chrome):
  // focus it again afterwards, caret included. (Fields, and editable elements: e.g. a
  // CodeMirror editor's.)
  const a = document.activeElement;
  const inside = a instanceof HTMLElement && node.contains(a);
  const field = inside && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) ? a : null;
  const editable = inside && !field && (a as HTMLElement).isContentEditable ? (a as HTMLElement) : null;
  const caret = field && ([field.selectionStart, field.selectionEnd] as const);
  const sel = document.getSelection();
  // (As boundary points, not the live ranges: moving collapses those.)
  const ranges =
    editable && sel
      ? Array.from({ length: sel.rangeCount }, (_, i) => {
          const r = sel.getRangeAt(i);
          return [r.startContainer, r.startOffset, r.endContainer, r.endOffset] as const;
        })
      : [];
  moveRaw(parent, node);
  if (field && caret) {
    field.blur();
    field.focus({ preventScroll: true });
    try {
      field.setSelectionRange(caret[0], caret[1]);
    } catch {
      // (fields without a caret, e.g. type="number")
    }
  } else if (editable) {
    editable.blur();
    editable.focus({ preventScroll: true });
    sel?.removeAllRanges();
    for (const [sc, so, ec, eo] of ranges) {
      const r = document.createRange();
      r.setStart(sc, so);
      r.setEnd(ec, eo);
      sel?.addRange(r);
    }
  }
}

/** What an empty pane shows, by default. */
function hint(): HTMLElement {
  return Object.assign(document.createElement("div"), { className: "carreau-empty", textContent: "Empty: drop tabs here, or send them here" });
}

function moveRaw(parent: HTMLElement, node: HTMLElement): void {
  const p = parent as HTMLElement & { moveBefore?: (n: Node, ref: Node | null) => void };
  if (p.moveBefore && node.isConnected && parent.isConnected) {
    try {
      return p.moveBefore(node, null);
    } catch {
      // fall through
    }
  }
  parent.appendChild(node);
}

export const hasMoveBefore = typeof (Element.prototype as { moveBefore?: unknown }).moveBefore === "function";

/**
 * A scroll split's edges fade where there's more to see that way (like buche's scroll-fader):
 * `fade-start` while content is scrolled off before, `fade-end` while there's more after.
 */
function updateFade(el: HTMLElement): void {
  if (!el?.classList?.contains("carreau-scroll")) return;
  const row = el.classList.contains("carreau-scroll-row");
  const pos = row ? el.scrollLeft : el.scrollTop;
  const max = row ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
  el.classList.toggle("fade-start", pos > 1);
  el.classList.toggle("fade-end", pos < max - 1);
}

/** Whether a scroll split is scrolled to its end, along its axis (1px tolerance). */
function atEnd(el: HTMLElement): boolean {
  return el.classList.contains("carreau-scroll-row")
    ? el.scrollLeft >= el.scrollWidth - el.clientWidth - 1
    : el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
}

function toEnd(el: HTMLElement): void {
  if (el.classList.contains("carreau-scroll-row")) el.scrollLeft = el.scrollWidth;
  else el.scrollTop = el.scrollHeight;
}

/** The link icon between merged tabs. */
function linkIcon(): HTMLElement {
  const el = Object.assign(document.createElement("span"), { className: "carreau-tab-link", title: "Merged: drag to move them together" });
  el.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${LINK_PATHS.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
  return el;
}

/** Show a shadow at either end of a tab scroller when there is more to see that way. */
function updateTabShadows(scroller: HTMLElement): void {
  const wrap = scroller.parentElement!;
  const max = scroller.scrollWidth - scroller.clientWidth;
  wrap.classList.toggle("more-left", scroller.scrollLeft > 1);
  wrap.classList.toggle("more-right", scroller.scrollLeft < max - 1);
}

const WORDS = "amber basalt cedar delta ember fjord garnet harbor indigo juniper kestrel lagoon meadow nimbus orchid pebble quartz ridge saffron tundra umber willow zephyr lantern marble copper falcon maple".split(" ");

function randomWord(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}
