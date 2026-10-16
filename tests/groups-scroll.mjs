import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
for (const [ex, a, b, key] of [["Scroll column", "Setup", "Left cell", "Shift+ArrowDown"], ["Scroll row", "Card 3", "Wide card", "Shift+ArrowRight"]]) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(ex));
  await page.locator(".carreau-pane", { has: page.locator(".carreau-tab-short", { hasText: new RegExp(`^${a}$`) }) }).last().locator(":scope > .carreau-body").click({ position: { x: 20, y: 30 } });
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
  await page.keyboard.press(key); // a range of two cells
  await page.keyboard.press("KeyG"); await page.keyboard.type("grp"); await page.keyboard.press("Enter");
  const sizes = await page.evaluate(() => [...document.querySelectorAll(".carreau-group:not([hidden]) .carreau-pane")].map((p) => `${p.querySelector(".carreau-tab-short").textContent}=${Math.round(p.getBoundingClientRect().width)}x${Math.round(p.getBoundingClientRect().height)}`).join(" "));
  console.log(ex.padEnd(14), "group cells:", sizes);
  await page.screenshot({ path: `/tmp/gs-${ex.replace(" ", "-")}.png` });
}
await browser.close();
