// Demo host. Key bindings live here, not in the library: Carreau takes them as configuration.

import "../src/style.css";
import "../src/prompt.css";
import "./demo.css";
import { examples } from "./examples";
import { commitCellFocus, promptCell, spawnCell } from "./cellclasses";
import { plotElement } from "./plots";
import { headedEditor } from "./prompteditor";
import { deserialize, genId, serialize } from "../src/model";
import { hasMoveBefore, View } from "../src/view";
import { Workspace } from "../src/workspace";
import { bridgeFrameKeys, KeyboardNav, NavBinding, NavConfig, NavContext } from "../src/keyboard";
// Prompt columns (an optional module): their rendering, and their configuration below.
import "../src/prompt-view";
import { configurePrompts } from "../src/prompt";

/**
 * A command of the host's own (bound like the built-in actions, below): duplicate the focused
 * tab into its pane. It acts on the operand, as cell operations do (from a prompt: the cell above).
 */
function duplicateTab({ ws }: NavContext): void {
  ws.withOperand(() => {
    const n = ws.node(ws.selection.id);
    const tab = n?.type === "pane" && !ws.selection.range ? n.tabs[n.active] : undefined;
    if (!tab || tab.group) return null; // (content tabs only: a group's layout has ids of its own)
    const { link: _link, ...copy } = structuredClone(tab);
    return ws.placer({ split: "tab" }).apply({ ...copy, id: genId("t"), title: `${tab.title} (copy)`, short: undefined });
  }, null);
}

// Navigation mode: hold Alt after Alt+Q (or Alt+Q, Q for sticky mode), then use these.
const navConfig: NavConfig = {
  // side: "left" | "right" | "either" (default): which Alt key counts.
  activation: { modifier: "Alt", code: "KeyQ", side: "either" },
  bindings: {
    KeyD: duplicateTab, // the host's own command (any function)
    ArrowLeft: "focusLeft",
    ArrowRight: "focusRight",
    ArrowUp: "focusUp",
    ArrowDown: "focusDown",
    // KeyH: "focusLeft",
    // KeyL: "focusRight",
    // KeyK: "focusUp",
    // KeyJ: "focusDown",
    "Shift+ArrowLeft": "expandLeft",
    "Shift+ArrowRight": "expandRight",
    "Shift+ArrowUp": "expandUp",
    "Shift+ArrowDown": "expandDown",
    // "Shift+KeyH": "expandLeft",
    // "Shift+KeyL": "expandRight",
    // "Shift+KeyK": "expandUp",
    // "Shift+KeyJ": "expandDown",
    KeyU: "unexpand",
    KeyL: "clear", // the finished cells (done, standby, error) in the selection
    KeyN: "namePane",
    KeyX: "mark", // marks (numbered): then V moves them all to the focus
    KeyV: "moveMarked",
    Comma: "prevTab",
    Period: "nextTab",
    Slash: "root",
    "Shift+Comma": "parent",
    "Shift+Period": "child",
    // Resize the focus: [ ] narrower / wider; with Shift ({ }), shorter / taller. (Tabs: the
    // Ctrl+Tab and Cmd+←/→ shortcuts, below.)
    BracketRight: "growHeight",
    "Shift+BracketRight": "growWidth",
    BracketLeft: "shrinkHeight",
    "Shift+BracketLeft": "shrinkWidth",
    KeyM: "toggleMaximize",
    KeyF: "float",
    KeyG: "group",
    "Shift+KeyG": "collapse",
    "Shift+Digit5": "renameTab", // % on a US layout
    KeyZ: "undo",
    "Shift+KeyZ": "redo",
    KeyW: "closeTab",
    "Shift+KeyW": "closePane",
    "Shift+KeyX": "closePane",
  },
  // S, then a direction: swap. (Holding S swaps repeatedly.)
  // Without navigation mode: redundant ways to switch tabs. (Chrome keeps Ctrl+Tab for its own
  // tabs; other browsers, or an app shell, pass it on.)
  shortcuts: {
    "Ctrl+Tab": "nextTab",
    "Ctrl+Shift+Tab": "prevTab",
    "Cmd+ArrowRight": "nextTab",
    "Cmd+ArrowLeft": "prevTab",
  },
  prefixes: {
    KeyS: {
      ArrowLeft: "swapLeft",
      ArrowRight: "swapRight",
      ArrowUp: "swapUp",
      ArrowDown: "swapDown",
      // KeyH: "swapLeft",
      // KeyL: "swapRight",
      // KeyK: "swapUp",
      // KeyJ: "swapDown",
    },
    // I, then a direction: a new cell (the focused cell decides what) into the tabs of the cell
    // in that direction; with Shift, beside the focused cell, on that side.
    KeyI: {
      Enter: "insertInto",
      ArrowLeft: "insertIntoLeft",
      ArrowRight: "insertIntoRight",
      ArrowUp: "insertIntoUp",
      ArrowDown: "insertIntoDown",
      // KeyH: "insertIntoLeft",
      // KeyL: "insertIntoRight",
      // KeyK: "insertIntoUp",
      // KeyJ: "insertIntoDown",
      "Shift+ArrowLeft": "insertLeft",
      "Shift+ArrowRight": "insertRight",
      "Shift+ArrowUp": "insertUp",
      "Shift+ArrowDown": "insertDown",
      // "Shift+KeyH": "insertLeft",
      // "Shift+KeyL": "insertRight",
      // "Shift+KeyK": "insertUp",
      // "Shift+KeyJ": "insertDown",
    },
    // A, then a direction: move the focused tab the same way.
    KeyA: {
      ArrowLeft: "moveIntoLeft",
      ArrowRight: "moveIntoRight",
      ArrowUp: "moveIntoUp",
      ArrowDown: "moveIntoDown",
      // KeyH: "moveIntoLeft",
      // KeyL: "moveIntoRight",
      // KeyK: "moveIntoUp",
      // KeyJ: "moveIntoDown",
      "Shift+ArrowLeft": "moveLeft",
      "Shift+ArrowRight": "moveRight",
      "Shift+ArrowUp": "moveUp",
      "Shift+ArrowDown": "moveDown",
      // "Shift+KeyH": "moveLeft",
      // "Shift+KeyL": "moveRight",
      // "Shift+KeyK": "moveUp",
      // "Shift+KeyJ": "moveDown",
    },
  },
};

