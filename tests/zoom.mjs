import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
await page.goto("http://localhost:5317/?example=Deep%20nesting");
const tabE = page.locator(".carreau-tab", { hasText: /^E$/ });
const paneA = page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^A$/ }) });
const eb = await tabE.boundingBox(), ab = await paneA.boundingBox();
await page.mouse.move(eb.x + 5, eb.y + 5); await page.mouse.down();
await page.mouse.move(eb.x + 40, eb.y + 40, { steps: 5 });
for (const [name, dx] of [["a", 10], ["b", 30], ["c", 50], ["d", 70]]) {
  await page.mouse.move(ab.x + dx, ab.y + ab.height / 2, { steps: 4 });
  await page.screenshot({ path: `/tmp/zoom-${name}.png`, clip: { x: 0, y: 30, width: 400, height: 520 } });
}
const n = await page.locator(".carreau-overlay polygon").count();
console.log("polygons", n);
await browser.close();
