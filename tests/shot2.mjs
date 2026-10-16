import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Uneven");
// drag pane "Main" by its grip onto pane Y's left side
const grip = page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Main$/ }) }).locator(".carreau-tabspace");
const y = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Y$/ }) }).boundingBox();
const g = await grip.boundingBox();
await page.mouse.move(g.x + 5, g.y + 5); await page.mouse.down();
await page.mouse.move(y.x + y.width / 2, y.y + y.height / 2, { steps: 8 });
await page.mouse.move(y.x + 20, y.y + y.height / 2, { steps: 4 });
await page.screenshot({ path: "/tmp/carreau-uneven-drag.png" });
await page.mouse.up();
await page.screenshot({ path: "/tmp/carreau-uneven-dropped.png" });
await browser.close();
