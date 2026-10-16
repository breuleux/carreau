import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const tabBox = (t) => page.locator(".carreau-tab", { hasText: new RegExp(`^${t.replace(".", "\\.")}$`) }).boundingBox();
const paneBox = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${t.replace(".", "\\.")}$`) }) }).boundingBox();
const active = () => page.evaluate(() => { const d = window.view.drag; return d.active ? `${d.active.target.kind}${d.active.target.index ?? ""}` : "none"; });
const tabsOf = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: t }) }).locator(".carreau-tab").allTextContents();
await page.goto("http://localhost:5317/?example=IDE");
// Reorder: drag main.ts to between view.ts and README.md
let a = await tabBox("main.ts"), v = await tabBox("view.ts");
await page.mouse.move(a.x + 10, a.y + 10); await page.mouse.down();
await page.mouse.move(a.x + 40, a.y + 60, { steps: 5 });
await page.mouse.move(v.x + v.width + 1, v.y + v.height / 2, { steps: 6 });
console.log("dot:", await active());
await page.screenshot({ path: "/tmp/dots.png", clip: { x: 160, y: 30, width: 500, height: 120 } });
await page.mouse.up();
console.log("tabs:", (await tabsOf("README.md")).join(","));
// Near but not on the line: main pane left border, 20px in
const p = await paneBox("model.ts");
a = await tabBox("Outline");
await page.mouse.move(a.x + 10, a.y + 10); await page.mouse.down();
await page.mouse.move(a.x - 40, a.y + 60, { steps: 5 });
await page.mouse.move(p.x + 20, p.y + p.height / 2, { steps: 6 });
console.log("near:", await active(), await page.locator(".carreau-overlay rect").count(), "rects drawn");
await page.mouse.move(p.x + 1, p.y + p.height / 2, { steps: 3 });
console.log("on line:", await active());
// tab into another pane at position 0
const f = await tabBox("Files");
await page.mouse.move(f.x + 1, f.y + f.height / 2, { steps: 6 });
console.log("files dot0:", await active());
await page.mouse.up();
console.log("files pane:", (await tabsOf("Files")).join(","));
await browser.close();