// Theme: follow the system (color-scheme: light dark), or force light or dark. Remembered.
const theme = document.querySelector<HTMLSelectElement>("#theme")!;
const applyTheme = (v: string) => {
  document.documentElement.style.colorScheme = v;
  theme.value = v;
  localStorage.setItem("carreau-theme", v);
};
applyTheme(localStorage.getItem("carreau-theme") ?? "light dark");
theme.addEventListener("change", () => applyTheme(theme.value));

const params = new URLSearchParams(location.search);
const exIndex = Math.max(0, examples.findIndex((e) => e.name === params.get("example")));
const example = examples[exIndex];

const select = document.querySelector<HTMLSelectElement>("#example")!;
for (const ex of examples) select.append(new Option(ex.name, ex.name, false, ex === example));
select.addEventListener("change", () => {
  location.search = `?example=${encodeURIComponent(select.value)}`;
});
document.querySelector("#description")!.textContent =
  example.description + (hasMoveBefore ? "" : " ⚠ This browser has no Element.moveBefore: iframes will reload when moved.");

const ws = new Workspace(example.build());
// Demo lifecycle: shell cells take a moment to end their process; unresponsive tabs never
// finish closing (hover the spinner and click its red × to force them); others close at once.
ws.lifecycle = {
  closeTab: (t) =>
    t.status === "unresponsive" ? new Promise(() => {}) : new Promise((done) => setTimeout(done, t.long?.startsWith("$") ? 1200 : 0)),
  forceCloseTab: async (t) => console.log(`force closed ${t.title}`),
  // What a new cell inserted from a cell is (Alt+Q, I, then a direction): see cellclasses.ts.
  spawn: spawnCell,
  // Leaving navigation mode on a cell: it takes the keyboard focus, as its class sees fit.
  commitFocus: commitCellFocus,
};
// What's typed in a prompt (Enter) becomes a cell above it.
configurePrompts(ws, { submit: promptCell, placeholder: "Type a prompt, or $ a command — Enter" });
// The "Custom prompt" example: the host's own prompt editor.
if (example.name === "Custom prompt") configurePrompts(ws, { editor: headedEditor });
const view = new View(ws, document.querySelector("#host")!, {
  renderTab: (tab) => {
    const data = tab.data ?? {};
    if (typeof data.youtube === "string" || typeof data.srcdoc === "string") {
      const f = document.createElement("iframe");
      if (typeof data.youtube === "string") {
        f.src = `https://www.youtube.com/embed/${data.youtube}`;
        f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
        f.allowFullscreen = true;
        // YouTube refuses to play embeds without a referrer (error 153).
        f.referrerPolicy = "strict-origin-when-cross-origin";
      } else {
        f.srcdoc = data.srcdoc as string;
        // Same origin: Alt+Q (and the navigation keys) work from inside it.
        bridgeFrameKeys(f);
      }
      if (typeof data.height === "number") f.style.height = `${data.height}px`;
      f.style.flex = typeof data.height === "number" ? "none" : "1";
      return f;
    }
    if (typeof data.plot === "string") return plotElement(); // drawn by the "plot" complex type
    const d = document.createElement("div");
    d.className = "demo-content";
    d.innerHTML = `<h2></h2><p class="meta"></p>`;
    d.querySelector("h2")!.textContent = tab.title;
    // Contents are created once and kept for the session, so show only stable facts.
    d.querySelector(".meta")!.textContent = `tab ${tab.id}`;
    if (tab.content) {
      const text = document.createElement("p");
      text.className = "text";
      text.textContent = tab.content;
      d.append(text);
    }
    return d;
  },
});

