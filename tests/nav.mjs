import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Scroll column"));
await page.evaluate(() => { const p = [...document.querySelectorAll(".carreau-pane")].find((e) => e.querySelector(".carreau-tab-short")?.textContent === "Intro"); window.ws.select({ id: p.dataset.id }); });
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
console.log("selected:", await page.evaluate(() => window.ws.node(window.ws.selection.id).tabs[0].title), "scrollTop:", await page.locator(".carreau-scroll").evaluate((e) => e.scrollTop));
await browser.close();
