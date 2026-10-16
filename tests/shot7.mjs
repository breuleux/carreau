import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 3 });
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Grid 3×3"));
const t = await page.locator(".carreau-tab", { hasText: /^C1$/ }).boundingBox();
const r = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^B2$/ }) }).boundingBox();
await page.mouse.move(t.x + 5, t.y + 5); await page.mouse.down();
await page.mouse.move(t.x + 60, t.y + 60, { steps: 5 });
// find a y where the active choice is the shared "between"
for (let dy = 0; dy < 60; dy += 3) {
  await page.mouse.move(r.x + 3, r.y + r.height / 2 + dy, { steps: 1 });
  const k = await page.evaluate(() => window.view.drag.active?.target.kind);
  if (k === "between") { console.log("between at dy", dy); break; }
}
await page.screenshot({ path: "/tmp/halves.png", clip: { x: r.x - 25, y: r.y + r.height / 2 - 60, width: 50, height: 140 } });
await browser.close();
