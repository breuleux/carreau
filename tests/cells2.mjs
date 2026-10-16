import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
const cellPane = (short) => page.locator(".carreau-pane", { has: page.locator(":scope > .carreau-tabbar .carreau-tab-short", { hasText: new RegExp(`^${short}$`) }) }).last();
const tabsOf = (short) => cellPane(short).locator(":scope > .carreau-tabbar .carreau-tab-short").allTextContents();
// 1. drag the sidebar's "build" tab to the center of the "ls" cell: swap + tab icons
const t = await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: /^build$/ }) }).boundingBox();
const c = await cellPane("ls").boundingBox();
await page.mouse.move(t.x + 10, t.y + 5); await page.mouse.down();
await page.mouse.move(t.x + 80, t.y - 80, { steps: 5 });
await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 8 });
const icons = await page.evaluate(() => window.view.drag.zones.centers.map((z) => `${z.kind}@${Math.round(z.cx)}`).join(" "));
console.log("center icons:", icons);
const tabIcon = await page.evaluate(() => { const z = window.view.drag.zones.centers.find((z) => z.kind === "tab"); const b = document.querySelector(".carreau").getBoundingClientRect(); return [z.cx + b.left, z.cy + b.top]; });
await page.mouse.move(tabIcon[0], tabIcon[1], { steps: 4 });
console.log("on the tab icon:", await page.evaluate(() => window.view.drag.active?.target.kind), "| preview:", await page.locator(".carreau-preview").count());
await page.screenshot({ path: "/tmp/cells-tabicon.png", clip: { x: c.x, y: c.y, width: c.width, height: c.height } });
await page.mouse.up();
console.log("ls cell tabs now:", (await tabsOf("ls")).join(","), "| tab bar:", await cellPane("ls").locator(":scope > .carreau-tabbar").isVisible());
// 2. drag the "make test" cell by its long strip below "Explain"
const long = await cellPane("make test").locator(":scope > .carreau-body > .carreau-long").boundingBox();
const g = await cellPane("ls").boundingBox();
await page.mouse.move(long.x + 50, long.y + 5); await page.mouse.down();
await page.mouse.move(long.x + 80, long.y + 40, { steps: 5 });
await page.mouse.move(g.x + g.width / 2, g.y + g.height * 0.62, { steps: 8 });
console.log("dragging by long:", await page.evaluate(() => `${window.view.drag?.subject.kind} → ${window.view.drag?.active?.target.kind}:${window.view.drag?.active?.target.side}`));
await page.mouse.up();
console.log("cells:", await page.evaluate(() => [...document.querySelectorAll(".carreau-scroll > [data-id]")].map((e) => e.querySelector(".carreau-tab-short")?.textContent).join(", ")));
// 3. status icons up close: widen the sidebar
await page.evaluate(() => { window.ws.root.children[0].weight = 3; window.ws.emit(); });
await page.waitForTimeout(600);
const bar = await page.locator(".carreau-root > .carreau-split > .carreau-pane > .carreau-tabbar").first().boundingBox();
await page.screenshot({ path: "/tmp/cells-status.png", clip: { x: bar.x, y: bar.y, width: bar.width, height: bar.height } });
await browser.close();
