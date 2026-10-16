import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.goto("http://localhost:5317/?example=IDE");
await page.locator(".carreau-tab", { hasText: /^Terminal$/ }).click();
await page.screenshot({ path: "/tmp/page.png" });
await browser.close();
