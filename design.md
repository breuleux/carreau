# Carreau

Carreau is a tiling system implemented in TypeScript (no framework; plain DOM + one SVG overlay).

A workspace is a hierarchy of **rows** and **columns** whose leaves are **panes**. Each pane holds one or more **tabs**. The user can navigate it with key-bound commands, resize it with splitters, and relocate tabs or panes by dragging.

The prototype consists of:

* `model.ts`: the pure, serializable layout tree, plus normalization, insertion, swap and drop logic. No DOM.
* `workspace.ts`: state on top of the tree (selection, maximization, navigation memory) and the command set. No DOM, no key bindings.
* `view.ts`: DOM rendering, splitters, CSS-only maximization, the selection outline, and drag and drop with the overlay.
* A demo page: an example picker, a keymap, a command legend, a live JSON view with a "load JSON" button, and a status line showing the selection and the maximization.


## Representation

The layout is plain JSON-serializable data:

```ts
type Tab = { id: string; title: string; content?: string };
type Pane = { type: "pane"; id: string; weight: number; tabs: Tab[]; active: number };
type Split = { type: "row" | "column" | "scroll-row" | "scroll-column"; id: string; weight: number; children: Node[] };
```

`axisOf(type)` maps `row` and `scroll-row` to the row axis, and `column` and `scroll-column` to the column axis.

**Every** orientation check must use `axisOf` rather than comparing `type` to `"row"` or `"column"`. That includes insertion, `computeRects`, expand, the drop chain, splitter direction and the preview orientation.

* `weight` is a node's relative size within its parent. A child's fraction is `weight / sum(sibling weights)`. Render each child with `flex: <weight> 1 0`.
* Deserialization validates the tree, defaults missing weights to 1, and clamps `active`.
* The full serialized state is `{root, floating}`. `floating` is a list of `{root, rect}` floating windows: **each window holds a whole layout tree**. `rect` is in pixels relative to the workspace, and the last window is frontmost. Loading also accepts a bare tree, and the older `{pane, rect}` window format.

### Normalization

Normalization runs after every structural change, on construction, and on load. It:

* drops panes with no tabs and splits with no children;
* collapses a split with a single child into that child, which inherits the split's weight;
* flattens a split nested in a split of the same orientation. A row of rows is just a row. The inner children's weights are rescaled so that together they keep the inner split's share: `w_k' = w_k / sum(w) * inner.weight`.

Scroll splits add three rules:

* A **scroll split is never collapsed** for having a single child. It could not be recreated by dragging.
* A plain split of the same axis directly inside a scroll split is flattened into it, because its children are naturally sized either way.
* A scroll split inside a plain split is **not** flattened; it is what provides the scrolling.

### Logical geometry

`computeRects(root, frame)` gives every node's rectangle from the weights alone, in the unit square or any given frame. Navigation uses these logical rectangles, never DOM rectangles, so it is unaffected by maximization, tab bars and gaps.


## Floating windows

**Selection spans all trees.** Clicking a pane or tab in a window selects it: its active tab shows its accent, and the main screen loses its highlight.

* Node lookup covers all trees. Navigation (parent, child, focus, expand, swap, tab cycling) works within the tree that holds the selection.
* Maximization stays main-tree only: maximize is ignored for a selection in a window, and a maximization that would end up outside the main tree is dropped.
* When the selection outline (a row, column or range) is inside a window, draw it above the window layer.
* **Windows never leave the workspace.**
  * When moving, the rect is clamped so the whole window stays inside, even if the pointer goes further.
  * When resizing, each edge stops at the workspace boundary and at the minimum size. A west or north edge moves `x`/`y` while the opposite edge stays fixed.
  * Windows are re-clamped on every placement, including render, and when the workspace changes size (a ResizeObserver). They shrink if the workspace became smaller than them.

**Each window holds a layout tree**, so everything that works in the main tree works inside a window: splitting it at its edges, tab bars, thirds, swap, between-siblings lines and splitters. Things move freely between the main tree and windows.

