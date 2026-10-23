# Carreau

Carreau is a tiling system implemented in TypeScript, with no framework: plain DOM plus one SVG overlay.

A workspace is a hierarchy of **rows** and **columns** (plain, or scrolling) whose leaves are **panes**. Each pane holds one or more **tabs**. Users can:

* navigate with key-bound commands;
* resize with splitters;
* relocate tabs and panes by dragging;
* pull panes out into **floating windows**, each of which holds its own layout tree, and dock them back.

Tab contents (including iframes) survive every relayout.

The prototype consists of:

* Pure model (no DOM):
  * `types.ts`: the serializable data types.
  * `geometry.ts`: rects and sides (`edge`, `span`, `band`, `intersect`, `union`, `sideAxis`, …).
  * `kinds.ts`: the **node kinds registry**. Each node type knows its children, axis, whether it scrolls, whether things can be inserted beside it, whether it is a navigation step, and the context it gives its children. Panes decide their own display from that context (see [Node kinds and contexts](#node-kinds-and-contexts)).
  * `complex.ts`: **tab complexes** (merged tabs): finding them, their types' registry, and following what happens to them during structural changes (see [Tab complexes](#tab-complexes-merging)).
  * `tree.ts`: generic walks (`walk`, `find`, `pathTo`, `panes`, `findTab`), all through `kind(n).children`; `computeRects`; and `LayoutIndex`, a one-pass index of parents, roots, holders and contexts.
  * `model.ts`: re-exports the above, plus constructors, (de)serialization, normalization, insertion, swapping, and drop logic across several trees.
* `cells.ts`: handles for hosts: `Cell` (a node, with `cellAt`) and `Placer` (see [Relative addressing and placement](#relative-addressing-and-placement)).
* `workspace.ts`: the state on top of the trees and the command set. No DOM, no key bindings. It holds:
  * the main tree;
  * the floating windows;
  * the selection, which may be in any tree;
  * maximization (main tree only);
  * navigation memory.
* `view.ts`: the DOM, except drag and drop:
  * rendering, with persistent tab contents (and renderers' persistent elements) moved by `moveBefore`;
  * splitters and CSS-only maximization;
  * the selection outline;
  * the pane menu, in-place title editing;
  * floating windows: moving, resizing, hold-to-dock.
* `dnd.ts`: drag and drop: the `DragDrop` controller, hit testing, choices, and the SVG overlay. It only needs a small `DndHost` interface from the view (elements and rects by id, the layers). The view exposes the current drag as `view.drag`.
* `colors.ts`: cell accents, drop line level colors.
* `keyboard.ts`: the keyboard navigation mode controller, configured with an activation chord and bindings.
* `style.css`: the library's styles.
* Optional modules, plugged in through the core's extension points (see [Extending](#extending-other-node-types)); the core never mentions them:
  * prompt columns: `prompt.ts` (no DOM), `prompt-view.ts` (rendering), `prompt.css` (see [Prompt columns](#prompt-columns)).

The library is `src/` and has nothing demo-specific. The demo lives in `demo/` (`index.html`, at the root, loads `demo/main.ts`); test scripts are in `tests/`: headless suites (`npm test`) and browser scripts driving the demo (see `tests/README.md`).

* A demo page (`demo/`):
  * `main.ts`: the page, the keyboard configuration, the demo lifecycle (closing delays, cell spawning); `demo.css`: the page's styles and the demo's tab contents;
  * `examples.ts`: the example layouts; `cellclasses.ts`: what each kind of cell creates when a new cell is inserted from it;
  * examples to pick from, including iframe embeds, a scroll column, a scroll row, sticky scroll splits, and a prompt column;
  * the keyboard configuration, with a legend;
  * a live JSON view with a "Load JSON" button;
  * a status line showing the selection and the maximization.


## Representation

All state is plain JSON-serializable data:

```ts
type Tab = {                       // a "cell", shown as a tab
  id: string; title: string;       // title: plain-text name (drag label; fallback for `short`)
  icon?: string; short?: string; long?: string;   // HTML parts (content is rendered by the host)
  accent?: string;                 // CSS color; default: derived from the id
  status?: "done" | "error" | "unresponsive" | string;
  content?: string; data?: Record<string, unknown>; group?: Slot;
  key?: string | null; link?: string;   // merging: see "Tab complexes"
};
type Pane = { type: "pane"; id: string; weight: number; tabs: Tab[]; active: number;
  size?: number };  // a scroll-column cell's height in px, set by dragging its bar (see "Cells"; splits have it too)
type Split = { type: "row" | "column" | "scroll-row" | "scroll-column" | "slot" | "forest"; id: string; weight: number; children: Node[];
  reverse?: boolean };  // scroll splits only: sticky, see "Sticky scroll splits"
type Slot = Split & { type: "slot"; children: [Node] };   // holds one layout root: a group tab's layout
type Node = Pane | Split;   // open: modules add leaf node types and split types (see "Extending")
type FloatingWindow = { root: Node; rect: { x; y; w; h } };   // rect: pixels, relative to the workspace
type WorkspaceData = { root: Node; floating: FloatingWindow[] }; // last window is frontmost
```

* `weight` is a node's relative size within its parent. A child's fraction is `weight / sum(sibling weights)`. Render each child with `flex: <weight> 1 0`.
* `data` on a tab is arbitrary serializable host data. The demo uses it for what to embed.
* `slot` and `forest` never appear at a tree's top: a slot is only ever a group tab's `group`, and a forest only exists transiently during drops and structural changes (see [Across trees](#drop-targets-model)).
* `kind(n).axis` maps `row` and `scroll-row` to the row axis, and `column` and `scroll-column` to the column axis (null for panes, slots and forests). **Every** orientation check must use it rather than comparing `type` to `"row"` or `"column"`. That includes insertion, `computeRects`, expand, the drop lines, splitter direction and the preview orientation.
* Serialization writes `{root, floating}`, or a bare tree when nothing floats. Deserialization accepts both. It validates the trees (a slot must have exactly one child), defaults missing weights to 1, and clamps `active`. There is no compatibility with older formats.

### Normalization

Normalization runs after every structural change, on construction, and on load. It:

* drops panes with no tabs and splits with no children;
* collapses a split with a single child into that child, which inherits the split's weight;
* **rescales each split's child weights to average 1**, keeping their ratios. Weights become flex-grow factors, and flex-grow factors summing to less than 1 only claim that fraction of the free space. Without rescaling, a few half-splitting moves (each taking half a neighbour's weight) leave children squeezed into part of their parent, with the rest empty;
* flattens a split nested in a split of the same type. A row of rows is just a row. The inner children's weights are rescaled so that together they keep the inner split's share: `w_k' = w_k / sum(w) * inner.weight`.

Scroll splits add four rules:

* **A scroll split always lives in a group tab.** Normalization wraps any scroll split that isn't the root of a group in a holder pane, with a single group tab titled by its kind (`groupTitle`: "Scroll column" or "Scroll row"). The holder takes the scroll split's weight. This also applies at a tree's root, via `normalizeTree`, used for the main tree and floating windows' trees, including on load.
  * The whole scroll split can thus be moved around by its tab or header, renamed, and have other tabs dragged into its tab bar.
  * A group whose root is a scroll split can't be collapsed, since normalization would wrap it right back.

* A **scroll split is never collapsed** for having a single child. It could not be recreated by dragging.
* A plain split of the same axis directly inside a scroll split is flattened into it, because its children are naturally sized either way.
* A scroll split inside a plain split is **not** flattened; it is what provides the scrolling. (It ends up wrapped in a group tab, per the first rule.)

And **pinned** children (`kind(n).pinned`) go, unless their parent's kind keeps them (`normalizeChildren`, which then decides the children list).

### Logical geometry

`computeRects(root, frame)` gives every node's rectangle from the weights alone, in the unit square or any given frame. Navigation uses these logical rectangles, never DOM rectangles, so it is unaffected by maximization, tab bars and gaps.

### Node kinds and contexts

Code never asks "is X nested in a Y?". Instead, each node type has a **kind** (`kind(n)`; registered with `registerKind`), and each node learns where it is from a **context** its parent gives it.

```ts
interface NodeKind {
  children(n): (Node | undefined)[];  // a pane's children are its tabs' slots, indexed like the tabs
  axis: Orientation | null;
  scroll: boolean;
  sides: Side[];                      // where things can be inserted (a `side` drop); see below
  navStep: boolean;                   // false for slots and forests
  leaf?: boolean;                     // no children of its own: panes, other leaves (`isSplit(n)`: not a leaf)
  cell?: boolean;                     // holds the focus by itself, like a pane (`isCell(n)`)
  pinned?: boolean;                   // never moved or grouped; dropped by normalization unless its parent keeps it
  lastFixed?: boolean;                // its last child stays last, outside the scrolling (see "Extending")
  alwaysSticky?: boolean;             // a scroll split that always sticks to its end (`isSticky(n)`)
  groupTitle?: string;                // the title of the group tab it lives in (scroll splits)
  normalizeChildren?(n, kids): Node[];  // default: drop pinned children
  mergeKey?: string;                  // a group tab whose root is of this kind merges with that key
  focusChild?(n): Node | null;        // clicking the group tab whose root it is focuses that child
  childContext(n, ctx): Ctx;
  replaceChild(n, i, child); removeChild(n, i);   // a pane: set / remove tab i's group
  close(n, life): Promise<void>;      // close everything in it (see "Closing")
  forceClose(n, life): Promise<void>;
}
interface Ctx {
  natural: { row: boolean; column: boolean };  // sized by content along these axes
  sizedAlong: Orientation | null;   // sized by content along its parent's axis: flex: none, gaps, no splitters
  cellOf: Orientation | null;       // a direct child of a scroll split along that axis
  floating: boolean;                // in a floating window
}
```

* The root context (`rootCtx(floating)`) has nothing natural.
* A split's `childContext`: along its axis, children are sized by content if the split scrolls, or if the split's own size along that axis is natural. `cellOf` is set for children of scroll splits.
* A slot and a pane pass their context on, minus `sizedAlong` and `cellOf`: a group's layout fills its holder, but inherits its natural-size context.
* **Insertable sides** (`kind(n).sides`): panes and plain splits, all four; a scroll-column, top and bottom; a scroll-row, left and right; slots and forests, none. Inserting on side S of node N (`insertBeside`) means: the new node appears on that side of N, along N's whole extent.
  * N lays out its children along S's axis: the new node becomes its first or last child, taking **1/N of the split**, exactly like a separator between two of its children (it is a `between` at index 0 or n). In Spiral, `row[1, column[2, …]]`, the left of the row gives thirds (5, 1, the column), whereas the left of pane 1 halves pane 1.
  * N's parent does: it becomes N's sibling, taking half of N's weight.
  * Otherwise N is wrapped in a new plain split, through its parent (`kind(parent).replaceChild`).
  * A scroll split takes nothing across its axis: it is its group's root, so it would be wrapped in a split inside the group, and normalization would pack that into yet another group tab. That only looks like a split. Insert beside the group's holder instead.
* Generic code goes through kinds: tree walks, `insertBeside`, removal, the drop lines, rendering.
* **A pane decides its own display** from its context: `paneDisplay(pane, ctx)` (see [Cells](#cells)). The renderer and drag-and-drop both call it, rather than probing the DOM for classes.

**`LayoutIndex`** (`ws.index()`, rebuilt on demand) indexes all trees in one pass. Each entry has the node, its parent, its index in the parent, its tree's root, and its context. It answers `parent(id)`, `root(id)`, `holder(id)` (the pane holding a node's slot, when the node is a group's root), `navParent(id)` and `navChild(n, pick)` (skipping what isn't a navigation step).

### Extending: other node types

The set of node types is open, so that a feature like prompt columns lives in a module of its own, which the core never mentions. A module can add:

* **Types**: leaf node types and split types, by TypeScript declaration merging on `NodeTypes` and `SplitTypes` (types.ts). Then `n.type === "my-leaf"` narrows as usual.
* **Kinds** (`registerKind(type, kind)`): what the node is (see above). `leafKind` is a base for leaves that hold nothing; `splitKind(axis, scroll)`, for splits. Validation, normalization, walks, rects, navigation and drops then work through the kind. An unregistered type is an error (`Unknown node type`), including when loading JSON: a host that loads prompt columns must import their module.
* **Renderers** (`registerRenderer(type, renderer)`, view.ts), for leaves other than panes: `fill(el, node, view, ctx)` fills the element the view made (with the node's `data-id`, flex, natural-size classes, and `carreau-cell` for cells); `attached(el, node, view)` runs once the new tree is attached, to place **persistent elements** (`view.persist(key, parent, create)`, `view.persisted(key)`: created once, moved with `moveBefore`, removed after a render that doesn't place them); `commitFocus(node, view)` takes the keyboard focus when navigation mode is left on the node. Splits are rendered by the view itself.
  * **Every scroll split** renders as a **frame** (`.carreau-framed`, `data-id`, with the panel's look) that doesn't scroll, holding an inner scroller (`.carreau-frame-inner`, the actual `.carreau-scroll`, keyed by `data-scroll` = the split's id for scroll memory). A split whose kind has `lastFixed` has its last child below the scroller, outside. The DOM then differs from the tree, but navigation, rects and drops go by the tree.
  * **Fading edges** (like buche's scroll-fader): the scroller's edges fade out where there's more to see that way. A CSS mask on the scroller (so only its content fades, whatever is behind), whose fade sizes (`--carreau-fade-start`, `--carreau-fade-end`, animated: registered with `@property`) grow while content is scrolled off before (`.fade-start`) or there's more after (`.fade-end`). `updateFade` sets them, on scroll, on render, and when the scroller or its children resize (a ResizeObserver). `scroll-padding` keeps what's scrolled into view clear of the fade.
  * Renderers' focus handlers must ignore focus events while `view.rendering` (see the pitfalls).
* **Operand redirection** (`registerOperand(type, fn)`, workspace.ts): when a node of that type is selected, cell operations, maximizing included, act on something else (see `ws.operand()` in [Prompt columns](#prompt-columns)).


## Rendering

### Structure

* Splits are flex containers. A 4px splitter element sits between consecutive children.
  * Dragging a splitter moves weight between the two neighbours, keeping their sum constant.
  * Each neighbour has a 30px minimum.
  * While dragging, update the flex styles directly. Emit a change on release.
* Panes have a 1px outline (`#2c2e38`) and 4px rounded corners. **The page background is that same outline color**, so panes read as dark cards and the outline blends into the gaps.
* A pane is a body plus a **header (the tab bar) at the bottom**. The header and the body share the same background color. From left to right, the header holds:
  * **the tabs**: click to activate the tab and select the pane; drag to move the tab. Each tab has a **close button (×)** after its title, and middle-clicking a tab closes it too;
  * **the empty rest of the header**, which is the pane's handle: drag it to move the whole pane, click it to select the pane. There is no separate grip. It always keeps at least 24px;
  * **a ⋯ button** at the right end.
* A drag starts only after the pointer has moved 5px; below that, it is a click.
* **Closing tabs.** A pane left without tabs disappears, and a floating window left empty closes. The very last tab of the main tree can't be closed, so it gets no ×. A closed tab's persistent content element is dropped.
* **Closing is asynchronous.** See [Closing](#closing).
* **Where the focus goes on close.** If the closed tab doesn't have the focus, nothing special happens: the selection stays, and the tab's pane falls back to the tab before it. If it has the focus (it is the selected pane's active tab, or a group tab holding the selection), **the parent decides**. Walking up from what disappears, the first parent with something left picks:
  * a **pane** (tab group): its most recently activated other tab (else the tab before). If that tab is a group, the focus goes into it;
  * a **plain split**: its most recently focused other child (else a neighbour);
  * a **scroll split**: the **neighbour further from its sticky end**, i.e. the one that moves into the closed cell's place: the next cell normally, the previous one for a sticky (`reverse`) split. At the far end, the other neighbour. Activation order doesn't matter there;
  * a group's **slot**: the group tab disappears from its holder pane, which decides in turn, as a tab group;
  * a **tree root** (a window closing): the most recently selected pane left elsewhere.

  From the node picked, the focus goes down to a pane through what was last focused in it (a pane showing a group: into the group). See `focusAfterClose` in workspace.ts.
  * Draw the × in CSS (`::before`), so that the tab's text content stays its title.
  * The × is faded, and brighter when its tab is hovered or selected, with a small hover background.
  * Stop `pointerdown` propagation on the × (it is not a drag), and `click` propagation (it is not an activation).
  * Pitfall: the pane's `pointerdown` handler (select the pane) must ignore non-primary buttons. Selecting re-renders, which would replace the tab under a middle click before its `auxclick` fires.
* **Double-clicking a tab** selects its pane and maximizes it, or restores if that pane is already the maximization. This is for the main tree only.

### Tabs

* **Tabs never shrink or abbreviate.** They sit in a horizontal scroller with its scrollbar hidden.
  * A shadow fades in at the left or right end when there are more tabs that way. Update it on scroll, and whenever sizes may have changed (render, resize, splitter drags).
  * A plain vertical mouse wheel over the tabs scrolls them sideways.
  * Save and restore each pane's tab scroll position across re-renders.
  * When the focused pane's active tab changes (a click, nextTab), scroll it into view within the scroller.
* **Style**: a 1px grey line separates the header from the body above it. There are no separators between tabs and no background differences.
  * Every tab's text is faded (slightly less on hover), except the **selected** tab, meaning the active tab of the focused pane.
  * The active tab of *each* pane has a 2px line at its top, drawn over the grey line. It is **mid grey**, or the tab's **accent color** when its pane is focused.

### Colors

* **Colors are mostly neutral greys.** Panes, splits, selection outlines, previews, icons, tab dots and window title bars carry no accent color.
* **Light and dark modes**, with CSS `light-dark(light, dark)` for every color (the dark side is the reference design; light mirrors it: white panes on a light grey page, dark text, dark drop lines). The library sets no `color-scheme`: it follows the one it inherits, so the host decides (`:root { color-scheme: light dark }` follows the system). The demo has an Auto / Light / Dark switch in its header, setting `color-scheme` on the root (remembered in localStorage).
  * Colors shared by several rules are custom properties: `--carreau-pane-bg` (also mixed into the cells' `long` strips) and `--carreau-group-bg` (the gaps inside a group). They are defined on `.carreau` and on the elements appended to the body (drag ghost, hold ring).
  * Colors computed in TypeScript (`colors.ts`) are `light-dark()` strings too: derived accents, and drop-line levels (in light mode, the dark-mode lightness L becomes 0.25 + 0.9·(1−L), with a little more chroma). The center icons and tab dots are light chips with a dark outline, the same in both modes.
  * SVG presentation attributes don't take `light-dark()`: the overlay sets `fill`, `stroke` and `stop-color` through `style`.
  * The demo's stateful iframe page declares `color-scheme: light dark` itself (an iframe's document doesn't inherit styles).
* **Each tab has an accent color**, from a hash of its id into a small palette of oklch hues (L 0.74, C 0.13 in dark mode; L 0.62, C 0.15 in light mode). Duplicates are fine.
  * The accent appears **only** on the line of the active tab of the focused pane. That line is the focus indicator for panes.
  * When the focus is inside a group, the panes holding it (along the path from the tree's root: `.focus-path`) show their active tab the same way, so that the whole chain of tabs leading to the focus is lit.
* **Selection outline**: a selected row, column or range gets a dim grey dashed outline over the union of the selected nodes' (visible) DOM rects, with a very faint fill. A selected *pane* gets no outline; its tab line shows it. The outline is hidden while dragging. When the selection is inside a floating window, draw it above the window layer.

### Pane menu

The ⋯ button opens a small menu **above** it (the header is at the bottom), right-aligned with it.

* It offers **Float**, disabled for the last pane in the main tree. Panes inside floating windows have no ⋯ button.
* **Collapse group**, when the pane can collapse (see [Group tabs](#group-tabs)).
* **Close pane**: closes the pane and all its tabs (see [Closing](#closing)). Disabled for the main tree's last pane.
* **Stick to bottom / top** (scroll-column) or **right / left** (scroll-row), when the pane shows a scroll split: toggles it sticky (`ws.toggleReverse(id)`; `ws.scrollOf(paneId)` finds it). Undoable.
* Clicking ⋯ again toggles the menu closed, and any other pointerdown closes it. Exclude the anchor from the outside-click check, or the toggle reopens it immediately.
* Stop `pointerdown` propagation on ⋯, so it doesn't select the pane and re-render (which would replace the anchor).


## Selection and navigation

No keyboard shortcut is hard-coded in the library. The workspace exposes named commands, and the keyboard controller (`keyboard.ts`) maps keys to them **from a configuration** supplied by the host: the activation chord and every binding.

### Navigation mode

All keyboard navigation happens in a **navigation mode**:

* **Activation chord** (demo: **Alt+Q**, which is unlikely to clash with OS or browser shortcuts on macOS, Windows or Linux): enters the mode for as long as the modifier stays held. Releasing the modifier leaves it. So does losing window focus, since no keyup arrives then.
* **Side of the modifier** (`activation.side`: `"left"`, `"right"`, or `"either"`, the default): which physical modifier key counts. For example, `"left"` leaves the right Option key free for typing special characters on macOS.
  * A key event for Q doesn't tell which modifier key is down, so the controller tracks held modifier keys by `KeyboardEvent.code` (`AltLeft`, `AltRight`, …) from their own keydown/keyup events, clearing them on window blur.
  * With a side configured, only that key activates, and only releasing that key ends held mode. Tapping the other one doesn't.
* **Sticky mode**: pressing the activation key again while still holding the modifier (Alt+Q, Q) makes the mode sticky. The modifier can then be released. Pressing the activation key again (or Esc) leaves it.
* **Bindings** are looked up from the chord of `KeyboardEvent.code` plus Shift/Alt/Ctrl/Meta prefixes, **leaving out the activation modifier**. The same bindings therefore work with the modifier held (held mode) or not (sticky mode).
* **Shortcuts** (`shortcuts`): keys that work **without entering navigation mode** (and in it, for keys it doesn't bind): redundant ways to the same actions, e.g. `{"Ctrl+Tab": "nextTab", "Cmd+ArrowLeft": "prevTab"}` (the demo's). Keys are **full chords**: every modifier counts, the activation one included. Not while typing in a text field (there, Cmd+← moves the caret), unless the shortcut says so (`{run, inFields: true}`); keys forwarded from an iframe (`bridgeFrameKeys`) say whether they were typed in a field.
* **Chords in configs** can be written with modifiers in any order, and "Control", "Cmd", "Command", "Option" for Ctrl, Meta, Meta, Alt (`canonical`): bindings, prefixes and shortcuts alike.
* **A binding is a built-in action** (by name: `NavAction`) **or the host's own command**: any function, given `{ws, view, nav}` (`NavBinding`), in `bindings` and in prefix tables alike. It can use the whole public API (e.g. `ws.withOperand`, to act on what cell operations act on; `nav.leave()`, to end navigation mode, committing the focus). Its function's `name` labels it (the demo's legend). Demo: D, `duplicateTab` in demo/main.ts (a copy of the focused tab, into its pane; undoable).
  * Mapped keys `preventDefault`. Listen in the capture phase.
  * The modifier key's own events, and autorepeat of the activation key, are ignored.
* **Prefix keys**: the config may define prefixes, each with its own table (same chord syntax). After a prefix key, the next key is looked up in the prefix's table. The demo uses S → arrows/H/J/K/L for **swap** (Alt+Q, S, ←).
  * **One-shot**: press and release the prefix, then a key.
  * **Held**: while the prefix key is down, every key pressed uses its table, which allows repeated swaps. Releasing it ends the prefix if it was used; if not, it stays pending for the next key.
  * Modifiers that are part of the prefix's own chord are ignored on the next key: e.g. Shift+X, then Shift+← would look up ←.
  * A modifier key pressed on its own (Shift before Shift+←) is not a key: it neither runs nor cancels anything.
  * Any key not in the table cancels the prefix, and so does leaving the mode. The pending prefix is exposed, so a status display can show it.
* **Actions** are the workspace commands plus three extras:
  * `toggleMaximize`: restore if anything is maximized, else maximize;
  * `float`: float the selected pane, as the ⋯ menu does;
  * `closeTab`: close the selected pane's active tab;
  * `closePane`: close the selected pane;
  * `insertLeft` / `Right` / `Up` / `Down`: `ws.spawn({split: side})`;
  * `insertIntoLeft` / …: `ws.spawn({split: "tab", base: direction, force: true})`;
  * `moveLeft` / …, `moveIntoLeft` / …: the same with `ws.moveTab(spec)`.
* **Demo bindings**:

  | Keys | Action |
  |---|---|
  | arrows, H/J/K/L | focus |
  | Shift + those | expand |
  | S, then arrows or H/J/K/L | swap (hold S to swap repeatedly) |
  | U | unexpand |
  | P / C | parent / child |
  | R | root |
  | Z / Shift+Z | undo / redo |
  | G / Shift+G | group (then edit its name in place) / collapse group |
  | % (Shift+5) | edit the selected tab's title in place |
  | ] / [ | next / previous tab |
  | M | toggle maximize |
  | F | float |
  | W, X | close the selected tab |
  | Shift+W, Shift+X | close the selected pane |
  | I, then ←→↑↓ / HJKL | insert a new cell into the tabs of the cell on that side (if none, where it would be) |
  | I, then Shift+←→↑↓ / Shift+HJKL | insert a new cell beside the selected one, on that side |
  | A, then ←→↑↓ / HJKL | move the focused tab into the tabs of the cell on that side (if none, where it would be) |
  | A, then Shift+←→↑↓ / Shift+HJKL | move the focused tab beside the selected pane, on that side |

  Since bindings leave the activation modifier out of the chord, no binding can use that modifier itself. Prefixes, like S for swap, avoid piling more modifiers on top of the held Alt.
  * Avoid chords the browser reserves (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab), which can't be prevented.
  * Avoid chords that the OS takes when combined with the held modifier. For example, Ctrl+Alt+L locks the screen on some Linux desktops.
* **Look:** while the mode is on, the workspace gets a class. The selected pane gets a **brighter thin outline** (and so does the row/column/range outline), and panes show a grab cursor.
* **Press anywhere to drag:** while the mode is on, pressing anywhere inside a pane drags that pane, and pressing anywhere inside a floating window moves the window, hold-to-dock included.
  * This is a capture-phase pointerdown on the workspace, so it takes precedence over the content.
  * Iframes get `pointer-events: none`, so pressing on them works.
  * **Headers are excluded**, so tabs, × and ⋯ keep working; the header's empty part drags the pane anyway. So are window resize handles.
  * A click without movement selects the pane.
* Pitfalls:
  * Match on `KeyboardEvent.code`, not `key`: on macOS, Alt+letter produces special characters.
  * On Windows/Linux, releasing a bare Alt focuses the browser's menu bar: `preventDefault` the modifier's keyup when it ends navigation mode.
  * Alt+Left/Right are back/forward on Windows/Linux. As mapped keys they are prevented while the mode is on.
  * Keys typed while focus is inside an iframe never reach the controller.

A **selection** is either a single node `{id}`, or a contiguous range of children of a split, `{id: splitId, range: [lo, hi]}`. A range covering every child is normalized to `{id: splitId}`.

**The selection may be in any tree**, the main tree or a floating window's.

* Node lookup covers all trees.
* Navigation commands work **within the tree that holds the selection**: parent, child, focus, expand, swap and tab cycling.
* Clicking a pane or tab in a window selects it: its active tab shows its accent, and the main screen loses its highlight.
* **Maximization is main-tree only.** Maximize is ignored for a selection in a window, and a maximization or history entry that would end up outside the main tree is dropped.

Memory kept by the workspace:

* **last pane**: the latest *single* pane selected. **Multi-selections don't stick.** When the selection is a row, column or range:
  * **focus** and **swap** only go back to this pane, without moving or swapping, so the user sees the selection collapse first;
  * **leaving navigation mode** also collapses it back to this pane. The maximization, if any, is kept.

  A multi-selection is thus a transient state within navigation mode, used for maximizing groups for example.
* **activation order** (`recent`), most recent first, capped at 64 entries each:
  * for each container (split, pane holding groups), the children on the path to the selection, updated on every selection change. Its head is the "last-focused child";
  * for each pane, its tabs in the order they became active, recorded on every `emit()` (tabs become active through clicks, commands and drops alike, so it is observed rather than hooked);
  * for the workspace, the single panes selected.
* **boundary memory**: `"<nodeId>:<side>"` maps to the selection we arrived from through that side.
* **expand stack**: the selections that preceded each consecutive expand. Any other selection change clears it.
* **maximization history**: the stack of previous maximized selections (null means not maximized).

Commands:

* **nextTab / prevTab**: cycle the active tab of the innermost pane around the selection that has several: the selected pane, or, up through the groups' holders, the first with more than one tab (a lone tab in a group has nothing to cycle). If that is a holder, the focus moves into its newly shown tab (`descend`).
* **parent**: the parent of the selected node. From a range, the split itself.
* **root**: the root of the tree holding the selection (the main tree, or a floating window's). For the main tree, this clears the maximization (top-level rule). Since last-child memory is kept, **child** then walks back down the same path.
* **child**: the most recently focused child of the selected container, restricted to the range if one is selected. Falls back to the first child.
* **focus left/right/up/down**, using logical rects. Let S be the selection's rect.
  1. If boundary memory has an entry for `selection:side` and that node is still adjacent on that side with positive overlap, go there.
  2. Otherwise, consider the panes whose opposite edge touches S's edge (EPS 1e-6) with positive overlap along the edge. Pick the one with the highest score: `overlap + (10 if it contains the center of S along that edge)`.
  3. Record `boundary[target:opposite(side)] = previous selection`, so that up, down, up returns to where you started.
* **expand left/right/up/down**:
  * If the selection is a range in a split of the matching axis and can grow on that side, grow it by one.
  * Otherwise walk up from the node. At the first ancestor whose parent has the matching axis and a sibling on that side, select the range `[node, sibling]` in that parent.
  * Push the previous selection onto the expand stack.
* **unexpand**: pop the expand stack.
* **swap left/right/up/down**: panes only.
  * Find the neighbour as for focus, with boundary memory restricted to panes.
  * Exchange the two nodes in their parents' children arrays, and exchange their weights too, so the geometry stays the same and only the contents move.
  * The selection stays on the moved pane. Record boundary memory in both directions, so that the opposite swap exactly undoes it even when several panes border that side.
  * Skip normalization. With panes only, a swap cannot create nesting that needs flattening.
* **maximize**: if the selection is not already the maximization, push the current maximization onto the history and maximize the selection.
* **restore**: pop the history. This returns to the *previous view*, which may itself be maximized.
* **toggle maximize** (the keyboard's maximization command): if the selection *is* the maximized group, restore. Otherwise maximize the selection, which may be wider than the current maximization (after going to a parent) or narrower.
* **Navigation may widen the maximization, never narrow it.** Only the maximization command zooms in further.
  * **parent** and **expand** widen it: when the new selection contains the whole maximized area, the selection becomes the maximization, replacing it without pushing to the history.
  * **child** and **unexpand** never narrow it. With a group G maximized, child → child → parent lands on G's child, which is *inside* G, so G stays maximized. A naive "the maximization follows the selection on parent" rule would wrongly narrow it to that child.
  * When **focus** moves to a pane outside the maximized area, the maximization moves to that pane, since otherwise the selection would be hidden.
* **At the top level, maximization is cleared unconditionally.** When the selection becomes the main tree's root, the maximization and its history are cleared. Maximizing the root just clears it.

**Undo / redo** (`undo`, `redo` commands; demo: Z / Shift+Z in navigation mode) apply only to actions that **change the layout**: drag-and-drop moves, swaps, **splitter resizes**, floating, docking and closing tabs. Simple navigation (selection, the active tab, maximize/restore) is not recorded.

* The workspace records a **snapshot** before each such action: the main tree, the floating windows (with their rects), the selection, the maximization and its history, the expand stack and the last pane. Undo restores it, so the selection that went with the layout comes back too, and pushes the current state onto the redo stack. Any new step clears the redo stack. The history is capped (200).
* **What counts as a layout change**: compare a key made of the trees (structure, tabs, weights) *without* the panes' `active` indices or the windows' rects, before and after the action.
* **Record at the entry points** (`run`, `select`, `activateTab`, `commitDrop`, `float`, `closeTab`/`closePane` (when the removal happens), `maximize`, `restore`, `toggleMaximize`) with a wrapper. Only the outermost wrapper records, and only if the layout key changed. Navigation passes through the same wrapper and simply records nothing.
* **Splitter resizes**: the view calls `beginResize(key)` when a splitter drag starts and `endResize(token)` when it ends, where the key identifies the splitter (split id + index).
  * **Consecutive resizes of the same splitter coalesce** into one step, so a slow resize done in several drags undoes at once.
  * A different splitter, any other recorded step, or an undo/redo ends the coalescing. Navigation in between doesn't, since it's not a step.
* Floating-window moves/resizes are not steps, but undoing restores the rects that went with the restored layout.
* Loading a layout clears both stacks.
* Tab contents survive undo like any relayout: they are keyed by tab id and moved back into place. Undoing a tab close re-creates the tab, so its content element is created afresh; an iframe reloads.

**Scrolling into view**: when the selection changes, call `scrollIntoView({block: "nearest", inline: "nearest"})` on it, since it may be in a scroll split.

**Maximization is CSS only**; the DOM structure is untouched.

* On the path from the root to the maximized node, add a hiding class to every child that is not on the path, and to any splitter adjacent to a hidden child.
* For a range, also hide the maximized split's children outside the range.
* Path nodes are forced to `flex: 1 1 0`.


## Drag and drop

### During a drag

* The source (a tab, or the whole pane when dragging its header) is grayed out with low opacity and grayscale.
* A ghost label with the tab's title follows the cursor.
* The layout is **not** re-laid out during the drag.
* A single SVG overlay with `pointer-events: none` covers the workspace, above the floating windows. All indicators are drawn there and hit-tested in JavaScript.
* Iframes get `pointer-events: none` and the gesture captures the pointer; see [Tab contents and embeds](#tab-contents-and-embeds-iframes).
* **Esc** cancels. The pointer is still down, though, so the next move would immediately start a new drag and reactivate a drop zone.
  * After Esc, a **0.5s cooldown** prevents any drag from starting. Moving after it resumes the drag, and releasing during it does nothing.
  * For a floating window being docked, Esc returns to plain moving. The window is opaque again and docking needs a new one-second hold.
* **Releasing** over an active choice commits it: replace all trees with the result, close emptied windows, add a window for `float`, and select the pane that received the drop.

### Hovered pane

The hovered pane is the first `.carreau-pane` under the cursor, in the main tree or in a floating window, found with `elementsFromPoint`. The topmost window wins.

* Pitfall: when the cursor is over a splitter gap, or anywhere inside the workspace that is not a pane, **keep the previously hovered pane**. Otherwise indicators flicker off while crossing borders.
  * This includes the **gaps between a group's parts**. There, the hit test finds the holder's body, and that must count as a gap, not as hovering the whole holder.
* Lines, tab dots and zones are rebuilt when the hovered pane changes, and when anything scrolls (see [Scroll splits](#scroll-splits)).

### Drop targets (model)

```ts
type DropTarget =
  | { kind: "side"; targetId; side }       // beside a node (edge insertion)
  | { kind: "between"; splitId; index }    // between two siblings of a split
  | { kind: "tab"; paneId; index }         // into a pane's tab list at a position
  | { kind: "swap"; paneId }               // exchange contents with a pane
  | { kind: "float"; paneId }              // pull the dragged thing out into a floating window
  | { kind: "merge"; tabId };              // merge the dragged tab with a tab (see "Tab complexes")
type DragSubject =
  | { kind: "tab"; tabId }
  | { kind: "complex"; link }             // a tab complex, as a block of tabs (see "Tab complexes")
  | { kind: "pane"; paneId }
  | { kind: "external"; node };            // a tree in none of the trees: a window being docked
```

**`applyDropForest(trees, subject, target)`** computes a drop over the main tree (`trees[0]`) and the floating windows' trees at once, so that things move freely between them. It works on clones, and returns `{trees, paneId, floated?}` or null.

* `trees` comes back in input order, with **null for a tree the drop emptied**; that window closes.
* `floated` is a pane to show as a new window.

**Across trees: `inForest(trees, fn)`.** Wrap each tree in a root **slot**, put the slots in a transient `forest` node, run `fn(forest)`, then normalize each slot's child with `normalizeTree`. A tree whose slot was emptied comes back as null. Then `find`, the tombstone, insertion and swap all work across trees unchanged, with no special cases:

* Every tree root is a slot's only child, exactly like a group's root. Since a slot takes no insertions (`sides` empty, `axis` null), `insertBeside` on a tree root wraps it, and the drop can't create a new tree.
* Removing a tree root empties its slot; tree indices never shift.
* The workspace's structural commands (grouping, collapsing, swapping, renaming, closing, floating) run through `inForest` too, through a single private `change(fn)`, which also records the undo step. If the main tree would be emptied, the change is refused.

**Steps:**

1. **Detach** the subject without invalidating ids along the target's path.
   * **Pane**: replace it in its parent with a tombstone pane, which has no tabs and keeps the weight.
   * **Tab**: splice it out of its pane, which may become empty and then acts as a tombstone. Fix the source pane's `active`.
   * **External**: clone it in. There is nothing to detach; the window being docked is simply left out of `trees`.
   * A tab dropped on a tab target is inserted directly. If it lands in the same pane, decrement the index when the source index is before it.
2. **Insert**:
   * `side`, on node X (see [insertable sides](#node-kinds-and-contexts)):
     * If X is a split along that side's axis, the target becomes `{between, X, 0 or n}`: its first or last child, sized 1/N.
     * If X's parent is split along that side's axis, insert as a sibling before or after X. The new node takes **half of X's weight**.
     * Otherwise wrap X in a new **plain** split of that axis, `[new, X]` or `[X, new]`, with weights 1 and 1. The wrapper takes X's old weight. On a tree root, the wrapper becomes that tree's root.
   * `between`: insert at `index` in the split. The weight is chosen so that the new pane gets **1/N of the split**, where N counts the new pane.
     * Compute `weight = sum(w) / n` over the children that stay.
     * Exclude the tombstone and any pane that has become empty.
   * `tab`: splice the tabs into the destination pane at the index, and make the first of them active. An external subject can do this only if it is a single pane.
3. Remove the tombstone and normalize each tree.

**`swap`** is handled up front, without detaching anything:

* **Dragged tab:** the tab trades places with the target pane's *active* tab. Each tab lands at the other's index, and the panes' `active` indices are unchanged.
* **Dragged pane:** the two panes exchange their whole tab lists and their `active` indices. The geometry is unchanged.
* Not available for external subjects. Swapping with your own pane is null.

**`float`** is only valid over the dragged thing's **own** pane:

* **Dragged pane, or a tab that is alone in its pane:** remove the pane from its tree and return it as `floated`.
* **Tab among others:** remove the tab and float it in a new pane of its own.
* Not available for external subjects. Floating a window's only pane again is a no-op.

**Invalid and no-op drops return null.** Those choices are simply not offered in the UI.

* Dropping a pane beside, or into the tabs of, itself.
* Any drop that would **empty the main tree**.
* A `side` target on a side its node doesn't take (`kind(n).sides`).
* A drop that would put something inside itself (see [Group tabs](#group-tabs)).
* **The general rule**: if the shapes of all trees are unchanged, the drop is pointless. `shape` ignores ids and weights: it covers types, nesting and the tab ids in each pane.
  * This catches a lone tab, or a pane, dropped on a border it already occupies, even when only sizes would change.
  * It also catches `between` right next to the subject's own pane, and a tab dropped back into its own place in its pane. No dedicated checks are needed for these.
  * A tab that has siblings can still split off beside its own pane.
  * `float` results are exempt, because they always change something.

Every candidate choice in the UI is computed through this function, so the UI never offers pointless drops. A window being docked is always excluded from the trees.

### Choices per side of the hovered pane P

For each side S of P, working within **P's own tree** (main or window):

1. **The nodes on the line**: walk up from P (from a group's root to its holder pane), collecting each ancestor whose border on side S lies on P's border (within 1.5px). Stop at the first one that doesn't, or at the tree's root. A window's edges thus behave like the workspace edges.
   * Where a scroll split is along S's axis, its border there is **where its content ends** (its end child's edge), not its box: a short scroll-column still takes insertions right below its last cell.
   * A group holder's border coincides with its group's on the sides away from its header. Below a group (above the holder's header), the walk stops.
2. **Between siblings**: if, on the way up, P's side borders a sibling (the parent splits along S's axis), the walk stops there, and the outermost choice is **between** those two siblings: `{between, split, index}`, sized 1/N. Its span is the extent of the node next to the gap on P's side. Call such a side a *straddling* side.
3. **Insertions**: every node on the line whose kind takes side S gives a `side` choice on it, if the drop is valid. That includes:
   * a scroll split along S's axis, at its start/end: inserting a first/last cell. Its preview is the third of the end cell next to the edge, consistent with the between-cells previews, and its span is the end cell's. The line's **hit area also reaches a few pixels outward** (5px), over the scroll split's border and the holder's header edge, so that aiming right at the very edge works.
   * the holder of a group, and nodes further out, when their border is the same: they share the line, dashed.
4. **Same drop, once**: choices whose results are the same layout **including sizes** (`shape(tree, true)`, all trees) are the same drop. Keep the **innermost**. Leave out those P's own edge third on S already offers, and the between choice's.
   * Sizes matter: the top of a column whose first child is P (1/N of the column) is *not* P's own top third (half of P), so both are offered, the former on the line.
   * P's own `side` choices are its edge thirds, never line levels. A cell of a scroll split has no thirds along the split's axis ("beside" zones would look like splits, but cells just stack): there, the lines offer the separators instead.
5. Each choice has a `span`: its node's visible extent along the edge, in pixels. Choices are ordered **outermost first** (the between choice, then outer nodes to inner ones).
6. While the cursor is within the current line's hit area, the hovered pane is kept, even if the pane under the cursor is another one (e.g. the holder, over its header).

### The border line

A border line is shown **only while the cursor is over it**: the cursor must be within the line's band across the edge. Nothing is drawn while merely approaching a border. If two bands contain the cursor (at a corner), pick the side whose border is nearest.

**Geometry**: the line is 8px thick.

* At the edge of the workspace or of a window, it lies inside P along the edge.
* On a straddling side, P's half runs from the middle of the splitter gap inwards into P.
* Pitfall: the **hit area** on a straddling side must cover the *whole* gap, from the far sibling's edge to the inner end of P's half. P's drawn half only starts at the middle of the gap. Since the hovered pane is kept over gaps, a hit area equal to the drawn half would leave the far half of the gap matching nothing, and the line would vanish right on the separator.

**Dashes**:

* Cut the line at every choice's span endpoints. Each stretch is covered by some set of choices, ordered outermost first.
* A stretch with one choice is drawn solid.
* A stretch with several choices is drawn as 18px dashes cycling through them: `levels[k mod n]` for `k = floor(v / 18)`.
  * Anchor dashes to **absolute** coordinates, so they don't shift as the line changes and so the two halves of a border line up.
  * Leave a **1px visual gap** at the end of each dash. Hit-testing ignores the gap.
* **Selecting**: the active choice is the dash under the cursor's position along the edge.
* Because P's span lies inside the span of every node on the line, P's stretch shows all of its group choices dashed. Stretches beyond P only show the outer ones.
  * Example: a pane inside an inner group inside an outer group, whose boundaries are all distinct. Along the pane, grey (outer) and muted blue (inner) dashes alternate. Beyond the inner group, the line is solid grey. A pane whose only enclosing option is the between-siblings choice gets a plain grey line.

**Coloring**:

* Colors go by **level index** within the line, outermost first. Level 0 is **light grey** (chroma 0). Deeper levels get **low-saturation** hues (chroma 0.06), only so that the dashes of several possible insertions stand apart. A line with a single choice is therefore plain grey.
* Each choice's rect is filled with a `userSpaceOnUse` linear gradient across the band: bright at the border (L 0.86, or 0.97 when active), darker away from it (L 0.58, or 0.72 when active).
* Alpha is 0.75, or 1 when active.
* Give each gradient a unique id.

**The other side** (easier homing): on a straddling side, also draw the border as seen from each pane Q across it, on Q's half of the gap.

* The candidates are the panes inside the sibling on the far side whose facing edge touches that sibling's edge.
* For each Q, build Q's line for the opposite side, without recursing into its own other side, and clip it to Q's visible extent along the edge. The same "leave out Q's own boundary" rule applies.
* Hovering follows the pane under the cursor, so crossing the border swaps which half is "ours". Only the hovered pane's half triggers.
* Choices with the **same drop target** on both halves (in practice the shared `between`) touch in the middle. Every other choice backs off 1px from the middle, leaving a visible gap.
* Shared choices **highlight on both halves at once** when active. Compare choices by their target, not by object identity.

### Tab dots

The tab bar shows grey dots at every insertion position: before the first tab, between consecutive tabs, and after the last tab.

* The active dot grows and brightens.
* **Hovering anywhere in the tab bar** selects the nearest insertion position by horizontal distance; there is no need to hit a dot.
  * If the nearest position is a no-op, nothing is selected. Don't fall through to a farther dot: hovering your own tab must not jump to some other gap.
* No-op positions have no dot: the two around the dragged tab, and all of them on the dragged pane's own tab bar.
* With the tabs scrolled, positions hidden in the middle are dropped. The **first and last positions are pinned to the visible edges**, so that both ends stay reachable. Hovering the empty header area right of the tabs selects "append", because the pinned last dot is the nearest.

### Pane zones: thirds and center

The hovered pane also offers its own zones, laid out on a 3×3 grid of its *visible* rect:

* **Edge thirds** (x < 1/3, x > 2/3, y < 1/3, y > 2/3) propose a `side` drop on the pane itself, on that side: insert beside it, taking half of it.
  * **Not along a scroll split's axis**: for a pane that is a direct child of a scroll split, the thirds on the sides along that split's axis propose nothing. Only the separator lines apply there. The cross axis is a real split and keeps its thirds, and so do panes nested deeper inside a cell.
  * In corners, pick the side whose boundary is nearer, using normalized distance.
  * Sides where that drop is a no-op propose nothing.
* **Center third:** shows an icon in the middle of the pane, a grey circle of radius 22. The choice is active only while the cursor is over the icon; the rest of the center proposes nothing.
  * Over another pane, it is a **swap icon** (two opposed arrows), for `swap`. If that pane's tab bar is hidden (a single cell), a **tab icon** (a small folder-like tab) sits next to it, for a `tab` target appending to the pane. Several icons are laid out side by side, centered.
  * Over the dragged thing's own pane, it is a **cloud icon** (three overlapping circles over a flat base), for `float`.

**Priority**, from highest: the border line under the cursor, then the tab bar (nearest gap), then the thirds and center. The border line matters most at the bottom border, where the header is.

### Preview

On top of the indicators, draw the drop area as a faint translucent fill with a dim grey dashed rounded outline. It is **always aligned with the current geometry, never the relaid-out one**; a relayout preview was found confusing. Clip it to the visible part of the nodes involved.

* `side` on X: the half of X adjacent to that side. On a split X along that side's axis (its start/end, 1/N): the 1/(n+1) of X adjacent to that side, n counting the children that stay; on a scroll split, the third of its end child next to the edge.
* `between`: straddle the border, covering the last third of the node before it and the first third of the node after it.
* `tab`: no outline. The highlighted dot is the preview; outlining the pane was found distracting.
* `swap`: outline both panes that trade contents, the target and the dragged item's pane.
* `float`: outline where the window will appear, the same rect the menu's Float uses. On commit, add the window with that rect.


## Cells

Tabs are **cells**. A cell has HTML parts (**content**, rendered by the host; **icon**; **short**; **long**) and properties (**accent**, **status**). `long` is typically the shell command that created the cell, or the prompt it is the result of.

* **A tab shows `[icon][short][×]`.**
  * `short` defaults to `title`, as text.
  * A group tab's default icon is ▦.
  * Renaming a tab sets `title` and drops `short`.
* **Status** changes how the icon looks:
  * `"done"`: 50% opacity;
  * `"error"`: tinted red;
  * `"unresponsive"`: blinking between normal and done;
  * anything else: normal.
* **Accent**: the cell's `accent`, or a color derived from its id. It colors the selected tab's line, the `long` strip, and a cell's focus border.
* **Display options per pane, automatic, decided by the pane from its context** (`paneDisplay(pane, ctx)` in `kinds.ts`):
  * **Panes in a natural-size context** (inside a scroll split, at any depth) are cells: `showTabBar` only if they have several tabs, and `showLong = true`.
  * **Everywhere else**, the tab bar always shows and `showLong = false`.
  * With the tab bar hidden, a single tab shows no header. Exception: **a pane whose only tab is a group always shows its tab bar**, since a group is a container whose name matters (and it must be editable in place right after grouping).
  * `showLong = true`: the active cell's `long` is shown in a strip at the top of the cell. Its background is tinted from the accent by default; the host's HTML can style it otherwise.
* **Handles.** With no tab bar, the top strip is the pane's handle: drag it to move the pane. A cell with no tab bar and no `long` gets an empty, slim strip just to have one. Focus is shown by the cell's border, in its accent.
* **Cells of scroll splits** (a scroll split's direct children: `ctx.cellOf`) are panes, or splits of panes. Their panes (the cell itself, or the panes in the split, through splits but not through group holders, which are cells of their own) look like buche's echo-box (`.carreau-scrollcell`):
  * An **accent bar** on the left (in the active tab's accent), with a **status circle** on top: hollow, filled when `done`, red on `error`, blinking when `unresponsive`. The card (background, border) is drawn right of it (a `::before`), so the bar sits on the scroll split's panel. The bar widens on the selected cell.
  * In a **scroll-column, the bar resizes the cell** (for a split cell, every bar in it resizes the same cell, so they stay in sync): dragging outward (up from its top half, down from its bottom half) grows it, inward shrinks it, and **the dragged edge stays put** on screen (the scroller's position absorbs the drift: measured, not assumed, so it also works in sticky splits). The height is **layout** (the cell's `size`, a pane's or a split's): undoable (like a splitter: `beginResize`/`endResize`), serialized, ignored outside a scroll-column. A sized cell scrolls its content. Double-click the bar: back to the natural height. (In a scroll-row, the bar doesn't resize: a cell's height is the row's.)
  * A **close button** (×) at the top right closes the cell (`closePane`), unless it's the last pane, or is closing (its spinner shows instead).
* **Adding a tab to a pane with no tab bar.** There are no tab bar dots to drop on, so the center of such a pane offers a **tab icon** next to the swap icon, as a `tab` target appending to it. Its preview outlines the pane.
* **Nested panes and presses.** Panes nest, inside group tabs. A pane's "select on press" handler must only act when it is the **innermost** pane under the pointer; the press bubbles through the holders too, and the outermost would win otherwise.

## Group tabs

A tab can hold **a whole layout** instead of content. The pane holding it then switches between that layout (when the group tab is active) and its other tabs. Both kinds of tab live in the same tab bar, so tabs can be dragged in and out as usual.

* **Representation.** `tab.group` is a **slot**: a node of type `"slot"` with exactly one child, the layout's root. (The same kind of node wraps each tree during drops; see `inForest`.)
  * A pane's kind lists its tabs' slots as its children, so tree walks (`walk`, `find`, `pathTo`, `panes`, `findTab`) descend into groups. A slot's parent is its holder pane; the root's parent is the slot.
  * Drops, swaps, floating, undo and normalization therefore work inside groups unchanged.
  * A slot has no axis and doesn't accept siblings, so nothing is ever inserted as a sibling of a group's root. `insertBeside` wraps it instead, and a group's root never forms a "between" with anything.
  * Removing a group's root (dragging its last pane out, a tombstone) empties the slot.
  * Normalization normalizes each group's layout separately. **A group left empty disappears together with its tab**, and the slot itself never collapses.
  * `shape` includes groups' layouts.
  * Deserialization validates them.
* **Never across a scroll split itself.** A scroll split only takes insertions along its axis (its `sides`): across, it would be wrapped in a split inside its group, and normalization would then pack it into yet another group tab. Insert beside the group's holder instead.
* **Cycles.** A drop must never put something inside itself. If the dragged tab carries a group, or the dragged pane has group tabs, and the target lies inside one of those groups, the drop is invalid.
* **Grouping** (`group(name)`; demo: **G** in navigation mode):
  * The selection becomes a new **holder pane** with a single group tab named `name`.
  * A single node (pane or split) goes in as is. A range is wrapped in a plain split of the same axis.
  * The holder takes the selection's place and weight; on a tree root, it becomes the root. Then normalize and select the holder.
  * G groups **immediately** under a random word, then puts the new group tab's title into **in-place editing**.
  * Naming is part of grouping: **Escape, or confirming an empty name, cancels the grouping itself**. The step is reverted and *discarded* from the undo history (`discardLastStep`: restore without pushing onto the redo stack), so it can't be redone. The original selection comes back.
  * For a plain rename, by contrast, Escape or an empty name just keep the current title.
* **Editing a tab's title in place** (`renameTab`; demo: **%**, i.e. Shift+5 on a US layout, renames the selected pane's active tab).
  * The tab's text node is replaced by a small text field, sized to its content, with the text selected.
  * Enter, or leaving the field, confirms; Escape keeps the current title.
  * The field stops pointer events (pointerdown, click, double-click, auxclick) from reaching the tab, so it's neither a drag nor an activation.
  * Confirming renames through the workspace, which re-renders the tab. A rename is a layout change, hence an undo step of its own, separate from the grouping.
  * The keyboard controller ignores keys typed in text fields, so typing the name isn't navigation, even in sticky mode. Except the activation chord, in the workspace's own fields (a prompt, a title being edited): that's the way out of them. Text fields outside the workspace keep all their keys.
* **Collapsing** (`collapse(paneId?)`; demo: **Shift+G**, and **"Collapse group"** in the ⋯ menu) is possible when a pane's **only** tab is a group. It replaces the pane by the group's layout, with the pane's weight, then normalizes.
  * Without an argument, it acts on the selected pane if it can collapse; otherwise on the innermost holder around the selection that can.
* Group and collapse are layout changes, hence undoable.
* **Rendering.**
  * A pane's body renders **every** group tab's layout in its own container, hiding the inactive ones (`hidden`). Inactive groups' panes thus stay in the document, and the tab contents inside them (iframes) survive tab switches.
  * `placeContents` skips group tabs, since they have no content element.
  * Pitfall: **a group's layout inherits its holder's natural-size context.** Inside a scroll split, the holder sizes to its content, so the group's parts must size to theirs (`flex: none` along that axis, with the group container laid out along it). With weights, they would share an indefinite size and collapse to nothing.
  * A group's layout fills its holder's body entirely: no padding, no margin. Its background is **lighter than the normal gaps**, so the group is visible through the gaps between its parts.
  * Group tabs are marked with a small ▦ before their title.
* **Logical geometry**: `computeRects` gives the active group's layout the holder pane's rect. Inactive groups get no rects.
* **Navigation**:
  * Candidate panes for focus must have a rect, which excludes panes in inactive groups. A pane *showing* a group is skipped too: it acts as a container, and its group's panes are the targets.
  * **child** of a pane showing a group goes to the group's root. **parent** of a group's root goes to the holder pane.
  * **A group's root split is skipped.** When a group's root is a split, it fills its holder's body exactly, so it isn't a navigation step.
    * **child** of the holder goes straight to that split's last-focused child.
    * **parent** from one of the split's children, from a range in it, or from the split itself goes straight to the holder.
    * When the group's root is a single pane, it is the holder's child as usual.
    * The holder itself is always a step: its tab bar switches between the group and any other tabs.
  * All of this is `LayoutIndex.navParent` / `navChild`: a node is a step if its kind says so (not a slot) and it isn't a split whose parent is a slot.
  * A slot is never selected; selecting one selects its root.
  * Maximization works through groups, since `pathTo` descends into them. When the maximization passes **through** a holder (the maximized node is inside its group), the holder's tab bar and outline are hidden, so only the maximized part shows. Maximizing the holder itself keeps its tabs.
* **Drop lines**: when the walk up reaches a group's root, it continues from the **holder pane** (`LayoutIndex.holder`), as long as their borders coincide. Lines from inside a group can thus also insert beside the holder and further out.

## Relative addressing and placement

For hosts (e.g. "open the new terminal below the focused cell"). Nodes are plain data, so a **`Cell`** is a handle on a node (a pane or a split) by id: `ws.cell(id)`, `ws.focused()` (the selected node; for a range, its split). `cell.node` is the node, or null once it's gone.

**`cell.cellAt(path)`**: the cell at a relative location, **exactly where the navigation shortcuts would go** from that cell, without moving the focus; or null.

```ts
type Direction = "left" | "right" | "up" | "down" | "parent" | "child";
type Path = Direction | { id: string } /* an explicit cell */ | Path[] /* in sequence */;
```

* The sideways moves use the same neighbour search as focus (logical rects, the pane facing the center, boundary memory; a remembered *range* isn't a cell, so it's skipped). `parent` and `child` are the navigation steps (slots and groups' root splits skipped; `child` picks the most recently focused child).
* An explicit cell jumps there; the following moves start from it. A sequence fails as soon as one move does.
* Unlike the shortcuts, a sideways move from a split moves from the split's rect (the shortcuts first fall back to the last single pane).
* To share it, the shortcuts' logic is written as queries on any selection: `neighbour(side, only, sel)`, `parentOf(sel)`, `childOf(sel)`.

**`ws.placer(spec).apply(what)`**: place something relative to the focused cell (at the time of `apply`). Returns the `Cell` (pane) that holds it, or null.

```ts
interface PlaceSpec {
  split: Side | "tab";   // beside the base, on that side; or into its tabs
  base?: Path;           // from the focused cell; default: the focused cell itself
  force?: boolean;       // if the base doesn't exist, put it where the base would be
  focus?: boolean;       // focus what was placed (default true)
}
type Placeable = Tab | Node | Cell | { id };  // new, or already in the layout (then it moves)
```

* **Placing is dropping.** The spec becomes a drop target, `what` a drag subject, and it goes through `tryDrop` / `commitDrop`: same rules (sizes, insertable sides, no-ops refused), one undo step.
  * Subjects: a tab or pane already in the layout moves (`tab` / `pane`); a new tab comes in a new pane, a new node as is (`external`). Splits already in the layout can't be placed (no drag moves them either).
  * `split: side`: `{side, base, side}`: beside the base (half of it), or at a split base's start/end (1/N). `split: "tab"`: appended to the base's tabs; for a split base, its most recently focused pane's.
* **`force`, when the base's path fails**: the thing goes where the base would have been. Take the side of the failed move (`right` for a failed "right"), or `split`'s side if that move wasn't sideways (`parent` of a root). Walking up from where the path got to, the first parent that takes insertions on that side (kind `sides`; slots skipped, holders count) gets a new pane on that side, holding the thing. With no such parent, the node reached itself.
  * E.g. `{split: "left", base: "right", force: true}` from the rightmost pane of the main row: a new pane at the end of the row (1/N). From a cell of a scroll-column: the scroll-column takes nothing on its right, so beside its group's holder.
* With `focus: false`, the selection is put back afterwards.

**`ws.spawn(spec)`**: insert a **new cell**, placed as `spec` says. What the new cell is, **the cell it's done on decides** (not the base): the host's `lifecycle.spawn(from: Tab): Tab | null`, called with the selected pane's active tab (for a split, its most recently focused pane's). Null: nothing is inserted. Without the hook, an empty "New tab". Demo keys: I, then a direction: into the tabs of the cell there (with Shift: beside the focused cell, on that side).

**`ws.moveTab(spec)`**: move the focused tab (the selected pane's active tab) as `spec` says; it goes through the placer like anything else. A lone tab beside its own pane is a no-op (null). Demo keys: A, then a direction: into the tabs of the cell there (with Shift: beside the selected pane).

* The demo has **cell classes** (`demo/cellclasses.ts`), each matching some tabs and spawning a sensible new one: a shell cell spawns another command (a random one, in its accent), a prompt a follow-up prompt, a video another video, a stateful page a new counter, anything else (groups included) an "Untitled" text tab.

## Prompt columns

A **prompt-column** is a scroll-column that always sticks to its bottom, with an **input field at the bottom**, like a terminal or a chat: cells pile up above the prompt.

It is an **optional module**, entirely outside the core, which only knows it through its extension points (see [Extending](#extending-other-node-types)): `prompt.ts` (types, kinds, operand, submitting; no DOM, so it loads in the headless tests), `prompt-view.ts` (the renderer) and `prompt.css`. A host imports `prompt-view` and `prompt.css` to show prompt columns; constructing or loading one needs `prompt.ts` (which `prompt-view` imports).

* **The prompt is a node**: `{type: "prompt"}`, always the column's **last child**. Being a node, it gets selection, navigation (↓ from the last cell, ↑ back) and logical rects like any cell. Its kind: `leafKind` plus `cell` and `pinned`. So it has no children, no insertable sides, no tabs, no drag handle; it can't be swapped with, closed, floated or grouped (a range expanded over it can't be grouped).
  * As a cell, it counts for the last-cell memory and `clearMultiSelection`, and it's a neighbour candidate for focus moves (not for swaps: those are between panes).
  * The prompt-column's kind: `splitKind("column", true)` plus `lastFixed` (a drop at its end, its bottom side or `between` at its last index, goes **just before the prompt**), `alwaysSticky` (no "Stick to…" menu item), `groupTitle: "Prompt"` (like any scroll split, it lives in a group tab), and `normalizeChildren`, which keeps **exactly one prompt, last** (the first one's id), even with no cells: a prompt-column never disappears for being empty. Prompts anywhere else are dropped (they're pinned).
  * Constructors: `promptColumn(children, weight?)`, `promptNode()`.
* **Rendering**: the column is a split with a fixed last child, so the view renders it as a frame: the cells scroll in an inner element, and the prompt sits below it, outside. So the prompt stays visible while the cells scroll, and it doesn't take part in the overscroll bounce (a `position: sticky` prompt inside the scroller would).
  * The prompt's renderer fills its element (`.carreau-prompt`), and places its **editor**'s element as a **persistent element** (`view.persist`, with the editor's `destroy` as its dispose), so what's typed, and the focus, survive re-renders. (Moving it re-focuses it, fields and editable elements alike: see the pitfalls.)
* **Editors** (`PromptEditor`, prompt.ts): what a prompt holds is the host's. `configurePrompts(ws, { editor })` takes a factory, called once per prompt with a context (`{ws, promptId, submit(text), focused()}`), returning `{el, focus(), update?(state), destroy?()}`:
  * `el`: anything (a field; a header above a CodeMirror or Monaco editor…). The editor decides when to submit (`submit(text)`: e.g. on Enter), and calls `focused()` when it takes the keyboard focus (the prompt gets selected; ignored during renders).
  * `focus()`: leaving navigation mode on the prompt, or clicking its column's tab.
  * `update(state)`: on every render, with `{speaker, merged, selected}` (who types, for a header or a placeholder).
  * `destroy()`: the prompt is gone (a render that doesn't place it).
  * The default is `inputEditor({placeholder?})` (prompt-view.ts): a one-line field, Enter submits, the placeholder says who types when merged. The keyboard controller treats any field or editable element inside the workspace alike (the activation chord gets out of it), so custom editors need nothing for that.
  * Demo: the "Custom prompt" example (demo/prompteditor.ts): a header above a field that grows with its text; Enter sends, Shift+Enter starts a new line.
* **Clicking its column's tab** (the group tab holding it, or a member of a merged pair) **focuses the prompt**: selected, and, out of navigation mode, its field gets the keyboard focus (the prompt-column kind's `focusChild`; the view's `focusShownGroup`).
* **Typing**: pressing in the prompt or focusing its field selects it. (A press that bubbles to the group holder's pane doesn't select the holder: a pane only selects itself on a press whose innermost cell, `.carreau-cell`, is it.) **Submitting** (the editor's `submit`: Enter, in the default one): `submitPrompt(ws, promptId, text)` asks the host what it becomes and inserts it as a new cell just above the prompt (a drop, undoable; `commitDrop(…, focus = false)` keeps the selection on the prompt, in a single render). The default field clears and keeps the focus.
  * The host configures prompts per workspace: `configurePrompts(ws, { submit(text): Tab | null, editor, placeholder })`. Default: a text tab. (Configure before making the view: editors are made on the first render.)
* **Leaving navigation mode on the prompt focuses its field** (its renderer's `commitFocus`). Alt+Q from the field enters navigation mode and takes the focus from it.
* **Secondary focus**: when the prompt is focused, its secondary focus is **the cell just above it** (`secondaryOf(ws, promptId)`; for a split there, its most recently focused cell). In navigation mode it shows with a **dimmer dotted outline** (`.secondary`).
  * **Cell operations act on it**: the module registers it as the prompt's **operand** (`registerOperand("prompt", …)`). Generically, `ws.operand()` is the selection, unless the selected node's type redirects it; the view marks the operand `.secondary` when it isn't the selection.
  * Close tab / pane (W, Shift+W), float (F), rename (%): the keyboard controller acts on `ws.operand()`.
  * Swap (S), move tab (A), insert (I): the workspace runs them through `ws.withOperand(fn)`: the selection is set to the operand, the operation runs, and **the selection goes back**, all as one undo step (restoring the selection). So the secondary is always the cell just above: swapping it up twice swaps the last two cells back.
  * **Group** (G) groups the operand (`ws.group`'s default), then selects the new group so that it can be named in place.
  * **Maximize** (M) maximizes it, and **the focus goes there**: `ws.maximize()` maximizes the operand, and moves the selection to it when it isn't the selection (a maximized prompt alone would show nothing). M again, from it, restores.
  * With no cells, there is no secondary focus (a null operand): those operations do nothing.
  * Closing the secondary doesn't move the focus (it isn't in the closed cell): it stays on the prompt, and the next cell up becomes the secondary.
* **Merging** (tab complexes of the group tabs holding prompt-columns: merge key `"prompt-column"`):
  * Each column knows its cells (`cells`, by child id): an **insertion order** and an **origin** (the tab holding the column the cell came from). Normalization keeps the orders increasing along the column: the most cells keep theirs (a longest increasing subsequence), the others (new, or **moved by hand**) get one between their new neighbours' (at the end: the insertion time). So the order follows the column, manual moves included.
  * One rule, applied whenever a complex changes (its type's `changed`): **every cell goes to its origin's complex's first member's column**, and each column is sorted by order (`reconcile`). So, merged, all the cells are in the first member's column (the one shown), **interleaved by insertion order**; a member that leaves takes its cells back, in their order; reordering the members moves them all to the new first one. A cell without an origin belongs to the tab holding its column.
  * **Typing** in a merged column: the cell comes from the complex's active member (`speakerOf`), which the placeholder says ("(as Bob)").
  * **Closing a member** (`closing`): its cells are handed over to the first other member (re-tagged), so they stay (`mergedClose: "transfer"`, the default); with `mergedClose: "close"` (`configurePrompts`), they go back to its column, and close with it.
  * Demo: the "Merging prompts" example (cells with staggered insertion times).
* Demo: the "Prompt column" example. "$ cmd" becomes a shell cell (canned output for the commands it knows, an error otherwise), anything else a prompt cell with a fake answer (`promptCell` in `demo/cellclasses.ts`, given to `configurePrompts` in `demo/main.ts`).

## Tab complexes (merging)

Tabs can be **merged** into a **tab complex**: in the tab bar, its member tabs with a link icon between them; in the body, one shared view. What merging means depends on the tabs: a **complex type**, chosen by the members' **merge key**.

* **Merge keys**: only tabs with the same key merge; a null key, nothing (`mergeKey(tab)`). A tab's own `key`, or for a group tab, its layout root's kind's `mergeKey` (prompt-columns: `"prompt-column"`). Default: null.
* **Representation**: members are **adjacent tabs of a pane with the same `link`** (an id), otherwise plain tabs. So every tab operation works on them as usual: dragging one out, reordering, activating, closing. Being a member is just being next to the others with their link: dropped anywhere else, a tab has left.
  * Normalization keeps links consistent (`normalizeLinks`): a lone linked tab is unlinked (**a complex of one is replaced by that tab**); a link used by two runs (members that left together) is renamed.
  * `shape()` joins merged tabs with `+` (`[a+b,c]`): merging changes the shape, so it isn't a no-op drop.
* **Display**: a complex shows its **first member's body**, whichever member is active (`shownIndex(pane)`; `activeGroup` follows it, so rects and navigation do too). The active member is still the pane's active tab: it's what the type acts on (the plot to highlight, who types in a prompt).
* **Tab drops and complexes** (`{kind: "tab", paneId, index, join?}`): a tab dropped into a tab bar lands there as a **plain tab, out of any complex** (so a member can leave its complex and stay in the same pane); with `join` (a complex's link), it **joins that complex** there (it must be next to it, and able to merge with it): that's how members are reordered, and how a mergeable tab joins at a given position. A plain tab can't go between two members (it would break the complex); a pane's tabs never join one.
  * The drop UI offers it all with dots: a gap between two members has one dot (joining: reordering, for a member); any other gap has a plain dot, plus, next to a complex, a **join dot just inside it** (a ring rather than a dot), to be at its edge, in it.
* **Dragging a complex** (`{kind: "complex", link}`): its **link icons are drag handles** for the whole complex. It moves as a **block of tabs** and **stays merged**: into a tab bar (as a block: never between two members of another complex; with `join`, its members join that complex), beside a node (a new pane holding it), floated (over its own pane), or merged onto a tab (all its members join that tab's complex, just after it). Not swapped. The model treats a dragged tab as a block of one: the same code (`draggedTabs`, `detachTabs`, `placeTabs`).
  * Its members don't change, so its type isn't told (`changed`): what it shows moves with it.
* **Merging by dragging** (`{kind: "merge", tabId}`, tab and complex subjects): the dragged tab goes **just after the target tab**, linked to it (joining its complex, if it has one), and becomes active. The drop UI offers it as a **link icon over each mergeable tab** of the hovered tab bar (hit over the tab's middle half; the gaps keep their insertion dots), and as a link icon among the pane's center icons (merging with its active tab: for panes without a tab bar).
* **Complex types** (`registerComplex(key, type)`), all hooks optional:
  * `changed(forest, complex, {entered, left})`: the members changed (entered, left, reordered, or one is left: it dissolves). It runs **within the structural change**, on its forest, before normalization (`trackComplexes`, called by `inForest`, so by drops and `ws.change` alike): the type can rearrange the layout in the same, undoable, step. **Drop previews run it too** (every candidate drop is computed): it must only change the forest it's given, nothing else.
  * `closing(forest, complex, tab, ws)`: a member is about to close. The workspace calls it, then **takes the tab out of the complex** (unlinked, just after it: `changed` sees it leave), and only then closes its contents. That is its own undo step; if the close is refused, the tab stays, out of the complex.
  * `show(complex, content)`: the view shows a complex (or a lone tab of the key) with the first member's persistent content element: update it. Called on every render.
  * There is no focus hook: changing the focus between members changes the complex's `active`, which the types read when they act (`show` is called again; a prompt reads it when submitting).
* `Complex`: `{id, key, pane, start, tabs, active}` (`complexAt(pane, i)`, `linkedRuns(pane)`, `canMerge(pane, i, tab)`).
* **Prompt columns** merge (see [Prompt columns](#prompt-columns)): their cells gather in the first member's column, interleaved.
* Demo: the "Plots" example. Plot tabs (`key: "plot"`, demo/plots.ts) merge into one plot area: the "plot" complex type only has `show`, which draws every member's curve in the first member's area, the active one highlighted.

## Closing

Closing a tab or a pane first **closes its contents**, which can take time (ending a process, saving a file) or never finish (an unresponsive process). Only the host knows how, so:

```ts
interface Lifecycle {
  closeTab(tab: Tab): Promise<void>;       // resolves once closed; rejecting refuses the close
  forceCloseTab(tab: Tab): Promise<void>;  // close now, whatever the state; not waited for
  spawn?(from: Tab): Tab | null;           // the new cell a cell creates (see ws.spawn)
  commitFocus?(tab: Tab, content: HTMLElement | null): void;  // see "Committing the focus"
}
ws.lifecycle = { … };                       // default: instant (`instantLifecycle`)
```

* **Every node kind has `close(n, life)` and `forceClose(n, life)`.** A content tab closes through the lifecycle; a group tab closes its layout (`closeTabWith(tab, life, force?)`). A pane gathers its tabs' closes, and a split or slot its children's (`Promise.all`). So **a group's close waits for every tab in it**, at any depth.
* `ws.closeTab(tabId)` and `ws.closePane(paneId)` return a `Promise<boolean>` (whether it closed):
  1. Record a **pending close** for the tab (a pane's covers all its tabs), and re-render. Pending closes are transient UI state: not part of the layout, not undoable. Closing what is already closing is ignored.
  2. Await the node's `close()`.
  3. Resolved: remove the tab or pane (one undoable change), moving the focus as for any close. Rejected: the close is refused; drop the pending state, and the tab stays.
* `ws.forceClose(tabId)`: for the pending close covering that tab (or the tab alone), call `forceClose()` **without waiting** (errors ignored), drop the pending state and remove it right away. The original `close()` resolving later then does nothing: completions check that their pending close is still the current one.
* Removal checks again that it can happen (the main tree must keep a tab); if not, the tab stays.
* **Display**: while a tab is closing, its × is replaced by an **idle animation**: a rotating arc (a conic gradient in the tab's accent, masked to a ring, 0.9s per turn). Its title and icon fade a little.
  * **Hovering** it shows a small **red ×** inside the arc; clicking it force-closes. (It stops pointerdown, so it's not a drag.)
  * Re-renders recreate the element: give it a negative animation delay from the clock (`-(now mod 0.9s)`), so the rotation doesn't restart on every render.
  * A cell with no tab bar shows the arc at the right end of its top strip (an empty strip grows to fit it).
* Demo lifecycle: shell cells (whose `long` starts with `$`) take 1.2s to close; tabs with status `"unresponsive"` never finish closing, until forced; everything else closes at once.

## Floating windows

A floating window holds **a whole layout tree**, so everything that works in the main tree works inside it: splitting it at its edges, tab bars, thirds, swap, between-siblings lines and splitters. Things move freely between the main tree and windows (see [Drop targets](#drop-targets-model)).

* **Creating.** Float (from the ⋯ menu, or the cloud icon) pulls a pane, or a tab, out into a new window.
  * Its initial rect is the pane's current rect scaled to 80% (at least 240×160) and centered on it, so it visibly lifts off.
  * Ids and tab contents carry over, so iframes survive.
* **Rendering.** Windows go in a layer above the tree and the selection outline, but below the drop overlay. The layer clips windows to the workspace. Each window has:
  * a slim grey **title bar** at the top;
  * the tree itself, whose panes have their headers at the bottom as usual;
  * a drop shadow;
  * **resize handles on all four corners and four edges**, overhanging the border slightly. The minimum size is 160×100.
* **Inside a window**, panes, tabs and headers behave as in the main tree: drag them anywhere, including out of the window. The differences: no ⋯ menu, no double-click maximize, and no maximization. A window whose tree becomes empty closes.
* **Raising.** Pressing anywhere on a window raises it. Reorder the window list, and move the element to the end of the layer **with `moveBefore`**: re-appending it would reload its iframes.
* **Windows never leave the workspace.**
  * When moving, the rect is clamped so the whole window stays inside, even if the pointer goes further.
  * When resizing, each edge stops at the workspace boundary and at the minimum size. A west or north edge moves `x`/`y` while the opposite edge stays fixed.
  * Windows are re-clamped on every placement, including render, and when the workspace changes size (a ResizeObserver). They shrink if the workspace became smaller than them.
* **Moving.** Dragging the **title bar** moves the window, following the pointer with pointer capture. Iframes get `pointer-events: none` meanwhile.
* **Docking requires holding still.** Once the window has been dragged, if the pointer stays within 4px for **1 second**, the drag switches to docking.
  * A grey progress ring around the cursor appears after 150ms and fills over the rest of the second. Moving beyond the tolerance restarts the timer.
  * The timer does not start on a mere press of the bar.
  * While docking, the window turns translucent with `pointer-events: none`, so hit-testing sees through it, including to other windows. It keeps following the cursor (still clamped), and the regular drop UI appears.
* **Releasing** on an active choice docks the window's **whole tree** as an `external` subject, with the window itself excluded from the drop. Releasing anywhere else, or after Esc, leaves the window floating.
  * Pitfall: on release, run the final hit test and commit **before** making the window opaque and hit-testable again. Otherwise the hit test finds the window itself, and nothing docks.


## Tab contents and embeds (iframes)

Tab contents must survive any relayout: moves, drops between trees, floating, docking, tab switches, re-renders. An iframe that is removed from the document, even for a moment, is unloaded.

* **One persistent content element per tab id.** Create it once, by calling the host's `renderTab`, wrap it in a `.carreau-content` div, and cache it. When a tab leaves all trees entirely (a new layout is loaded), drop its element.
* **All tabs' contents live in their pane's body**, in whichever tree. Inactive ones are just hidden (`hidden` / `display: none`), which does not unload iframes.
* **Move contents with `Element.moveBefore`**, which keeps iframes, focus and so on alive. Fall back to `appendChild` when it is missing (iframes then reload). `moveBefore` only preserves state when the node and the destination are both connected to the same document. So the renderer must:
  1. build the new main tree and window elements;
  2. **attach them next to the old ones**;
  3. move each content element into its new pane body;
  4. only then remove the old elements.

  Never build a detached tree and `replaceChildren`: the old tree, iframes included, is torn down first.
* Pitfall: while old and new are both attached, look pane bodies up **inside the new elements**. A document-wide `querySelector('[data-id=…]')` finds the old pane first. The content then stays in the old tree and dies with it.
* Because contents persist, the host's `renderTab` output must not show layout facts that change, such as the pane id or weight.
* The demo uses tab `data` to say what to embed (a YouTube id, or a stateful `srcdoc` page), plus an optional fixed height for scroll cells. YouTube embeds need a referrer (`referrerpolicy="strict-origin-when-cross-origin"`), or they fail with error 153.
* **Pointer events.** Iframes swallow pointer events, so during tab or pane drags, splitter and window resizes, and window moves:
  * set `pointer-events: none` on all iframes in the workspace;
  * call `setPointerCapture` on the element that started the gesture.
* **Focus.** A click inside an iframe fires no event in the host document. Instead, on window `blur`, check on the next tick whether `document.activeElement` is an iframe inside the workspace, including in windows. If it is, select its pane.
* **Keyboard.** Keys typed while focus is inside an iframe go to that iframe's window, so the host's key bindings don't see them. Same-origin frames can forward them (`bridgeFrameKeys`, below); cross-origin frames cannot without the embedded page's cooperation.

### Committing the focus

Navigation mode moves the *selection*; the keyboard focus stays in the host page. **Leaving navigation mode commits the focus to the focused cell**: the view calls the host's `lifecycle.commitFocus(tab, content)` with the selected pane's active tab and its persistent content element (null for a group tab). The cell decides what to do; by default, nothing.

* It is called when the mode ends by the user's action (releasing the modifier in held mode, the activation key or Esc in sticky mode), not when it ends because the window lost focus (the focus went elsewhere: taking it back would steal it).
* Not for a range or split selection (`clearMultiSelection` runs first, so usually it's a pane).
* **Getting back out of an iframe**: `bridgeFrameKeys(iframe)` (keyboard.ts) forwards a same-origin iframe's `keydown`/`keyup` events to the host window as synthetic events, in the capture phase of the iframe's document. If the host cancels one (the controller handled it: Alt+Q, then navigation keys), the original is cancelled too, so it doesn't type into the iframe. The bridge is re-installed on every `load` (each new document; marked on the document, since an iframe's initial window object can be reused).
  * The keyboard controller ignores a synthetic event's target (the window) for its "typing in a text field" check, so Alt+Q works even from a text field inside the iframe: that's the way out.
  * **Entering navigation mode takes the focus back** from anything inside the workspace: an iframe (`blur()` it, focus the window), a prompt's field, a title being edited (which confirms it). The following keys then reach the host directly.
  * Cross-origin iframes (YouTube) can't be bridged: once focused, Alt+Q can't get out of them; click outside.
* Demo: the cell classes (`demo/cellclasses.ts`) implement it. A stateful page (same origin, bridged) focuses its text field: leave navigation mode on it and type, Alt+Q to get out. A video focuses the player. Text cells do nothing.


## Scroll splits

In a `scroll-column`, children take their **natural height** (their content decides it) and the column scrolls vertically. A `scroll-row` is the same horizontally. Weights are ignored along the scroll axis.

* **Never created by moves.** Drops can insert *into* a scroll split, along its axis: at its start or end, beside a cell, or between two cells. Any wrapper created by a drop is a plain row or column.
* **Natural sizing.** Propagate a per-axis "natural" flag down the tree, through the contexts (`Ctx.natural`, `Ctx.sizedAlong`; see [Node kinds and contexts](#node-kinds-and-contexts)). Inside a scroll split along axis A, and inside any plain A-split whose own A-size is natural, children get `flex: none` along A, and the class `carreau-natural-<A>`.
  * Pitfall: with weight flex (`flex: w 1 0`) and `min-height: 0`, children of a column that has an indefinite height collapse to 0. This happens, for example, to a column inside a row inside a scroll-column.
  * The cross axis still stretches. A row inside a scroll-column is as tall as its tallest cell.
  * Panes get a small minimum size: 60px tall in a scroll-column, 120px wide in a scroll-row.
* **A scroll split always occupies its whole allocation**, like any other child (weight flex), even when its content is shorter. The space after the content is empty padding.
  * Give the scroll split a panel background of its own: slightly darker than panes, with rounded corners and the pane outline. Otherwise that padding shows the page background and the split looks as if it ended with its content.
  * A scroll split nested *inside* a scroll split along the other axis is naturally sized along the outer axis, as any child there.
* **No splitters** between naturally sized children; draw a fixed 4px gap instead.
* **Keep scroll positions across re-renders.** Keep the last known `scrollLeft`/`scrollTop` of every scroll split (by id), and of every tab scroller (by pane id), in a map, and restore it after rebuilding. Otherwise every click resets the scroll.
  * Update the map from `scroll` events (capture phase on the workspace), and from the elements' current values before rebuilding, but **only for visible elements**.
  * A scroll split hidden in an inactive group tab (`display: none`) has lost its offset and reads 0. Reading it would erase its position, and switching back to its tab would reset the scroll.
* **Navigation** still uses logical rects from weights, which treats scroll children as equal shares. Within the scroll split, up and down follow the true order. Coming in from the side picks a pane by its logical position, which may be off-screen; scrolling the selection into view handles that.
* **Clipping.** Every overlay is clipped to the *visible* rect of the nodes involved: the node's rect intersected with the client rect of each scroll ancestor, up to the tree's layer. This covers the selection outline, the border lines, tab dots, zones and previews.
  * A side whose border is scrolled out of view gets no line. Detect it by comparing the full rect's edge with the visible rect's edge, **with a ~2px tolerance**. At a scroll split's very end, fractional pixels can leave the last cell's edge slightly past the viewport's, and that edge must still count as visible.
  * Dedupe by distinct boundary using **full** spans. Clipped spans of different nodes can coincide.
  * Draw with visible spans.
* **Sticky scroll splits** (`reverse: true`): they stick to their **end** (bottom / right) instead of their start, like a terminal or a chat. Like CSS `flex-direction: *-reverse` in effect, but **the order of the children is unchanged**: the first child is still at the top / left, so navigation, drops and indices need no special case.
  * Short content sits at the end: an **auto margin** on the first child (`margin-top: auto`, or `margin-left: auto` for a row). Not `justify-content: flex-end`: content overflowing at the start would be unreachable by scrolling.
  * The scroll memory also records whether each split is scrolled to its end (1px tolerance). A sticky split that was at its end, or was never scrolled, is put back at its end after every render, instead of at its old offset. So appending cells keeps the newest in view.
  * Content growing without a render (a cell's output getting longer) is followed too: a `ResizeObserver` on the sticky splits' children scrolls them back to the end if they were there. Scrolled away from the end, they stay put.
  * Drop lines need nothing special: a scroll split's start border is its first child's (see [Choices per side](#choices-per-side-of-the-hovered-pane-p)), so a short sticky column still takes insertions right above its first cell.
  * Only scroll splits may have the flag (validated on load). Flattening a scroll split into its parent of the same type keeps the parent's flag.
* **Scrolling during a drag** (mouse wheel) moves everything. Listen for `scroll` in the capture phase on the workspace. Re-run the hover logic for the last pointer position, rebuilding the indicators, and refresh the selection outline.


## Tunable constants

| What | Value |
|---|---|
| Drag start threshold | 5px |
| Splitter / gap | 4px; 30px minimum per neighbour |
| Border line thickness | 8px |
| Dash length / gap between dashes / gap between halves | 18px / 1px / 1px |
| Swap and cloud icon radius | 22px |
| Tab dot radius | 3.5px, 5.5px when active |
| Handle area minimum in the header | 24px |
| Esc cooldown | 0.5s |
| Hold-to-dock | 1s still within 4px; ring appears after 150ms |
| Floating window minimum / initial size | 160×100 / 80% of the pane, at least 240×160 |
| Scroll cell minimum | 60px tall (scroll-column), 120px wide (scroll-row) |


## Easy pitfalls (summary)

* Keep ids valid during a drop by detaching with a tombstone, inserting, and only then removing the tombstone and normalizing.
* For drops across trees, wrap each tree in a slot inside a transient forest (`inForest`). Tree roots then behave like group roots: no siblings, removal empties the slot.
* Normalize after every mutation, including on load. Otherwise rows of rows survive, and so do single-child splits. But never collapse a single-child scroll split.
* Use `kind(n).axis` for every orientation check; scroll splits have their own types.
* Don't test nesting ("a pane inside a scroll split"): pass contexts down (`childContext`) and let each node decide (`paneDisplay`); ask kinds for structural rules (`sides`, `navStep`).
* Navigate with logical rects from weights, not DOM rects.
* An overlay with `pointer-events: none` needs manual hit-testing, and `elementsFromPoint` to find the pane underneath.
* Keep the hovered pane while over gaps inside the workspace. Make straddling hit areas cover the whole gap.
* Dedupe line levels by their *resulting layout, sizes included*, keeping the innermost, and leave out what the hovered pane's own thirds and the between choice already offer.
* Anchor dash phases to absolute coordinates.
* Compute "1/N" while excluding what is leaving the split.
* Weight swaps on pane swap keep the geometry fixed, which is what makes swap/unswap exact.
* Filter every candidate choice through the drop function, including the shape no-op test, so the UI never offers pointless drops.
* A focused text field moved with `moveBefore` must be re-focused (Chrome stops feeding it text). Don't let focus handlers re-render during a render.
* Persist tab contents and move them with `moveBefore`, attaching new elements before removing old ones, and looking bodies up in the new elements only. Reorder windows with `moveBefore` too.
* Disable iframe pointer events and capture the pointer during every gesture.
* After Esc, block drag restarts for a moment, since the button is still down.
* Restore scroll positions (scroll splits and tab scrollers) after every re-render.
