// Async close: spinner where the × is; hover shows a red ×; clicking it forces the close.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => m.text().startsWith("force") && console.log("console:", m.text()));
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
await page.evaluate(() => { window.ws.root.children[0].weight = 2.2; window.ws.emit(); });
await page.waitForTimeout(200);
const tab = (t) => page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: new RegExp(`^${t}$`) }) }).first();
const sidebar = () => page.evaluate(() => window.ws.root.children[0].tabs.map((t) => t.title).join(","));
// "build" is unresponsive: its close never finishes
await tab("build").hover();
await tab("build").locator(".carreau-tab-close").click();
await page.waitForTimeout(300);
const spinner = tab("build").locator(".carreau-closing");
console.log("build closing: spinner", await spinner.count(), "| tab still there:", (await sidebar()).includes("build"));
const box = await tab("build").boundingBox();
await page.screenshot({ path: "/tmp/closing-spin.png", clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 } });
await spinner.hover();
await page.waitForTimeout(200);
console.log("hovered: red × opacity", await spinner.evaluate((e) => getComputedStyle(e, "::after").opacity));
await page.screenshot({ path: "/tmp/closing-hover.png", clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 } });
// re-renders keep the spinner (and its phase)
await tab("tests").click();
console.log("after another click: still closing", await tab("build").locator(".carreau-closing").count());
await tab("build").locator(".carreau-closing").click();
await page.waitForTimeout(200);
console.log("forced:", await sidebar());
// a shell cell (no tab bar): closes after a while, with the spinner on its strip
const ls = page.locator(".carreau-scroll > .carreau-pane").first();
await ls.locator(".carreau-long").click();
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
await page.keyboard.press("KeyW");
await page.waitForTimeout(150);
console.log("ls closing: strip spinner", await ls.locator(".carreau-long .carreau-closing").count());
const lb = await ls.boundingBox();
await page.screenshot({ path: "/tmp/closing-cell.png", clip: { x: lb.x, y: lb.y, width: lb.width, height: 60 } });
await page.waitForTimeout(1400);
const cells = () => page.evaluate(() => [...document.querySelectorAll(".carreau-scroll > .carreau-pane")].map((e) => e.querySelector(".carreau-tab-short").textContent).join(","));
console.log("after 1.4s:", await cells(), "| focused:", await page.evaluate(() => { const n = window.ws.node(window.ws.selection.id); return n.tabs[n.active].title; }));
await page.keyboard.press("Escape");
await browser.close();
