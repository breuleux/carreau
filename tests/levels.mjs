// Print the drop line levels on each side of a few panes.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const desc = () => page.evaluate(() => {
  const d = window.view.drag, name = (id) => { const n = window.ws.node(id); return !n ? id : n.type === "pane" ? n.tabs[n.active].title : n.type; };
  return "hover=" + name(d.hoverPane) + "\n    " + d.lines.map((l) => `${l.side}: ${l.levels.map((c) => { const t = c.target; return t.kind === "side" ? `${name(t.targetId)}.${t.side}${c.edge ? "(end)" : ""}` : `${t.kind}@${name(t.splitId)}`; }).join(" | ")}`).join("\n    ");
});
for (const [ex, cell, drag] of [["Sticky", "ls", "Scroll row"], ["Sticky", "make test", "Scroll row"], ["Spiral", "1", "5"], ["Spiral", "3", "5"], ["Notebook", "ls", "deploy"], ["Notebook", "git log", "deploy"], ["IDE", "Terminal", "Outline"], ["Deep nesting", "A", "B"], ["Scroll column", "Long cell", "Outline"]]) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(ex));
  await page.waitForTimeout(200);
  if (ex === "Notebook") { await page.evaluate(() => { window.ws.root.children[0].weight = 2.2; window.ws.emit(); }); await page.waitForTimeout(100); }
  const src = await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: new RegExp(`^${drag}$`) }) }).first().boundingBox();
  const target = page.locator(".carreau-pane", { has: page.locator(":scope > .carreau-tabbar .carreau-tab-short", { hasText: new RegExp(`^${cell}$`) }) }).last();
  await target.scrollIntoViewIfNeeded();
  const r = await target.boundingBox();
  await page.mouse.move(src.x + 10, src.y + 5); await page.mouse.down();
  await page.mouse.move(src.x + 60, src.y + 60, { steps: 4 });
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 4 });
  const subj = await page.evaluate(() => JSON.stringify(window.view.drag.subject));
  console.log(`${ex} / ${cell} (${subj}):\n    ${await desc()}`);
  await page.mouse.up();
}
await browser.close();
