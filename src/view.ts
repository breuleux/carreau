// DOM rendering: layout (through node kinds and the contexts they give their children),
// persistent tab contents, floating windows, the pane menu, in-place editing, and CSS-only
// selection & maximization. Drag & drop is in dnd.ts.

import { cellAccent } from "./colors";
import { DndHost, DragDrop } from "./dnd";
import {
  Ctx,
  FloatingWindow,
  LayoutNode,
  PaneNode,
  Rect,
  SplitNode,
  activeGroup,
  clamp,
  find,
  intersect,
  kind,
  panes,
  paneDisplay,
  pathTo,
  rootCtx,
  union,
} from "./model";
import { Workspace } from "./workspace";

export { cellAccent } from "./colors";

export interface ViewOptions {
  /** Content of a tab body. */
  renderTab?: (tab: PaneNode["tabs"][number], pane: PaneNode) => HTMLElement | string;
}

/** Docking a floating window: hold it still this long (ms), within this many pixels. */
const HOLD_TO_DOCK = 1000;
const HOLD_TOLERANCE = 4;
/** When the progress ring appears while holding still (ms). */
const HOLD_RING_DELAY = 150;
/** Minimum size of a floating window. */
const FLOAT_MIN_W = 160;
const FLOAT_MIN_H = 100;

export class View implements DndHost {
  readonly el: HTMLElement;
  readonly rootEl: HTMLElement;
  readonly floatLayer: HTMLElement;
  readonly overlay: SVGSVGElement;
  private selBox: HTMLElement;
  private opts: Required<ViewOptions>;
  readonly dnd: DragDrop;
  /** Navigation mode (driven by the keyboard controller). */
  private navMode: "off" | "held" | "sticky" = "off";
  private menu: HTMLElement | null = null;
  private menuAnchor: HTMLElement | null = null;
  /** One persistent element per tab, created once and moved around, never recreated. */
  private contents = new Map<string, HTMLElement>();
  /** Last known scroll position of each scroll split / tab scroller, by node id. */
  private scrollPos = new Map<string, [number, number]>();
  private lastSelection = "";
  private lastTab = "";

  /** The current drag, if any (for tests and debugging). */
  get drag() {
    return this.dnd.state;
  }

