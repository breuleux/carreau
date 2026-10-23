// Single pane: beta split to the right of alpha, beta shrunk as far as it goes, then alpha
// shrunk: the two still fill the row (no blank space), alpha at 90%.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const altQ = async (...keys) => { await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); for (const k of keys) await page.keyboard.press(k); await page.keyboard.up("Alt"); await page.waitForTimeout(80); };
const widths = () => page.evaluate(() => { const root = document.querySelector(".carreau-root > *").getBoundingClientRect(); const ps = [...document.querySelectorAll(".carreau-root .carreau-pane")].map((p) => p.getBoundingClientRect()); const used = Math.max(...ps.map((r) => r.right)) - root.left; return `panes ${ps.map((r) => Math.round(r.width)).join(" + ")}, row ${Math.round(root.width)}, blank at the right: ${Math.round(root.width - used)}px`; });
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Single pane"));
await page.waitForTimeout(200);
const beta = await page.locator(".carreau-tab", { hasText: /^beta$/ }).boundingBox();
const pane = await page.locator(".carreau-pane").first().boundingBox();
await page.mouse.move(beta.x + 10, beta.y + 10); await page.mouse.down();
await page.mouse.move(beta.x + 60, beta.y - 60, { steps: 4 });
await page.mouse.move(pane.x + pane.width - 40, pane.y + pane.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(100);
console.log("beta split to the right:", await widths());
await altQ(...Array(20).fill("BracketLeft"));
console.log("beta narrower ×20:", await widths());
await page.locator(".carreau-tab", { hasText: /^alpha$/ }).click();
await altQ("BracketLeft");
console.log("alpha narrower:", await widths());
await browser.close();
