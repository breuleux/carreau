// Marks: Alt+Q, Q (sticky), X to mark (numbered badges), move around, V to bring them to the
// focus. Leaving navigation mode clears them.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const bars = () => page.evaluate(() => [...document.querySelectorAll(".carreau-tabbar:not([hidden])")].map((b) => [...b.querySelectorAll(".carreau-tab")].map((t) => t.querySelector(".carreau-tab-short").textContent + (t.dataset.mark ? `(${t.dataset.mark})` : "")).join(" ")).join(" | "));
await page.goto("http://localhost:5317/?example=IDE");
await page.waitForTimeout(200);
await page.locator(".carreau-tab", { hasText: /^main\.ts$/ }).click();
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
await page.keyboard.press("KeyX");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("KeyX");
await page.waitForTimeout(100);
console.log("marked:", await bars());
await page.screenshot({ path: "/tmp/marks.png", clip: { x: 160, y: 560, width: 840, height: 240 } });
await page.keyboard.press("ArrowRight");
await page.keyboard.press("KeyV");
await page.waitForTimeout(100);
console.log("V on Outline:", await bars());
await page.keyboard.press("KeyX");
await page.waitForTimeout(100);
console.log("marked again:", await bars());
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
console.log("left navigation mode:", await bars(), "| marks:", await page.evaluate(() => window.ws.marked.length));
await browser.close();
