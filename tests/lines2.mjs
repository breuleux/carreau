import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
const paneBox = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${t}$`) }) }).boundingBox();
const st = () => page.evaluate(() => { const d = window.view.drag; return d.near ? `${d.near.side}: ${d.near.levels.map((c) => c.target.kind + ":" + window.ws.node(c.target.targetId ?? c.target.splitId)?.type).join(", ")}` : "no line"; });
async function probe(ex, tab, target, dx, shot, clip) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(ex));
  const t = await page.locator(".carreau-tab", { hasText: new RegExp(`^${tab}$`) }).boundingBox();
  await page.mouse.move(t.x + 5, t.y + 5); await page.mouse.down();
  await page.mouse.move(t.x + 60, t.y + 60, { steps: 5 });
  const r = await paneBox(target);
  await page.mouse.move(r.x + dx, r.y + r.height / 2, { steps: 6 });
  console.log(`${ex} ${target} left:`, await st());
  await page.screenshot({ path: shot, clip });
  await page.mouse.up();
}
await probe("Deep nesting", "E", "A", 3, "/tmp/ln-deep.png", { x: 0, y: 30, width: 700, height: 770 });
await probe("Grid 3×3", "C1", "B2", 2, "/tmp/ln-grid.png", { x: 250, y: 30, width: 260, height: 770 });
await probe("IDE", "Outline", "Terminal", 2, "/tmp/ln-ide.png", { x: 100, y: 30, width: 200, height: 770 });
await browser.close();
