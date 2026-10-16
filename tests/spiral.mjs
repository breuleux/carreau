// Spiral: pane 1's left edge (insert into the row: thirds) vs its left third (halve pane 1).
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Spiral");
await page.waitForTimeout(200);
const tab = (t) => page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: new RegExp(`^${t}$`) }) }).first();
const paneOf = (t) => page.locator(".carreau-pane", { has: tab(t) }).last();
const weights = () => page.evaluate(() => window.ws.root.children.map((c) => (c.type === "pane" ? c.tabs[0].title : c.type) + ":" + c.weight.toFixed(2)).join(" "));
for (const [label, fx] of [["left edge line", 0.004], ["left third", 0.15]]) {
  await page.goto("http://localhost:5317/?example=Spiral");
  await page.waitForTimeout(200);
  const s = await tab("5").boundingBox();
  const r = await paneOf("1").boundingBox();
  await page.mouse.move(s.x + 10, s.y + 5); await page.mouse.down();
  await page.mouse.move(s.x - 50, s.y - 50, { steps: 4 });
  await page.mouse.move(r.x + r.width * fx, r.y + r.height / 2, { steps: 4 });
  const t = await page.evaluate(() => JSON.stringify(window.view.drag.active?.target));
  await page.screenshot({ path: `/tmp/spiral-${label.replace(/ /g, "-")}.png` });
  await page.mouse.up();
  console.log(label.padEnd(16), t, "→", await weights());
}
await browser.close();
