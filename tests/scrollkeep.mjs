import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Scroll column"));
const top = () => page.evaluate(() => [...document.querySelectorAll(".carreau-scroll")].map((e) => `${e.scrollTop}${e.getClientRects().length ? "" : " (hidden)"}`).join(","));
// put a second tab next to "Scroll column": drag Inspector into its tab bar
const sc = page.locator(".carreau-scroll");
await sc.evaluate((e) => (e.scrollTop = 700));
await page.waitForTimeout(100);
console.log("scrolled:", await top());
const insp = await page.locator(".carreau-tab", { hasText: /^Inspector$/ }).boundingBox();
const stab = await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: /^Scroll column$/ }) }).boundingBox();
await page.mouse.move(insp.x + 5, insp.y + 5); await page.mouse.down();
await page.mouse.move(insp.x - 60, insp.y - 60, { steps: 5 });
await page.mouse.move(stab.x + stab.width + 5, stab.y + stab.height / 2, { steps: 8 });
await page.mouse.up();
console.log("Inspector added (active):", await top());
await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: /^Scroll column$/ }) }).click();
console.log("back to Scroll column:   ", await top());
await page.locator(".carreau-tab", { hasText: /^Inspector$/ }).click();
await page.locator(".carreau-tab", { hasText: /^Outline$/ }).click(); // other re-renders meanwhile
await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: /^Scroll column$/ }) }).click();
console.log("and again:               ", await top());
await browser.close();
