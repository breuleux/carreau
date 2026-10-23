// Closing a prompt column whose editor is custom: the editor goes, cleanly.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Custom prompt"));
await page.waitForTimeout(200);
await page.locator(".carreau-tab", { hasText: "Chat" }).locator(".carreau-tab-close").click();
await page.waitForTimeout(300);
console.log("closed Chat: editors left", await page.locator(".demo-prompt").count(), "| tabs", await page.locator(".carreau-tab").allTextContents());
await page.evaluate(() => window.ws.undo());
await page.waitForTimeout(200);
console.log("undo: editors", await page.locator(".demo-prompt").count());
await browser.close();