* **Float** (from the ⋯ menu or the cloud icon) pulls a pane, or a tab, out into a new window.
  * Its initial rect is the pane's current rect scaled to 80% (at least 240×160) and centered on it, so it visibly lifts off.
  * Ids and tab contents carry over, so iframes survive.
* **Rendering.** Windows go in a layer above the tree and selection outline, but below the drop overlay. Each window has:
  * a slim grey **title bar**;
  * the tree itself;
  * a drop shadow;
  * **resize handles on all four corners and four edges**, overhanging the border slightly. The minimum size is 160×100.
* **Inside a window**, panes, tabs and headers behave as in the main tree: drag them anywhere, including out of the window. The differences: there is no ⋯ menu, no double-click maximize, and no maximization. A window whose tree becomes empty closes.
* **Raising.** Pressing anywhere on a window raises it. Reorder the window list, and move the element to the end of the layer **with `moveBefore`**: re-appending it would reload its iframes.
* **Moving.** Dragging the **title bar** moves the window freely, following the pointer with pointer capture. Iframes get `pointer-events: none` meanwhile.
* **Docking requires holding still.** Once the window has been dragged, if the pointer stays within 4px for **1 second**, the drag switches to docking.
  * A progress ring around the cursor appears after 150ms and fills over the rest of the second. Moving beyond the tolerance restarts the timer.
  * The timer does not start on a mere press of the bar.
  * While docking, the window turns translucent with `pointer-events: none`, so hit-testing sees through it, including to other windows. It keeps following the cursor, and the regular drop UI appears.
* **Releasing** on an active choice docks the window's **whole tree** as an `external` subject, cloned in with no detach, with the window itself excluded from the drop. Releasing anywhere else, or after Esc, leaves the window floating.

### Drops across trees

`applyDropForest(trees, subject, target)` runs a drop over the main tree (`trees[0]`) plus the windows' trees.

