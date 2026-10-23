// A resized cell (by its bar) keeps its long strip's tint behind the bar's circle, and its
// content scrolls.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 3 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
const cell = page.locator(".carreau-scrollcell", { has: page.locator(".carreau-long", { hasText: "make test" }) });
const g = await cell.locator(".carreau-gutter").boundingBox();
// Shorter (the bottom half, dragged up): its content then has to scroll.
await page.mouse.move(g.x + g.width / 2, g.y + g.height * 0.85); await page.mouse.down();
await page.mouse.move(g.x + g.width / 2, g.y + g.height * 0.85 - 70, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(100);
const c = await cell.boundingBox();
const strip = await cell.locator(".carreau-long").boundingBox();
console.log(`resized to ${Math.round(c.height)}px; the strip starts ${Math.round(strip.x - c.x)}px from the cell's left (0: behind the circle)`);
console.log("its content scrolls:", await cell.locator(".carreau-content").evaluate((el) => `${el.scrollHeight > el.clientHeight} (${getComputedStyle(el).overflowY})`));
await page.screenshot({ path: "/tmp/sizedstrip.png", clip: { x: c.x, y: c.y, width: 260, height: c.height } });
await browser.close();
