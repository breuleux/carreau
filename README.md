# Carreau

A draggable, keyboard-navigable **tiling workspace** for the web: panes, tabs, groups,
splitters, floating windows and prompt columns, with drag-and-drop and a navigation mode —
plain DOM, no framework, no runtime dependencies.

Your app owns the cell contents (any `HTMLElement`) and the key bindings; Carreau owns the
layout, the geometry and the interactions.

```
┌───────────────┬───────────────┐
│  pane (tabs)  │  pane         │
│               ├──────┬────────┤
│               │ pane │ prompt │
└───────────────┴──────┴────────┘
```

## Install

Carreau is versioned by **git tags** and used as a git dependency (no registry):

```sh
bun add "carreau@github:breuleux/carreau#v0.1.0"    # or npm i github:breuleux/carreau#v0.1.0
```

A tag carries **sources only**: your bundler compiles them through the package's
`"source"` export condition (bun: `Bun.build({ conditions: ["source"] })`; vite:
`resolve.conditions`). Nothing is built at install time, and nothing generated is in
git. Without a source-aware bundler, run `npm run build` for `dist/` + `types/` (the
`import` condition). Upgrade by changing the tag in your `package.json`; your lockfile
pins the exact commit.

## Usage

```ts
import { Workspace, View, KeyboardNav, serialize, deserialize } from "carreau";
import "carreau/style.css";

// The layout is plain data (panes, splits, tabs): build it, or load it with deserialize().
const ws = new Workspace({ type: "pane", id: "root", weight: 1, active: 0, tabs: [{ id: "t1", title: "First" }] });

// Your cell contents: return an element for each tab.
const view = new View(ws, document.querySelector("#host")!, {
  renderTab: (tab) => {
    const el = document.createElement("div");
    el.textContent = tab.content ?? tab.title;
    return el;
  },
});

// Key bindings are yours to choose:
const nav = new KeyboardNav(ws, view, {
  activation: { modifier: "Alt", code: "KeyQ" }, // navigation mode: Alt+Q
  bindings: {
    ArrowLeft: "focusLeft",
    ArrowRight: "focusRight",
    "Shift+ArrowLeft": "expandLeft",
    "Shift+ArrowRight": "expandRight",
    KeyW: "closeTab",
  },
});
```

Persist the layout any time with `serialize(ws)` (JSON-plain), restore it with
`deserialize(data)`.

### Prompts (optional)

Carreau has prompt columns (a fixed input column below the cells). Rendering is a separate,
optional module:

```ts
import { configurePrompts, genId } from "carreau";
import "carreau/prompt.css";
import "carreau/prompt-view"; // registers the "prompt" renderer (or bring your own)

// What submitted text becomes (default: a plain text tab):
configurePrompts(ws, { submit: (text) => ({ id: genId("t"), title: text, content: text }) });
```

### Extension points

- `registerRenderer(kind, …)` — render node kinds your way (tabs, prompts, …).
- `registerKind(...)` — your own node kinds with their own lifecycle (`Lifecycle`).
- `registerOperand(...)` — operands for host commands (e.g. prompt-driven cell operations).
- `ws.lifecycle` — what happens when tabs close, when a cell spawns from another cell, etc.
- `ws.placer(...)` / `Cell` / `Placer` — place things relative to the focused cell.
- `bridgeFrameKeys(iframe)` — let keyboard navigation work across same-origin iframes.

> Without `Element.moveBefore` (older browsers), everything still works — iframes simply
> reload when dragged between panes.

## Development

```sh
npm install
npm run dev      # the demo app (examples, drag-and-drop, navigation mode)
npm run build    # dist/ + types/ (ESM bundle, declarations, styles)
npm test         # Playwright-driven checks against the demo
```

### Releasing a version

```sh
node scripts/release.mjs 0.1.1   # bumps package.json, builds, runs the tests, commits, tags v0.1.1
git push --follow-tags
```

Consumers then move to `github:breuleux/carreau#v0.1.1` when they choose to.

### Using it from a sibling checkout (co-development)

While carreau and its host app evolve together, point the host at this checkout:

```sh
ln -sfn ../../carreau node_modules/carreau   # (target is relative to node_modules/)
```

Since the host compiles carreau's sources, that is all: every save goes straight into
the host's next bundle (buche's `bun run view` re-bundles on carreau source changes;
`bun run electron --watch` refreshes `dist/electron` for the **next** window and leaves
running ones alone). The host imports exactly what it will import from a tag — same
entry points, same sources.

## License

MIT
