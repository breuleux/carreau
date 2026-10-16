import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const tabBox = (t) => page.locator(".carreau-tab", { hasText: new RegExp(`^${t.replace(".", "\\.")}$`) }).boundingBox();
const paneBox = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${t.replace(".", "\\.")}$`) }) }).boundingBox();
const state = () => page.evaluate(() => { const d = window.view.drag; return `near=${d.near ? d.near.side : "-"} active=${d.active ? d.active.target.kind + (d.active.target.index ?? "") : "none"} previews=${document.querySelectorAll(".carreau-preview").length}`; });
const tabsOf = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: t }) }).locator(".carreau-tab").allTextContents();
await page.goto("http://localhost:5317/?example=IDE");
const a = await tabBox("main.ts");
await page.mouse.move(a.x + 10, a.y + 10); await page.mouse.down();
await page.mouse.move(a.x + 40, a.y + 80, { steps: 5 });
const p = await paneBox("main.ts");
for (const [label, x, y] of [["20px from left border", p.x + 20, p.y + p.height / 2], ["on left line", p.x + 3, p.y + p.height / 2]]) {
  await page.mouse.move(x, y, { steps: 3 }); console.log(label, await state());
}
const r = await tabBox("README.md"), v = await tabBox("view.ts"), m = await tabBox("model.ts");
for (const [label, b, f] of [["over own tab", a, 0.5], ["model.ts left part", m, 0.3], ["view.ts right part", v, 0.8], ["README right part", r, 0.9], ["past last tab", r, 1.8]]) {
  await page.mouse.move(b.x + b.width * f, b.y + b.height / 2 + 4, { steps: 3 }); console.log(label, await state());
}
await page.screenshot({ path: "/tmp/tabbar.png", clip: { x: 160, y: 30, width: 520, height: 80 } });
await page.mouse.up();
console.log((await tabsOf("README.md")).join(","));
await browser.close();
