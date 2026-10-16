// Placer from the page: a new cell below the focused one, in a scroll column; forced off an edge.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
console.log(await page.evaluate(() => {
  const ws = window.ws;
  const cells = () => [...document.querySelectorAll(".carreau-scroll > .carreau-pane")].map((e) => e.querySelector(".carreau-tab-short").textContent).join(",");
  const explain = [...document.querySelectorAll(".carreau-scroll > .carreau-pane")][1].dataset.id;
  ws.select({ id: explain });
  const c = ws.placer({ split: "bottom" }).apply({ id: "tnew", title: "pwd", short: "pwd", long: "$ pwd", content: "/home" });
  const out = [`placed below Explain: ${cells()} | focused: ${ws.node(ws.selection.id).tabs[0].title} (${c.id === ws.selection.id})`];
  const right = ws.focused().cellAt("right");
  out.push(`right of it: ${right ? right.node.type : null}`);
  const d = ws.placer({ split: "left", base: "right", force: true }).apply({ id: "tlog", title: "log" });
  const show = (n) => (n.type === "pane" ? n.tabs.map((t) => t.title).join("+") : `${n.type}(${n.children.length})`);
  out.push(`forced right: root ${show(ws.root)} -> ${ws.root.children.map(show).join(", ")}`);
  return out.join("\n");
}));
await browser.close();