  constructor(
    readonly ws: Workspace,
    host: HTMLElement,
    opts: ViewOptions = {},
  ) {
    this.opts = { renderTab: opts.renderTab ?? ((t) => t.content ?? t.title) };
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
        if (t.closest(".carreau-tabbar, .carreau-float-resize")) return;
        const floatEl = t.closest<HTMLElement>(".carreau-float");
        if (floatEl) {
          const win = this.ws.floating[[...this.floatLayer.children].indexOf(floatEl)];
          if (win) {
            this.raiseFloat(win, floatEl);
            this.armFloatMove(e, win, floatEl);
          }
          return;
        }
        const paneEl = t.closest<HTMLElement>(".carreau-pane");
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
    for (const n of old) n.remove();
    this.restoreScroll();
    // Keep the selected tab (active tab of the focused pane) in view when it changes.
    const cur = this.ws.node(this.ws.selection.id);
    const tabKey = cur?.type === "pane" ? `${cur.id}:${cur.active}` : "";
    if (tabKey && tabKey !== this.lastTab) {
      const scroller = this.elOf(cur!.id)?.querySelector<HTMLElement>(".carreau-tabs");
      const tab = scroller?.children[(cur as PaneNode).active] as HTMLElement | undefined;
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
    if (el.classList?.contains("carreau-scroll")) return el.dataset.id ?? null;
    if (el.classList?.contains("carreau-tabs")) return el.dataset.pane ? `tabs:${el.dataset.pane}` : null;
    return null;
  }

  private rememberScroll(el: HTMLElement): void {
    const key = this.scrollKey(el);
    if (key) this.scrollPos.set(key, [el.scrollLeft, el.scrollTop]);
  }

  private restoreScroll(): void {
    for (const el of this.el.querySelectorAll<HTMLElement>(".carreau-scroll, .carreau-tabs")) {
      const pos = this.scrollPos.get(this.scrollKey(el) ?? "");
      if (pos && el.getClientRects().length) [el.scrollLeft, el.scrollTop] = pos;
    }
  }

  /** Put every content tab's element into its pane's body; only the active one shows. */
  private placeContents(trees: HTMLElement[]): void {
    const seen = new Set<string>();
    // The old elements are still attached: look panes up in the new ones only.
    const paneEls = new Map<string, HTMLElement>();
    for (const t of trees) for (const el of [t, ...t.querySelectorAll<HTMLElement>(".carreau-pane")]) if (el.classList.contains("carreau-pane")) paneEls.set(el.dataset.id!, el);
    for (const p of this.ws.trees().flatMap((t) => panes(t))) {
      const body = paneEls.get(p.id)?.querySelector<HTMLElement>(":scope > .carreau-body");
      if (!body) continue;
      p.tabs.forEach((tab, i) => {
        if (tab.group) return; // group tabs show a layout, rendered with the pane
        seen.add(tab.id);
        let el = this.contents.get(tab.id);
        if (!el) {
          el = Object.assign(document.createElement("div"), { className: "carreau-content" });
          el.dataset.tab = tab.id;
          el.style.setProperty("--accent", cellAccent(tab));
          const c = this.opts.renderTab(tab, p);
          if (typeof c === "string") el.textContent = c;
          else el.append(c);
          this.contents.set(tab.id, el);
        }
        el.hidden = i !== p.active;
        if (el.parentElement !== body) move(body, el);
      });
    }
    for (const [id, el] of this.contents)
      if (!seen.has(id)) {
        el.remove();
        this.contents.delete(id);
      }
  }

  /** Render a node, given the context its parent gave it (see kinds.ts). */
  private renderNode(node: LayoutNode, ctx: Ctx): HTMLElement {
    const el = document.createElement("div");
    el.dataset.id = node.id;
    el.style.flex = ctx.sizedAlong ? "none" : `${node.weight} 1 0`;
    if (ctx.sizedAlong) el.classList.add(`carreau-natural-${ctx.sizedAlong}`);
    if (node.type === "pane") this.fillPane(el, node, ctx);
    else this.fillSplit(el, node, ctx);
    return el;
  }

  private fillSplit(el: HTMLElement, node: SplitNode, ctx: Ctx): void {
    const k = kind(node);
    el.classList.add("carreau-split", `carreau-${k.axis}`);
    if (k.scroll) el.classList.add("carreau-scroll", `carreau-${node.type}`);
    const childCtx = k.childContext(node, ctx);
    node.children.forEach((c, i) => {
      // Children sized by their content get a fixed gap; others, a splitter.
      if (i > 0) el.append(childCtx.sizedAlong ? Object.assign(document.createElement("div"), { className: "carreau-gap" }) : this.renderSplitter(node, i));
      el.append(this.renderNode(c, childCtx));
    });
  }

  /** A pane: its tab bar (at the bottom) and body. It decides its display from its context. */
  private fillPane(el: HTMLElement, node: PaneNode, ctx: Ctx): void {
    el.classList.add("carreau-pane");
    const display = paneDisplay(node, ctx);
    const activeTab = node.tabs[node.active];
    if (activeTab) el.style.setProperty("--focus-accent", cellAccent(activeTab));
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
      const g = Object.assign(document.createElement("div"), { className: "carreau-group", hidden: i !== node.active });
      g.dataset.groupTab = t.id;
      g.classList.toggle("natural-row", ctx.natural.row);
      g.classList.toggle("natural-column", ctx.natural.column);
      g.append(this.renderNode(inner, kind(t.group!).childContext(t.group!, childCtx)));
      body.append(g);
    });
    body.classList.toggle("shows-group", !!activeGroup(node));
    el.append(body);
    el.addEventListener("pointerdown", (e) => {
      // Primary button only (selecting re-renders, which would break a middle click), and
      // only the innermost pane (presses bubble through group holders too).
      if (e.button !== 0 || (e.target as HTMLElement).closest(".carreau-pane") !== el) return;
      if (this.ws.selection.id !== node.id) this.ws.select({ id: node.id });
    });
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
    bar.append(wrap);
    node.tabs.forEach((t, i) => scroller.append(this.renderTab(node, t, i, ctx)));
    // The empty part of the header moves the pane.
    const space = Object.assign(document.createElement("div"), { className: "carreau-tabspace", title: "Drag to move this pane" });
    space.addEventListener("pointerdown", (e) => this.dnd.arm(e, { kind: "pane", paneId: node.id }, node.tabs[node.active]?.title ?? "pane", bar.parentElement!));
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
    if (t.status) tab.classList.add(`status-${t.status}`);
    tab.style.setProperty("--tab-accent", cellAccent(t));
    if (this.ws.canCloseTab(t.id)) {
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
    tab.addEventListener("click", () => this.ws.activateTab(node.id, i));
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
    for (const el of this.rootEl.querySelectorAll(".max-hidden, .max-path, .max-through, .selected"))
      el.classList.remove("max-hidden", "max-path", "max-through", "selected");
    const max = this.ws.maximized;
    this.el.classList.toggle("is-maximized", !!max);
    if (max) {
      const path = pathTo(this.ws.root, max.id) ?? [];
      const keep = new Set(path.map((n) => n.id));
      const hide = (id: string) => this.elOf(id)?.classList.add("max-hidden");
      const target = path[path.length - 1];
      if (target && target.type !== "pane" && max.range)
        target.children.forEach((c, i) => (i < max.range![0] || i > max.range![1]) && hide(c.id));
      for (const n of path.slice(0, -1)) {
        // A group's holder the maximization passes through: only its group's part shows.
        if (n.type === "pane") this.elOf(n.id)?.classList.add("max-through");
        else for (const c of n.children) if (!keep.has(c.id)) hide(c.id);
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
    const kindName = sel.range ? "range" : (this.ws.node(sel.id)?.type ?? "");
    Object.assign(this.selBox.style, r && kindName !== "pane" ? { display: "block", left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } : { display: "none" });
    this.selBox.dataset.kind = kindName;
    this.selBox.classList.toggle("in-float", !find(this.ws.root, sel.id));
    for (const n of nodes) this.elOf(n.id)?.classList.add("selected");
  }

  // -------------------------------------------------------------------------
  // Pane menu, in-place editing, navigation mode

  private openMenu(anchor: HTMLElement, node: PaneNode): void {
    this.closeMenu();
    const menu = Object.assign(document.createElement("div"), { className: "carreau-menu" });
    const item = (label: string, enabled: boolean, action: () => void) => {
      const b = Object.assign(document.createElement("button"), { textContent: label, disabled: !enabled });
      b.addEventListener("click", () => {
        this.closeMenu();
        action();
      });
      menu.append(b);
    };
    item("Float", panes(this.ws.root).length > 1 && !!find(this.ws.root, node.id), () => this.floatPane(node.id));
    if (this.ws.canCollapse(node.id)) item("Collapse group", true, () => this.ws.collapse(node.id));
    // The header is at the bottom of panes: open upwards.
    const g = anchor.getBoundingClientRect();
    const b = this.el.getBoundingClientRect();
    Object.assign(menu.style, { right: `${b.right - g.right}px`, bottom: `${b.bottom - g.top + 2}px` });
    this.el.append(menu);
    this.menu = menu;
    this.menuAnchor = anchor;
    anchor.classList.add("open");
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
