// A named pane emptied of its tabs stays (with a hint), takes tabs dropped into it, and goes
// when closed from its ⋯ menu.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const bars = () => page.evaluate(() => [...document.querySelectorAll(".carreau-tabbar:not([hidden])")].map((b) => (b.querySelector(".carreau-pane-name")?.textContent ? `[${b.querySelector(".carreau-pane-name").textContent}] ` : "") + ([...b.querySelectorAll(".carreau-tab-short")].map((t) => t.textContent).join(" ") || "∅")).join(" | "));
const tab = (name) => page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: new RegExp(`^${name}$`) }) });
await page.goto("http://localhost:5317/?example=IDE");
await page.waitForTimeout(200);
await page.evaluate(() => { const p = window.ws.trees().flatMap((t) => [...(function* w(n) { yield n; for (const c of n.children ?? []) yield* w(c); })(t)]).find((n) => n.type === "pane" && n.tabs.some((t) => t.title === "Outline")); window.ws.namePane(p.id, "side"); });
await page.waitForTimeout(100);
await page.evaluate(() => window.ws.sendTo(window.ws.paneByName("side").tabs[0].id, "left"));
await page.waitForTimeout(100);
console.log("Outline sent away:", await bars(), "| hint:", await page.locator(".carreau-empty").textContent());
await page.screenshot({ path: "/tmp/emptynamed.png" });
// Drag README.md into the empty pane's body: the "tab" icon in its middle.
const side = await page.locator(".carreau-pane", { has: page.locator(".carreau-pane-name", { hasText: "side" }) }).boundingBox();
const r = await tab("README.md").boundingBox();
await page.mouse.move(r.x + 10, r.y + 10); await page.mouse.down();
await page.mouse.move(r.x + 60, r.y - 60, { steps: 4 });
await page.mouse.move(side.x + side.width / 2, side.y + side.height / 2, { steps: 8 });
console.log("over its middle:", await page.evaluate(() => window.view.drag.zones?.centers.map((c) => c.kind).join(",") + " | active " + (window.view.drag.active?.target.kind ?? "none")));
await page.mouse.up();
await page.waitForTimeout(100);
console.log("dropped:", await bars());
await page.locator(".carreau-pane", { has: page.locator(".carreau-pane-name", { hasText: "side" }) }).locator(".carreau-more").click();
await page.locator(".carreau-menu button", { hasText: "Close pane" }).click();
await page.waitForTimeout(200);
console.log("Close pane:", await bars());
await browser.close();