const nav = new KeyboardNav(ws, view, navConfig);

// Help & serialization panel
const help = document.querySelector("#keys")!;
const label = (k: string) =>
  k
    .replace("BracketRight", "]")
    .replace("BracketLeft", "[")
    .replace("Shift+Digit5", "%")
    .replace(/Key|Arrow/g, "")
    .replace("Right", "→")
    .replace("Left", "←")
    .replace("Up", "↑")
    .replace("Down", "↓");
const legend: [string, string][] = [
  ["Alt+Q", "navigation mode (hold Alt)"],
  ["Alt+Q Q", "sticky navigation mode (Q / Esc to leave)"],
];
// Group bindings by action, for a compact legend.
// (A command of the host's own is named by its function.)
const actionName = (a: NavBinding) => (typeof a === "function" ? a.name : a);
const byAction = new Map<string, string[]>();
for (const [k, a] of Object.entries(navConfig.bindings)) byAction.set(actionName(a), [...(byAction.get(actionName(a)) ?? []), label(k)]);
for (const [a, ks] of byAction) legend.push([ks.join(" "), a]);
for (const [k, sc] of Object.entries(navConfig.shortcuts ?? {}))
  legend.push([`${label(k)} (anytime)`, actionName(typeof sc === "object" ? sc.run : sc)]);
for (const [p, table] of Object.entries(navConfig.prefixes ?? {})) {
  const byA = new Map<string, string[]>();
  for (const [k, a] of Object.entries(table)) byA.set(actionName(a), [...(byA.get(actionName(a)) ?? []), label(k)]);
  for (const [a, ks] of byA) legend.push([`${label(p)}, ${ks.join(" ")}`, a]);
}
for (const [k, a] of legend) {
  const li = document.createElement("li");
  li.innerHTML = `<kbd></kbd> <span></span>`;
  li.querySelector("kbd")!.textContent = k;
  li.querySelector("span")!.textContent = a;
  help.append(li);
}
const json = document.querySelector<HTMLTextAreaElement>("#json")!;
const status = document.querySelector("#status")!;
const refresh = () => {
  if (document.activeElement !== json) json.value = serialize(ws.floating.length ? ws.data() : ws.root);
  const s = ws.selection;
  status.textContent =
    (nav.mode !== "off" ? `[NAV${nav.mode === "sticky" ? " · sticky" : ""}${nav.prefix ? ` · ${label(nav.prefix)}…` : ""}] ` : "") +
    `selection: ${ws.node(s.id)?.type} ${s.id}${s.range ? ` [${s.range.join("–")}]` : ""}` +
    (ws.maximized ? ` · maximized: ${ws.maximized.id}${ws.maximized.range ? ` [${ws.maximized.range.join("–")}]` : ""}` : "");
};
ws.onChange(refresh);
nav.onChange(refresh);
refresh();
document.querySelector("#load")!.addEventListener("click", () => {
  try {
    ws.load(deserialize(json.value));
  } catch (err) {
    alert(String(err));
  }
});

Object.assign(window, { ws, view, nav });
