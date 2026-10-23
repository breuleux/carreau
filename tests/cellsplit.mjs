// Inside a scroll-column's cell, nothing splits along the column: "du" (in the du | ssh row,
// a cell of Notebook's scroll column) offers no top/bottom thirds; left/right stay; its top
// border still offers inserting above the row (in the scroll column).
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
const du = await page.locator(".carreau-scrollcell", { has: page.locator(".carreau-long", { hasText: "du -sh" }) }).boundingBox();
const t = await page.locator(".carreau-tabbar:not([hidden]) .carreau-tab", { hasText: "Sessions" }).boundingBox();
await page.mouse.move(t.x + 10, t.y + 10); await page.mouse.down();
await page.mouse.move(t.x + 60, t.y - 60, { steps: 4 });
await page.mouse.move(du.x + du.width / 2, du.y + du.height / 2, { steps: 6 });
console.log("du's thirds:", await page.evaluate(() => Object.keys(window.view.drag.zones?.sides ?? {}).filter((k) => window.view.drag.zones.sides[k]).join(", ")));
console.log("du's border lines:", await page.evaluate(() => window.view.drag.lines.map((l) => `${l.side}: ${l.levels.map((c) => c.target.kind + (c.target.side ? "-" + c.target.side : "")).join(" ")}`).join(" | ")));
await page.mouse.up();
// The first cell's top border, the last one's bottom: inserting at the scroll column's start/end.
for (const [name, side] of [["ls -la", "top"], ["Draft release", "bottom"]]) {
  await page.goto("http://localhost:5317/?example=Notebook");
  await page.waitForTimeout(300);
  if (side === "bottom") await page.locator(".carreau-frame-inner").first().evaluate((s) => (s.scrollTop = s.scrollHeight));
  await page.waitForTimeout(100);
  const c = await page.locator(".carreau-scrollcell", { has: page.locator(".carreau-long", { hasText: name }) }).boundingBox();
  const s = await page.locator(".carreau-tabbar:not([hidden]) .carreau-tab", { hasText: "Sessions" }).boundingBox();
  await page.mouse.move(s.x + 10, s.y + 10); await page.mouse.down();
  await page.mouse.move(s.x + 60, s.y - 60, { steps: 4 });
  await page.mouse.move(c.x + c.width / 2, side === "top" ? c.y + 2 : c.y + c.height - 2, { steps: 6 });
  console.log(`${name}'s ${side} border:`, await page.evaluate(() => { const d = window.view.drag; return d.near ? d.near.levels.map((x) => `${x.target.kind}:${x.target.index ?? x.target.side}`).join(" ") + " | active " + (d.active?.target.kind ?? "none") : "no line"; }));
  await page.mouse.up();
}
await browser.close();