* Put all the trees as the children of a temporary root with a reserved id, so that `find`, the tombstone, insertion and swap all work across trees unchanged. Then:
  * Never normalize that root as a split; normalize each tree separately.
  * Never insert *as a sibling* at that level. `insertBeside` on a tree root must wrap the root instead, or the drop would create a new tree.
  * Removing a tree root (moving a window's only pane out, or tombstone removal) must leave an **EMPTY marker** in place, not splice. Splicing would shift tree indices.
* The result is `{trees, paneId, floated?}` with `trees` in input order, and **null for an emptied tree**. The window closes.
* A drop that would empty the **main** tree is invalid.
* Floating a window's only pane again is a no-op.
* The shape no-op test compares all trees.
* An external subject can be a whole tree. It can join a tab bar only if it is a single pane, and it can't swap.
* The view resolves everything per tree:
  * chains stop at the root of the hovered pane's own tree, so a window's edges behave like the workspace edges;
  * element lookup covers the float layer;
  * visible-rect clipping stops at the layer;
  * hover hit-testing accepts panes in windows; the topmost window wins.

## Tab contents and embeds (iframes)

Tab contents must survive any relayout: moves, drops, tab switches, re-renders. An iframe that is removed from the document, even for a moment, is unloaded.

* **One persistent content element per tab id.** Create it once, by calling the host's `renderTab`, wrap it in a `.carreau-content` div, and cache it. When a tab leaves the layout entirely (a new layout is loaded), drop its element.
* **All tabs' contents live in their pane's body.** Inactive ones are just hidden (`hidden` / `display: none`), which does not unload iframes.
* **Move contents with `Element.moveBefore`**, which keeps iframes, focus and so on alive. Fall back to `appendChild` when it is missing (iframes then reload). `moveBefore` only preserves state when the node and the destination are both connected to the same document. So the renderer must:
  1. build the new tree;
  2. **attach it next to the old one**;
  3. move each content element into its new pane body;
  4. only then remove the old tree.

  Never build a detached tree and `replaceChildren`: the old tree, iframes included, is torn down first.
* Pitfall: while both trees are attached, look pane bodies up **inside the new tree**. A document-wide `querySelector('[data-id=…]')` finds the old pane first. The content then stays in the old tree and dies with it.
* Because contents persist, the host's `renderTab` output must not show layout facts that change (pane id, weight).
* Tabs may carry arbitrary serializable `data`. The demo uses it to say what to embed (a YouTube id, or a stateful `srcdoc` page), plus an optional fixed height for scroll cells.
* YouTube embeds need a referrer (`referrerpolicy="strict-origin-when-cross-origin"`), or they fail with error 153.
* **Pointer events.** Iframes swallow pointer events, so during a tab or pane drag and during splitter resizes:
  * set `pointer-events: none` on all iframes in the workspace;
  * call `setPointerCapture` on the element that started the gesture.
* **Focus.** A click inside an iframe fires no event in the host document. Instead, on window `blur`, check on the next tick whether `document.activeElement` is an iframe inside the workspace. If it is, select its pane.
* **Keyboard.** Keys typed while focus is inside an iframe go to that iframe's window, so the host's key bindings don't see them. Same-origin frames can forward them; cross-origin frames cannot without the embedded page's cooperation.

## Scroll splits

In a `scroll-column`, children take their **natural height** (their content decides it) and the column scrolls vertically. A `scroll-row` is the same horizontally. Weights are ignored along the scroll axis.

* **Never created by moves.** Drops can insert *into* a scroll split, as a sibling along its axis or between two cells. Any wrapper created by a drop is a plain row or column.
* **Natural sizing.** Propagate a per-axis "natural" flag down the tree. Inside a scroll split along axis A, and inside any plain A-split whose own A-size is natural, children get `flex: none` along A.
  * Pitfall: with weight flex (`flex: w 1 0`) and `min-height: 0`, children of a column that has an indefinite height collapse to 0. This happens, for example, to a column inside a row inside a scroll-column.
  * The cross axis still stretches. A row inside a scroll-column is as tall as its tallest cell.
  * Panes get a small minimum size: 60px tall in a scroll-column, 120px wide in a scroll-row.
* **No splitters** between naturally sized children; draw a fixed 4px gap instead.
* **Keep scroll positions across re-renders.** If the view rebuilds the DOM, save `scrollTop` and `scrollLeft` per scroll split id and restore them after rebuilding. Otherwise every click resets the scroll.
* **Scroll the selection into view.** When the selection changes (including through navigation), call `scrollIntoView({block: "nearest", inline: "nearest"})` on it.
* **Navigation** still uses logical rects from weights, which treats scroll children as equal shares. Within the scroll split, up and down follow the true order. Coming in from the side picks a pane by its logical position, which may be off-screen; scrolling it into view handles that.
* **Clipping.** Every overlay is clipped to the *visible* rect of the nodes involved: the node's rect intersected with the client rect of each scroll ancestor. This covers the selection outline, the border lines, tab dots and previews.
  * A side whose border is scrolled out of view gets no line. Detect it by comparing the full rect's edge with the visible rect's edge.
  * Dedupe by distinct boundary using **full** spans. Clipped spans of different nodes can coincide.
  * Draw with visible spans.
* **Scrolling during a drag** (mouse wheel) moves everything. Listen for `scroll` in the capture phase on the workspace. Re-run the hover logic for the last pointer position, rebuilding the indicators, and refresh the selection outline.


* Splits are flex containers. A 4px splitter element sits between consecutive children.
  * Dragging a splitter moves weight between the two neighbours, keeping their sum constant.
  * Each neighbour has a 30px minimum.
  * While dragging, update the flex styles directly. Emit a change on release.
* A pane is a body plus a header (the tab bar) **at the bottom**. The header holds, from left to right:
  * the tabs: click to activate and select; drag to move the tab;
  * the **empty rest of the header**, which is the pane's handle: drag it to move the whole pane, click it to select the pane. There is no separate grip;
  * a **⋯ button** at the right end.
* **Tabs never shrink or abbreviate.** They sit in a horizontal scroller with its scrollbar hidden, and the empty handle area keeps at least 24px.
  * A shadow fades in at the left or right end when there are more tabs that way. Update it on scroll, and whenever sizes may have changed (render, resize, splitter drags).
  * A plain vertical mouse wheel over the tabs scrolls them sideways.
  * Save and restore each pane's tab scroll position across re-renders.
  * When the focused pane's active tab changes (a click, nextTab), scroll it into view.
* **Header style.** The header and the content share the same background color. A 1px grey line separates the header from the content above it.
  * Every tab's text is faded, except the **selected** tab, meaning the active tab of the focused pane.
  * The active tab of *each* pane has a 2px line drawn over the grey line, at the top of the tab. It is mid grey, or the tab's accent color when its pane is focused.
  * There are no separators between tabs and no background differences.
* A drag starts only after the pointer has moved 5px; below that, it is a click.
* **Double-clicking a tab** selects its pane and maximizes it, or restores if that pane is already the maximization.
* The ⋯ button opens a small **pane menu** above it (the header is at the bottom), right-aligned with it.
  * The menu offers **Float**, disabled for the last pane in the tree.
  * Clicking ⋯ again toggles the menu closed, and any other pointerdown closes it. Exclude the anchor from the outside-click check, or the toggle reopens it immediately.
  * Stop `pointerdown` propagation on ⋯, so it doesn't select the pane and re-render (which would replace the anchor).
* **Colors are mostly neutral greys.** Panes, splits, selection outlines, previews, icons and tab dots carry no accent color.
* **Each tab has an accent color**, derived from a hash of its id into a small palette of oklch hues (L 0.74, C 0.13). Duplicates are fine.
  * The color is shown **only on the active tab of the focused pane**, as its underline on the header's grey line. That underline is the focus indicator for panes.
  * Other panes' active tabs get a mid-grey line.
* **Selection** of a row, column or range is a dim grey dashed outline over the union of the selected nodes' DOM rects, with a very faint fill. A selected *pane* gets no outline; its tab accent shows it. The outline is hidden while dragging.


## Selection and navigation

No keyboard shortcuts are hard-coded in the library. The workspace exposes named commands and the host app maps keys to them.

Pitfall for the demo keymap: match on `KeyboardEvent.code`, not `key`, because on macOS Alt+letter produces special characters. Also, macOS takes Ctrl+Arrow for Mission Control.

A **selection** is either a single node `{id}`, or a contiguous range of children of a split, `{id: splitId, range: [lo, hi]}`. A range covering every child is normalized to `{id: splitId}`.

Memory kept by the workspace:

* **last child**: for each container, which child was last on the path to the selection. It is updated on every selection change.
* **boundary memory**: `"<nodeId>:<side>"` maps to the selection we arrived from through that side.
* **expand stack**: the selections that preceded each consecutive expand. Any other selection change clears it.
* **maximization history**: the stack of previous maximized selections (null means not maximized).

Commands:

* **nextTab / prevTab**: cycle the active tab of the selected pane.
* **parent**: the parent of the selected node. From a range, the split itself.
* **child**: the last-focused child of the selected container, restricted to the range if one is selected. Falls back to the first child.
* **focus left/right/up/down**, using logical rects. Let S be the selection's rect.
  1. If boundary memory has an entry for `selection:side` and that node is still adjacent on that side with positive overlap, go there.
  2. Otherwise, consider the panes whose opposite edge touches S's edge (EPS 1e-6) with positive overlap along the edge. Pick the one with the highest score: `overlap + (10 if it contains the center of S along that edge)`.
  3. Record `boundary[target:opposite(side)] = previous selection`, so that up, down, up returns to where you started.
* **expand left/right/up/down**:
  * If the selection is a range in a split of the matching orientation and can grow on that side, grow it by one.
  * Otherwise walk up from the node. At the first ancestor whose parent has the matching orientation and a sibling on that side, select the range `[node, sibling]` in that parent.
  * Push the previous selection onto the expand stack.
* **unexpand**: pop the expand stack. If the maximization was equal to the selection, it shrinks along with it.
* **swap left/right/up/down**: panes only.
  * Find the neighbour as for focus, with boundary memory restricted to panes.
  * Exchange the two nodes in their parents' children arrays, and exchange their weights too, so the geometry stays the same and only the contents move.
  * The selection stays on the moved pane. Record boundary memory in both directions, so that the opposite swap exactly undoes it even when several panes border that side.
  * Skip normalization. With panes only, a swap cannot create nesting that needs flattening.
* **maximize**: if the selection is not already the maximization, push the current maximization onto the history and maximize the selection.
* **restore**: pop the history. This returns to the *previous view*, which may itself be maximized.
* While maximized:
  * **parent** and **expand** grow the maximization to match the selection, replacing it without pushing to the history.
  * **focus** moves the maximization to the new selection only if the selection left the maximized region.
  * **child** leaves it alone.

**Maximization is CSS only**; the DOM structure is untouched.

* On the path from the root to the maximized node, add a hiding class to every child that is not on the path, and to any splitter adjacent to a hidden child.
* For a range, also hide the maximized split's children outside the range.
* Path nodes are forced to `flex: 1 1 0`.


## Drag and drop

### During a drag

* The source (a tab, or the whole pane when dragging its header) is grayed out with low opacity and grayscale.
* A ghost label with the tab's title follows the cursor.
* The layout is **not** re-laid out during the drag.
* A single SVG overlay with `pointer-events: none` covers the workspace. All indicators are drawn there and hit-tested in JavaScript.
* Esc cancels. The pointer is still down, though, so the next move would immediately start a new drag and reactivate a drop zone. After Esc, a **0.5s cooldown** prevents any drag from starting; moving after it resumes the drag. Releasing during the cooldown does nothing.
  * For a floating window being docked, Esc returns to plain moving. The window is opaque again and docking needs a new one-second hold.
* Releasing over an active choice commits it with `setRoot(result.root)` and selects the pane that received the drop.

### Hovered pane

The hovered pane is the first `.carreau-pane` under the cursor, found with `elementsFromPoint`.

Pitfall: when the cursor is over a splitter gap, or anywhere inside the workspace that is not a pane, **keep the previously hovered pane**. Otherwise indicators flicker off while crossing borders.

Lines and tab dots are rebuilt only when the hovered pane changes.

### Drop targets (model)

```ts
type DropTarget =
  | { kind: "side"; targetId; side }       // beside a node (edge insertion)
  | { kind: "between"; splitId; index }    // between two siblings of a split
  | { kind: "tab"; paneId; index }         // into a pane's tab list at a position
  | { kind: "swap"; paneId }               // exchange contents with a pane
  | { kind: "float"; paneId };             // pull the dragged thing out into a floating window
type DragSubject = { kind: "tab"; tabId } | { kind: "pane"; paneId } | { kind: "external"; node };
```

`applyDrop(root, subject, target)` returns `{root, paneId}` or null. It always works on a clone.

1. **Detach** the subject without invalidating ids along the target's path.
   * **Pane**: replace it in its parent with a tombstone pane, which has no tabs and keeps the weight.
   * **Tab**: splice it out of its pane, which may become empty and then acts as a tombstone. Fix the source pane's `active`.
   * A tab dropped on a tab target is inserted directly. If it lands in the same pane, decrement the index when the source index is before it.
2. **Insert**:
   * `side`, on node X:
     * If X's parent is split along that side's axis, insert as a sibling before or after X. The new node takes **half of X's weight**.
     * Otherwise wrap X in a new split of that axis, `[new, X]` or `[X, new]`, with weights 1 and 1. The wrapper takes X's old weight. At the root, the wrapper becomes the root.
   * `between`: insert at `index` in the split. The weight is chosen so that the new pane gets **1/N of the split**, where N counts the new pane.
     * Compute `weight = sum(w) / n` over the children that stay.
     * Exclude the tombstone and any pane that has become empty.
   * `tab`: splice the tabs into the destination pane at the index, and make the first of them active.
3. Remove the tombstone and normalize.

`swap` is handled up front, without detaching anything:

* **Dragged tab:** the tab trades places with the target pane's *active* tab. Each tab lands at the other's index, and the panes' `active` indices are unchanged.
* **Dragged pane:** the two panes exchange their whole tab lists and their `active` indices. The geometry is unchanged.
* Swapping with your own pane is null.

`float` is only valid over the dragged thing's **own** pane. The result carries `floated`, the pane to show as a window, which is not in the resulting `root`.

* **Dragged pane, or a tab that is alone in its pane:** remove the pane from the tree and float it. Null for the last pane in the tree.
* **Tab among others:** remove the tab and float it in a new pane of its own.

Invalid and no-op drops return null. Those choices are simply not offered in the UI.

* Dropping a pane beside, or into the tabs of, itself.
* Moving the only pane.
* `between` right next to the subject's own pane, at its index or index + 1, for a pane, or for a tab whose pane would become empty.
* Dropping a tab back into its own slot in the same pane (index equal to its own, or one more).
* **The general rule**: if `shape(result) === shape(original)`, the drop is pointless. `shape` ignores ids and weights: it covers orientation, nesting and the tab ids in each pane.
  * This catches a lone tab, or a pane, dropped on a border it already occupies, even when only sizes would change.
  * A tab that has siblings can still split off beside its own pane.

### Choices per side of the hovered pane P

For each side of P:

1. **Chain**: start at P and walk up while the node is not separated from a sibling on that side. Stop at the first node whose parent has the side's orientation and a sibling on that side, or at the root. The chain lists these nodes outermost first; all of them share P's edge.
2. If the walk stopped because of a sibling, the outermost choice is **between** those two siblings: `{between, split, index}`. Its span is the chain top's extent along the edge. Call such a side a *straddling* side.
3. The remaining chain nodes give `side` choices, with **one choice per distinct boundary**.
   * Group consecutive nodes whose extent along the edge is the same, within 1px. A row's first child shares its left edge with the row, for example.
   * From each group, keep the **innermost** node whose drop is valid.
   * **Leave out the group containing P itself**: P's own boundary, and any ancestor sharing exactly that boundary. P's edge thirds already offer "beside P", so lines only show insertions into enclosing groups. That is the `between` choice plus the outer `side` choices.
   * The same applies to each neighbour's line drawn on the other side of a border.
4. Each choice has a `span`: its node's extent along the edge, in pixels. Choices are ordered outermost (longest) first.

### The border line

A border line is shown **only while the cursor is over it**: the cursor must be within the line's band across the edge. Nothing is drawn while merely approaching a border. If two bands contain the cursor (at a corner), pick the side whose border is nearest.

**Geometry**: the line is 8px thick.

* At a workspace edge, it lies inside P along the edge.
* On a straddling side, P's half runs from the middle of the splitter gap inwards into P.
* Pitfall: the **hit area** on a straddling side must cover the *whole* gap, from the far sibling's edge to the inner end of P's half. P's drawn half only starts at the middle of the gap. Since the hovered pane is kept over gaps, a hit area equal to the drawn half would leave the far half of the gap matching nothing, and the line would vanish right on the separator.

**Dashes**:

* Cut the line at every choice's span endpoints. Each stretch is covered by some set of choices, ordered outermost first.
* A stretch with one choice is drawn solid.
* A stretch with several choices is drawn as 18px dashes cycling through them: `levels[k mod n]` for `k = floor(v / 18)`.
  * Anchor dashes to **absolute** coordinates, so they don't shift as the line changes and so the two halves of a border line up.
  * Leave a **1px visual gap** at the end of each dash. Hit-testing ignores the gap.
* **Selecting**: the active choice is the dash under the cursor's position along the edge.
* Because P's span lies inside every chain node's span, P's stretch shows all of P's group choices dashed. Stretches beyond P only show the outer ones.
  * Example: a pane inside an inner group inside an outer group, whose boundaries are all distinct. Along the pane, grey (outer) and muted blue (inner) dashes alternate. Beyond the inner group, the line is solid grey. A pane whose only enclosing option is the between-siblings choice gets a plain grey line.

**Coloring**:

* Colors go by **level index** within the line, outermost first. Level 0 is **light grey** (chroma 0). Deeper levels get **low-saturation** hues (chroma 0.06), only so that the dashes of several possible insertions stand apart. A line with a single choice is therefore plain grey.
* Each choice's rect is filled with a `userSpaceOnUse` linear gradient across the band: bright at the border (L 0.86, or 0.97 when active), darker away from it (L 0.58, or 0.72 when active).
* Alpha is 0.75, or 1 when active.
* Give each gradient a unique id.

**The other side** (easier homing): on a straddling side, also draw the border as seen from each pane Q across it, on Q's half of the gap.

* The candidates are the panes inside the sibling on the far side whose facing edge touches that sibling's edge.
* For each Q, build Q's line for the opposite side, without recursing into its own other side, and clip it to Q's extent along the edge.
* Hovering follows the pane under the cursor, so crossing the border swaps which half is "ours". Only the hovered pane's half triggers.
* Choices with the **same drop target** on both halves (in practice the shared `between`) touch in the middle. Every other choice backs off 1px from the middle, leaving a visible gap.
* Shared choices **highlight on both halves at once** when active. Compare choices by their target, not by object identity.

### Tab dots

The tab bar shows dots at every insertion position: before the first tab, between consecutive tabs, and after the last tab. These replace any separate "new tab" zone.

* Each dot is a small grey circle at the boundary between tabs. It grows and brightens when active.
* **Hovering anywhere in the tab bar** selects the nearest insertion position by horizontal distance; there is no need to hit a dot.
  * If the nearest position is a no-op, nothing is selected. Don't fall through to a farther dot: hovering your own tab must not jump to some other gap.
* No-op positions have no dot: the two around the dragged tab, all of them on the dragged pane's own tab bar.
* With the tabs scrolled, positions hidden in the middle are dropped. The **first and last positions are pinned to the visible edges**, so that both ends stay reachable. Hovering the empty header area right of the tabs selects "append", because the pinned last dot is the nearest.
* The border line takes priority over the tab bar when the cursor is on the line, which matters at the bottom border, where the header now is.

### Pane zones: thirds and swap

Besides the border lines (which handle insertions spanning several panes) and the tab bar, the hovered pane offers its own zones, laid out on a 3×3 grid of its *visible* rect:

* **Edge thirds** (x < 1/3, x > 2/3, y < 1/3, y > 2/3) propose a `side` drop on the pane itself, on that side: insert beside it, taking half of it. In corners, pick the side whose boundary is nearer, using normalized distance. Sides where that drop is a no-op propose nothing.
* **Center third:** shows an icon in the middle of the pane, a grey circle of radius 22. The choice is active only while the cursor is over the icon; the rest of the center proposes nothing.
  * Over another pane, it is a **swap icon** (two opposed arrows), for `swap`.
  * Over the dragged thing's own pane, it is a **cloud icon**, for `float`. A cloud drawn as three overlapping circles over a flat base is enough.
* **Priority**, from highest: the border line under the cursor, then the tab bar (nearest gap), then the thirds and center.

### Preview

On top of the indicators, draw the drop area as a faint translucent fill with a dim grey dashed rounded outline. It is **always aligned with the current geometry, never the relaid-out one**; a relayout preview was found confusing.

* `side` on X: the half of X adjacent to that side.
* `between`: straddle the border, covering the last third of the node before it and the first third of the node after it.
* `tab`: no outline. The highlighted dot is the preview; outlining the pane was found distracting.
* `swap`: outline both panes that trade contents, the target and the dragged item's pane.
* `float`: outline where the window will appear, the same rect the menu's Float uses (the pane's rect at 80%, centered). On commit, add the window with that rect.


## Easy pitfalls (summary)

* Keep ids valid during a drop by detaching with a tombstone, inserting, and only then removing the tombstone and normalizing.
* Normalize after every mutation, including on load. Otherwise rows of rows survive, and so do single-child splits.
* Navigate with logical rects from weights, not DOM rects.
* An overlay with `pointer-events: none` needs manual hit-testing, and `elementsFromPoint` to find the pane underneath.
* Keep the hovered pane while over gaps inside the workspace.
* Dedupe chain levels by equal span (1px tolerance), keeping the innermost *valid* node.
* Anchor dash phases to absolute coordinates.
* Compute "1/N" while excluding what is leaving the split.
* Weight swaps on pane swap keep the geometry fixed, which is what makes swap/unswap exact.
* Filter every candidate choice through `applyDrop`, including the shape no-op test, so the UI never offers pointless drops.
