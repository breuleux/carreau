import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
const box = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${t}$`) }) }).boundingBox();
const st = () => page.evaluate(() => { const d = window.view.drag; return `hover=${d.hoverPane} near=${d.near?.side ?? "-"} active=${d.active?.target.kind ?? "none"}`; });
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Grid 3×3"));
const t = await page.locator(".carreau-tab", { hasText: /^C1$/ }).boundingBox();
await page.mouse.move(t.x + 5, t.y + 5); await page.mouse.down();
await page.mouse.move(t.x + 60, t.y + 60, { steps: 5 });
const A = await box("A2"), B = await box("B2");
console.log("gap from", A.x + A.width, "to", B.x);
for (const x of [B.x + 6, B.x + 1, B.x - 0.5, (A.x + A.width + B.x) / 2, A.x + A.width + 0.5, A.x + A.width - 1, A.x + A.width - 6, A.x + A.width + 0.5, B.x - 0.5, B.x + 3]) {
  await page.mouse.move(x, B.y + B.height / 2);
  console.log(x.toFixed(1), await st());
}
await browser.close();
