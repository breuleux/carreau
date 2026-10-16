import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const st = () => page.evaluate(() => { const d = window.view.drag; return `hover=${d.hoverPane} near=${d.near?.side ?? "-"} active=${d.active ? d.active.target.kind + ":" + (d.active.target.side ?? "") : "none"}`; });
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Scroll column"));
const sc = page.locator(".carreau-scroll");
await sc.evaluate((e) => (e.scrollTop = 420));
// click a tab in a cell: re-render must keep the scroll position
await page.locator(".carreau-tab", { hasText: /^Other tab$/ }).click();
console.log("scrollTop after re-render:", await sc.evaluate((e) => e.scrollTop));
// drag Inspector over the partially scrolled-out "Long cell"/"Other tab" pane
const t = await page.locator(".carreau-tab", { hasText: /^Inspector$/ }).boundingBox();
const scb = await sc.boundingBox();
await page.mouse.move(t.x + 5, t.y + 5); await page.mouse.down();
await page.mouse.move(t.x - 100, t.y + 100, { steps: 5 });
const pane = page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Other tab$/ }) }).last();
let r = await pane.boundingBox();
console.log("pane top", r.y.toFixed(0), "viewport top", scb.y.toFixed(0));
await page.mouse.move(r.x + r.width / 2, scb.y + 3, { steps: 4 });
console.log("at viewport top (pane's top border hidden):", await st());
await page.mouse.move(r.x + 3, scb.y + 60, { steps: 4 });
console.log("on left line:", await st());
await page.screenshot({ path: "/tmp/scroll-drag.png" });
// wheel-scroll during the drag; indicators must follow
await page.mouse.wheel(0, 300);
await page.waitForTimeout(200);
console.log("after wheel, scrollTop", await sc.evaluate((e) => e.scrollTop), await st());
await page.screenshot({ path: "/tmp/scroll-drag2.png" });
// bottom border between two cells
r = await pane.boundingBox();
await page.mouse.move(r.x + r.width / 2, r.y + r.height + 1, { steps: 4 });
console.log("between cells:", await st());
await page.mouse.up();
const kids = await sc.evaluate((e) => [...e.children].filter((c) => c.dataset.id).map((c) => c.querySelector(".carreau-tab")?.textContent).join(","));
console.log("scroll-column children:", kids);
console.log("types:", await page.evaluate(() => window.ws.root.children.map((c) => c.type).join(",")));
await browser.close();
