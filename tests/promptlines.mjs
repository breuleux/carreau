// A prompt column's lines: none above its first cell when the cells don't reach the column's top
// (not a separator: the empty space above takes drops); below its last cell, the gap above the
// prompt: inserting there.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
await page.waitForTimeout(300);
const desc = () => page.evaluate(() => { const d = window.view.drag; const n = (id) => { const x = window.ws.node(id); return x?.type === "pane" ? "pane:" + x.tabs.map(t=>t.title).join("+") : x?.type; };
  const f = (c) => `${c.target.kind}:${c.target.kind === "side" ? n(c.target.targetId) + "/" + c.target.side : n(c.target.splitId) + "@" + c.target.index}`;
  return d.near ? `${d.near.side} levels[${d.near.levels.map(f).join(" | ")}] far[${d.near.far.map(f).join(" | ")}]` : "no line"; });
const cells = page.locator(".carreau-frame-inner > .carreau-pane");
console.log("cells", await cells.count());
const t = await page.locator(".carreau-tabbar:not([hidden]) .carreau-tab").first().boundingBox();
await page.mouse.move(t.x + 10, t.y + 5); await page.mouse.down();
await page.mouse.move(t.x + 80, t.y + 80, { steps: 5 });
for (const [label, i, fy] of [["first top", 0, 0.004], ["last bottom", -1, 0.996]]) {
  const b = await (i < 0 ? cells.last() : cells.first()).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * fy, { steps: 5 });
  console.log(label, await desc());
  await page.waitForTimeout(400);
  console.log("  minis:", await page.evaluate(() => (window.view.drag.minis?.items ?? []).map((m) => `${m.choice.target.kind}/${m.choice.target.side ?? ""}`).join(",")));
}
await page.keyboard.press("Escape"); await page.mouse.up();
await browser.close();
