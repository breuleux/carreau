// Alt+Q, I, Enter: a new cell into the focused cell's own tabs.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const tabs = () => page.evaluate(() => [...document.querySelectorAll(".carreau-tabbar:not([hidden]) .carreau-tabs")].map((s) => [...s.querySelectorAll(".carreau-tab-short")].map((t) => t.textContent).join(" ")).join(" | "));
const altQ = async (...keys) => { await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); for (const k of keys) await page.keyboard.press(k); await page.keyboard.up("Alt"); await page.waitForTimeout(100); };
await page.goto("http://localhost:5317/?example=IDE");
await page.waitForTimeout(200);
await page.locator(".carreau-tab", { hasText: /^Terminal$/ }).click();
console.log("before:", await tabs());
await altQ("KeyI", "Enter");
console.log("Alt+Q, I, Enter:", await tabs(), "| focused:", await page.evaluate(() => { const n = window.ws.node(window.ws.selection.id); return n.tabs[n.active].title; }));
await altQ("KeyZ");
console.log("undo:", await tabs());
console.log("legend:", await page.locator("#keys").evaluate((k) => k.textContent.includes("insertInto") && k.textContent.includes("Enter")));
await browser.close();
