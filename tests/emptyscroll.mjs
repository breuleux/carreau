// Dragging a tab into a scroll split's empty space: an empty prompt column, and the space
// above a sticky column's cells.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Single pane"));
await page.waitForTimeout(200);
// A pane with two tabs, beside an empty prompt column.
await page.evaluate(() => {
  const tab = (t) => ({ id: "t" + t, title: t, content: t });
  window.ws.load({ floating: [], root: { type: "row", id: "r", weight: 1, children: [
    { type: "pane", id: "pa", weight: 1, active: 0, tabs: [tab("A"), tab("B")] },
    { type: "prompt-column", id: "pc", weight: 1, children: [{ type: "prompt", id: "q", weight: 1 }] },
  ] } });
});
await page.waitForTimeout(200);
const cells = () => page.evaluate(() => [...document.querySelectorAll(".carreau-frame-inner > .carreau-pane")].map((p) => p.querySelector(".carreau-content")?.textContent ?? "?").join(","));
console.log("empty column cells:", JSON.stringify(await cells()));
const b = await page.locator(".carreau-tab", { hasText: /^B$/ }).boundingBox();
const sc = await page.locator(".carreau-frame-inner").boundingBox();
await page.mouse.move(b.x + 10, b.y + 10); await page.mouse.down();
await page.mouse.move(b.x + 60, b.y - 60, { steps: 4 });
await page.mouse.move(sc.x + sc.width / 2, sc.y + sc.height / 2, { steps: 8 });
console.log("over the empty space:", await page.evaluate(() => { const d = window.view.drag; return `hover=${d.hoverPane} active=${d.active?.target.kind}:${d.active?.target.index} preview=${document.querySelectorAll(".carreau-preview").length}`; }));
await page.screenshot({ path: "/tmp/emptyscroll.png" });
await page.mouse.up();
await page.waitForTimeout(100);
console.log("dropped: column cells", JSON.stringify(await cells()), "| tabs left:", await page.locator(".carreau-tab").allTextContents());
// The space above a sticky column's cells (the Sticky example's first column).
await page.goto("http://localhost:5317/?example=Sticky");
await page.waitForTimeout(300);
const sticky = page.locator(".carreau-scroll-column.carreau-reverse").first();
const before = await sticky.evaluate((s) => s.querySelectorAll(":scope > .carreau-pane").length);
const box = await sticky.boundingBox();
const first = await sticky.locator(":scope > .carreau-pane").first().boundingBox();
const t = await page.locator(".carreau-tabbar:not([hidden]) .carreau-tab").last().boundingBox();
await page.mouse.move(t.x + 10, t.y + 10); await page.mouse.down();
await page.mouse.move(t.x + 60, t.y - 60, { steps: 4 });
await page.mouse.move(box.x + box.width / 2, box.y + (first.y - box.y) / 2, { steps: 8 });
console.log("above the sticky column's cells:", await page.evaluate(() => { const d = window.view.drag; return `active=${d.active?.target.kind}:${d.active?.target.index}`; }));
await page.mouse.up();
await page.waitForTimeout(100);
console.log("dropped: cells", before, "→", await sticky.evaluate((s) => s.querySelectorAll(":scope > .carreau-pane").length));
await browser.close();
