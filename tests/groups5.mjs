import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=IDE");
const visibleTabs = () => page.evaluate(() => [...document.querySelectorAll(".carreau-tab")].filter((t) => t.getBoundingClientRect().width > 0).map((t) => t.textContent).join(","));
await page.locator(".carreau-tab", { hasText: /^Terminal$/ }).click();
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
await page.keyboard.press("KeyP"); await page.keyboard.press("KeyG");
await page.locator(".carreau-tab-edit").fill("Zazz"); await page.keyboard.press("Enter");
await page.keyboard.press("KeyC"); // Terminal, inside Zazz
await page.keyboard.press("KeyM");
console.log("maximized Terminal (in Zazz):", await visibleTabs());
await page.screenshot({ path: "/tmp/g-max.png" });
await page.keyboard.press("KeyM");
await page.keyboard.press("KeyP"); // Zazz
await page.keyboard.press("KeyM");
console.log("maximized Zazz itself:       ", await visibleTabs());
await browser.close();
