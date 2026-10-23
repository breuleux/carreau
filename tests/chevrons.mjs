// On a line, chevrons on the corners of the node the dragged thing would be a child of.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const state = () => page.evaluate(() => { const d = window.view.drag; const c = document.querySelector(".carreau-chevrons"); return `active ${d.active?.target.kind ?? "none"}${d.active?.target.side ? ":" + d.active.target.side : ""} | chevrons ${c ? "yes" : "no"}`; });
// Notebook: between two cells of the scroll column: the column.
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
const s = await page.locator(".carreau-tab", { hasText: "Sessions" }).boundingBox();
const ex = await page.locator(".carreau-scrollcell", { has: page.locator(".carreau-long", { hasText: "Explain" }) }).boundingBox();
await page.mouse.move(s.x + 10, s.y + 10); await page.mouse.down();
await page.mouse.move(s.x + 60, s.y - 60, { steps: 4 });
await page.mouse.move(ex.x + ex.width / 2, ex.y + ex.height - 2, { steps: 8 });
console.log("between Explain and make test:", await state());
await page.screenshot({ path: "/tmp/chevrons-notebook.png" });
await page.keyboard.press("Escape"); await page.mouse.up();
// The grid: B2's left border (between columns A and B of the row; or B2's own column's side).
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Grid 3×3"));
await page.waitForTimeout(200);
const c1 = await page.locator(".carreau-tab", { hasText: /^C1$/ }).boundingBox();
const b2 = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^B2$/ }) }).boundingBox();
await page.mouse.move(c1.x + 5, c1.y + 5); await page.mouse.down();
await page.mouse.move(c1.x + 60, c1.y + 60, { steps: 4 });
for (const dy of [0.3, 0.5]) {
  await page.mouse.move(b2.x + 2, b2.y + b2.height * dy, { steps: 4 });
  console.log(`B2's left border at ${dy}:`, await state());
  await page.screenshot({ path: `/tmp/chevrons-grid-${dy}.png` });
}
await page.keyboard.press("Escape"); await page.mouse.up();
await browser.close();
