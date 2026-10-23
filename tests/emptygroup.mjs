// Dragging into a group that holds a kept empty pane (buche's "New pane"): the pane shows
// its hint, the center of the pane offers into it (its only center icon, the swap being a
// no-op against an empty pane), and a dropped tab lands inside the group.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Single pane"));
await page.waitForTimeout(200);
// A pane with two tabs, beside a pane whose only tab is a group: a kept empty pane.
await page.evaluate(() => {
  const tab = (t) => ({ id: "t" + t, title: t, content: t });
  window.ws.load({ floating: [], root: { type: "row", id: "r", weight: 1, children: [
    { type: "pane", id: "pa", weight: 1, active: 0, tabs: [tab("A"), tab("B")] },
    { type: "pane", id: "pg", weight: 1, active: 0, tabs: [
      { id: "tg", title: "G", group: { type: "slot", id: "sg", weight: 1, children: [{ type: "pane", id: "pe", weight: 1, active: 0, tabs: [], keep: true }] } },
    ] },
  ] } });
});
await page.waitForTimeout(200);
const st = () => page.evaluate(() => { const d = window.view.drag; const t = d.active?.target; const c = (d.zones?.centers ?? []).map((x) => x.kind + ":" + (x.choice.target.paneId ?? x.choice.target.splitId ?? "")).join(" "); return `hover=${d.hoverPane} inCenter=${d.inCenter} active=${t ? t.kind + ":" + (t.paneId ?? t.splitId ?? "") : "none"} centers=[${c}] preview=${document.querySelectorAll(".carreau-preview").length}`; });
console.log("kept pane stays, hint shows:", await page.evaluate(() => !!window.ws.node("pe") && !!document.querySelector("[data-id=pe] .carreau-empty")));
const b = await page.locator(".carreau-tab", { hasText: /^B$/ }).boundingBox();
const g = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /G$/ }) }).boundingBox();
await page.mouse.move(b.x + 10, b.y + 10); await page.mouse.down();
await page.mouse.move(b.x + 60, b.y - 60, { steps: 4 });
await page.mouse.move(g.x + g.width * 0.5, g.y + g.height * 0.8, { steps: 6 });
console.log("over the bottom edge  ", await st());
await page.mouse.move(g.x + g.width * 0.5, g.y + g.height * 0.55, { steps: 6 }); // the pane's center
const icon = await page.evaluate(() => { const d = window.view.drag; const c = d.zones.centers[0]; const r = window.view.el.getBoundingClientRect(); return { x: r.left + c.cx, y: r.top + c.cy }; });
await page.mouse.move(icon.x, icon.y, { steps: 6 });
console.log("over the empty center ", await st());
await page.screenshot({ path: "/tmp/emptygroup.png" });
await page.mouse.up();
await page.waitForTimeout(100);
const inside = await page.evaluate(() => { const p = window.ws.node("pe"); return !!p && p.tabs.length === 1 && p.tabs[0].title === "B"; });
console.log("B inside the group:", inside);
await browser.close();
