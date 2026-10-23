// A border between two siblings: the insertion between them shows on both halves (it's the
// same from either side); the other insertions, only on the hovered pane's half.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const paneBox = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${t}$`) }) }).boundingBox();
const state = () => page.evaluate(() => { const d = window.view.drag; return `active=${d.active?.target.kind ?? "none"} | rects=${document.querySelectorAll(".carreau-overlay rect.carreau-indicator").length} (lit: ${document.querySelectorAll(".carreau-overlay rect.carreau-indicator.active").length})`; });
async function at(example, tab, target, dx, dy, shot) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(example));
  await page.waitForTimeout(200);
  const t = await page.locator(".carreau-tab", { hasText: new RegExp(`^${tab}$`) }).boundingBox();
  await page.mouse.move(t.x + 5, t.y + 5); await page.mouse.down();
  await page.mouse.move(t.x + 60, t.y + 60, { steps: 5 });
  const r = await paneBox(target);
  await page.mouse.move(r.x + dx, r.y + r.height * dy, { steps: 6 });
  console.log(`${example}, ${tab} over ${target}'s left border:`, await state());
  await page.screenshot({ path: shot, clip: { x: r.x - 60, y: r.y - 20, width: 120, height: r.height + 40 } });
  await page.mouse.up();
}
// The grid: B2's left border is between columns A and B (a row of columns): the line shows
// the between insertion (both halves) plus B2's own outer levels (its half only).
await at("Grid 3×3", "C1", "B2", 2, 0.5, "/tmp/halves-grid.png");
await at("Spiral", "1", "2", 2, 0.5, "/tmp/halves-spiral.png");
await browser.close();
