// Alt+Q, M from the prompt: the cell above (the secondary focus) is maximized and focused.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
await page.locator(".carreau-prompt-input").click();
const st = () => page.locator("#status").textContent();
const visible = () => page.evaluate(() => [...document.querySelectorAll(".carreau-pane")].filter((p) => p.getClientRects().length && !p.closest(".max-hidden")).map((p) => p.querySelector(".carreau-tab-short")?.textContent).join(", "));
console.log("start:", await st());
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyM"); await page.waitForTimeout(100);
console.log("Alt+Q, M:", await st(), "| visible panes:", await visible());
await page.screenshot({ path: "/tmp/carreau-check/promptmax.png" });
await page.keyboard.press("KeyM"); await page.waitForTimeout(100);
console.log("M again:", await st());
await page.keyboard.up("Alt");
await browser.close();
