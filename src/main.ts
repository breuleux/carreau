// Demo host. Key bindings live here, not in the library: Carreau takes them as configuration.

import "./style.css";
import { examples } from "./examples";
import { deserialize, serialize } from "./model";
import { hasMoveBefore, View } from "./view";
import { Workspace } from "./workspace";
import { KeyboardNav, NavConfig } from "./keyboard";

// Navigation mode: hold Alt after Alt+Q (or Alt+Q, Q for sticky mode), then use these.
const navConfig: NavConfig = {
  // side: "left" | "right" | "either" (default): which Alt key counts.
  activation: { modifier: "Alt", code: "KeyQ", side: "either" },
  bindings: {
    ArrowLeft: "focusLeft",
    ArrowRight: "focusRight",
    ArrowUp: "focusUp",
    ArrowDown: "focusDown",
    KeyH: "focusLeft",
    KeyL: "focusRight",
    KeyK: "focusUp",
    KeyJ: "focusDown",
    "Shift+ArrowLeft": "expandLeft",
    "Shift+ArrowRight": "expandRight",
    "Shift+ArrowUp": "expandUp",
    "Shift+ArrowDown": "expandDown",
    "Shift+KeyH": "expandLeft",
    "Shift+KeyL": "expandRight",
    "Shift+KeyK": "expandUp",
    "Shift+KeyJ": "expandDown",
    KeyU: "unexpand",
    KeyP: "parent",
    KeyR: "root",
    KeyC: "child",
    BracketRight: "nextTab",
    BracketLeft: "prevTab",
    KeyM: "toggleMaximize",
    KeyF: "float",
    KeyG: "group",
    "Shift+KeyG": "collapse",
    "Shift+Digit5": "renameTab", // % on a US layout
    KeyZ: "undo",
    "Shift+KeyZ": "redo",
    KeyW: "closeTab",
    KeyX: "closeTab",
    "Shift+KeyW": "closePane",
    "Shift+KeyX": "closePane",
  },
  // S, then a direction: swap. (Holding S swaps repeatedly.)
  prefixes: {
    KeyS: {
      ArrowLeft: "swapLeft",
      ArrowRight: "swapRight",
      ArrowUp: "swapUp",
      ArrowDown: "swapDown",
      KeyH: "swapLeft",
      KeyL: "swapRight",
      KeyK: "swapUp",
      KeyJ: "swapDown",
    },
  },
};

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
};
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
      }
      if (typeof data.height === "number") f.style.height = `${data.height}px`;
      f.style.flex = typeof data.height === "number" ? "none" : "1";
      return f;
    }
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
const byAction = new Map<string, string[]>();
for (const [k, a] of Object.entries(navConfig.bindings)) byAction.set(a, [...(byAction.get(a) ?? []), label(k)]);
for (const [a, ks] of byAction) legend.push([ks.join(" "), a]);
for (const [p, table] of Object.entries(navConfig.prefixes ?? {})) {
  const byA = new Map<string, string[]>();
  for (const [k, a] of Object.entries(table)) byA.set(a, [...(byA.get(a) ?? []), label(k)]);
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
