// Demo host. The keymap lives here, not in the library: Carreau only exposes commands.

import "./style.css";
import { examples } from "./examples";
import { deserialize, serialize } from "./model";
import { View } from "./view";
import { Command, Workspace } from "./workspace";

const keymap: Record<string, Command> = {
  "Alt+ArrowLeft": "focusLeft",
  "Alt+ArrowRight": "focusRight",
  "Alt+ArrowUp": "focusUp",
  "Alt+ArrowDown": "focusDown",
  "Alt+Shift+ArrowLeft": "expandLeft",
  "Alt+Shift+ArrowRight": "expandRight",
  "Alt+Shift+ArrowUp": "expandUp",
  "Alt+Shift+ArrowDown": "expandDown",
  "Alt+KeyU": "unexpand",
  "Alt+KeyH": "swapLeft",
  "Alt+KeyL": "swapRight",
  "Alt+KeyK": "swapUp",
  "Alt+KeyJ": "swapDown",
  "Alt+BracketRight": "nextTab",
  "Alt+BracketLeft": "prevTab",
  "Alt+KeyP": "parent",
  "Alt+KeyC": "child",
  "Alt+KeyM": "maximize",
  "Alt+KeyB": "restore",
};

function chord(e: KeyboardEvent): string {
  return [e.ctrlKey && "Ctrl", e.metaKey && "Meta", e.altKey && "Alt", e.shiftKey && "Shift", e.code]
    .filter(Boolean)
    .join("+");
}

const params = new URLSearchParams(location.search);
const exIndex = Math.max(0, examples.findIndex((e) => e.name === params.get("example")));
const example = examples[exIndex];

const select = document.querySelector<HTMLSelectElement>("#example")!;
for (const ex of examples) select.append(new Option(ex.name, ex.name, false, ex === example));
select.addEventListener("change", () => {
  location.search = `?example=${encodeURIComponent(select.value)}`;
});
document.querySelector("#description")!.textContent = example.description;

const ws = new Workspace(example.build());
const view = new View(ws, document.querySelector("#host")!, {
  renderTab: (tab, p) => {
    const d = document.createElement("div");
    d.className = "demo-content";
    d.innerHTML = `<h2></h2><p class="meta"></p>`;
    d.querySelector("h2")!.textContent = tab.title;
    d.querySelector(".meta")!.textContent = `pane ${p.id} · weight ${p.weight.toFixed(2)}`;
    if (tab.content) {
      const text = document.createElement("p");
      text.className = "text";
      text.textContent = tab.content;
      d.append(text);
    }
    return d;
  },
});

window.addEventListener("keydown", (e) => {
  const cmd = keymap[chord(e)];
  if (cmd) {
    e.preventDefault();
    ws.run(cmd);
  }
});

// Help & serialization panel
const help = document.querySelector("#keys")!;
for (const [k, c] of Object.entries(keymap)) {
  const li = document.createElement("li");
  li.innerHTML = `<kbd></kbd> <span></span>`;
  li.querySelector("kbd")!.textContent = k.replace(/Key|Arrow/g, "");
  li.querySelector("span")!.textContent = c;
  help.append(li);
}
const json = document.querySelector<HTMLTextAreaElement>("#json")!;
const status = document.querySelector("#status")!;
const refresh = () => {
  if (document.activeElement !== json) json.value = serialize(ws.root);
  const s = ws.selection;
  status.textContent =
    `selection: ${ws.node(s.id)?.type} ${s.id}${s.range ? ` [${s.range.join("–")}]` : ""}` +
    (ws.maximized ? ` · maximized: ${ws.maximized.id}${ws.maximized.range ? ` [${ws.maximized.range.join("–")}]` : ""}` : "");
};
ws.onChange(refresh);
refresh();
document.querySelector("#load")!.addEventListener("click", () => {
  try {
    ws.setRoot(deserialize(json.value));
  } catch (err) {
    alert(String(err));
  }
});

Object.assign(window, { ws, view });
