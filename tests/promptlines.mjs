// A prompt column's lines: above its first cell and below its last (above the prompt), each offers
// inserting at that end, and as a mini line, splitting the column's pane on that side.
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
const m = await page.evaluate(() => { const r = window.view.drag.minis.items[0].rect; const b = window.view.el.getBoundingClientRect(); return { x: r.x + b.left + r.w / 2, y: r.y + b.top + r.h / 2 }; });
await page.mouse.move(m.x, m.y, { steps: 3 });
console.log("on mini:", await page.evaluate(() => JSON.stringify(window.view.drag.active?.target)));
await page.screenshot({ path: "/tmp/minibottom.png" });
await page.mouse.up(); await page.waitForTimeout(200);
console.log("after drop:", await page.evaluate(() => { const s = (n) => n.type === "pane" ? n.tabs.map((t) => t.group ? s(t.group) : t.title).join("+") : n.type + "(" + (n.children ?? []).map(s).join(", ") + ")"; return s(window.ws.root); }));
await browser.close();
