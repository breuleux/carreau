// Styles: scroll cells (long strip behind the bar's circle, the nav-mode outline over it), and
// drop lines (thin, flat, on the cursor's side only).
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
await page.locator(".carreau-long", { hasText: "make test" }).click();
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ");
await page.waitForTimeout(100);
await page.screenshot({ path: "/tmp/style-cell.png", clip: { x: 250, y: 230, width: 500, height: 330 } });
await page.keyboard.up("Alt");
// A drop line: drag "ls"'s strip over the border between two cells.
const src = await page.locator(".carreau-long", { hasText: "ls -la" }).boundingBox();
const tgt = await page.locator(".carreau-scrollcell", { has: page.locator(".carreau-long", { hasText: "Explain" }) }).boundingBox();
await page.mouse.move(src.x + 80, src.y + src.height / 2);
await page.mouse.down();
await page.mouse.move(src.x + 100, src.y + 40, { steps: 4 });
await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height - 3, { steps: 8 });
await page.waitForTimeout(100);
console.log("drawn rects on the line:", await page.locator(".carreau-overlay rect.carreau-indicator").count(), "| gradients:", await page.locator(".carreau-overlay linearGradient").count());
await page.screenshot({ path: "/tmp/style-line.png", clip: { x: tgt.x - 20, y: tgt.y + tgt.height - 60, width: 560, height: 120 } });
await page.keyboard.press("Escape");
await page.mouse.up();
await browser.close();
