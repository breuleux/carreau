// The line is the same from either side of a gap: crossing it keeps the wait, and the minis.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const state = () => page.evaluate(() => { const d = window.view.drag; return `hover ${d.hoverPane?.slice(0, 4)} | line ${d.near?.key ?? "-"} | active ${d.active?.target.kind ?? "none"} | minis ${document.querySelectorAll(".carreau-mini").length}`; });
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Grid 3×3"));
await page.waitForTimeout(200);
const c1 = await page.locator(".carreau-tab", { hasText: /^C1$/ }).boundingBox();
const b2 = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^B2$/ }) }).boundingBox();
await page.mouse.move(c1.x + 5, c1.y + 5); await page.mouse.down();
await page.mouse.move(c1.x + 60, c1.y + 60, { steps: 4 });
const y = b2.y + b2.height / 2;
// Wobble across the gap for a while: the minis still come.
for (const dx of [3, -5, 2, -3, 4, -6, 1]) { await page.mouse.move(b2.x + dx, y); await page.waitForTimeout(50); }
console.log("wobbled across the gap for 350ms:", await state());
await page.waitForTimeout(100);
console.log("100ms later:", await state());
await page.mouse.move(b2.x - 6, y);
console.log("now on A's side:", await state());
await page.keyboard.press("Escape"); await page.mouse.up();
await browser.close();
