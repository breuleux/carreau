// Alt+Q, I / Shift+I, direction: a new cell, created by the focused cell's class.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const show = () => page.evaluate(() => {
  const f = (n) => (n.type === "pane" ? n.tabs.map((t) => (t.group ? `${t.title}{${f(t.group.children[0])}}` : t.title)).join("+") : `${n.type}(${n.children.map(f).join(", ")})`);
  return f(window.ws.root);
});
const focused = () => page.evaluate(() => { const n = window.ws.node(window.ws.selection.id); return n.tabs[n.active].title; });
const selectTab = (title) => page.evaluate((title) => { const p = [window.ws.root].flatMap(function all(n) { return n.type === "pane" ? [n, ...n.tabs.flatMap((t) => (t.group ? all(t.group.children[0]) : []))] : n.children.flatMap(all); }).find((p) => p.tabs.some((t) => t.title === title)); window.ws.activateTab(p.id, p.tabs.findIndex((t) => t.title === title)); }, title);
const keys = async (...ks) => {
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt"); // held mode needs Alt...
};
const nav = async (seq) => {
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ");
  for (const k of seq) await page.keyboard.press(k);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(100);
};
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
await selectTab("Explain");
await nav(["KeyI", "Shift+ArrowDown"]);
console.log("I Shift+↓ on a prompt cell:     ", await show(), "| focused:", await focused());
await selectTab("ls");
await nav(["KeyI", "Shift+ArrowDown"]);
console.log("I Shift+↓ on a shell cell:      ", await show(), "| focused:", await focused());
await selectTab("git log");
await nav(["KeyI", "ArrowLeft"]);
console.log("I ← (the sidebar):", await show(), "| focused:", await focused());
await selectTab("git log");
await nav(["KeyI", "ArrowRight"]);
console.log("I → (none: forced):", await show(), "| focused:", await focused());
await page.goto("http://localhost:5317/?example=Embeds");
await page.waitForTimeout(300);
await selectTab("Counter A");
await nav(["KeyI", "Shift+KeyL"]);
console.log("Embeds, I Shift+l on Counter A: ", await show(), "| focused:", await focused());
// A: move the focused tab
await page.goto("http://localhost:5317/?example=IDE");
await page.waitForTimeout(300);
await selectTab("model.ts");
await nav(["KeyA", "Shift+ArrowDown"]);
console.log("IDE, A Shift+↓ on model.ts:     ", await show(), "| focused:", await focused());
await nav(["KeyA", "ArrowLeft"]);
console.log("then A ← (Files):", await show(), "| focused:", await focused());
await nav(["KeyA", "ArrowLeft"]);
console.log("then A ← (forced):", await show(), "| focused:", await focused());
await selectTab("Outline");
await nav(["KeyA", "Shift+ArrowDown"]);
console.log("A Shift+↓ on a lone tab: no-op: ", await show(), "| focused:", await focused());
await page.screenshot({ path: "/tmp/insert.png" });
await browser.close();
