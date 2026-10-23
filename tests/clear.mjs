// Alt+Q, L: clear the finished cells (done, standby, error) in the selection.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const altQ = async (...keys) => { await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); for (const k of keys) await page.keyboard.press(k); await page.keyboard.up("Alt"); await page.waitForTimeout(150); };
const cells = () => page.evaluate(() => [...document.querySelectorAll(".carreau-scrollcell")].map((c) => `${c.querySelector(".carreau-tab-short")?.textContent}${c.dataset.status ? ":" + c.dataset.status : ""}`).join(" "));
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
console.log("cells:", await cells());
await page.screenshot({ path: "/tmp/clear-standby.png", clip: { x: 250, y: 230, width: 300, height: 60 } });
// The selection: one cell (done) → just it.
await page.locator(".carreau-long", { hasText: "ls -la" }).click();
await altQ("KeyL");
console.log("L on ls (done):", await cells());
// The whole column (its holder: up from a cell, with ','), then L.
await page.locator(".carreau-long", { hasText: "make test" }).click();
await altQ("Comma", "KeyL");
await page.waitForTimeout(1500); // (shell cells take a moment to close, in the demo)
console.log("L on the column:", await cells(), "|", await page.locator("#status").textContent());
await altQ("KeyZ");
console.log("undo:", await cells());
await browser.close();
