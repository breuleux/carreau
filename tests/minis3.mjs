// Several mini lines on one side: the widest nearest the line, evenly spaced.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Spiral");
await page.waitForTimeout(200);
const tabs = await page.locator(".carreau-tabbar:not([hidden]) .carreau-tab").allTextContents();
const src = await page.locator(".carreau-tabbar:not([hidden]) .carreau-tab").first().boundingBox();
await page.mouse.move(src.x + 5, src.y + 5); await page.mouse.down();
await page.mouse.move(src.x + 60, src.y + 60, { steps: 4 });
// Try each pane's edges until a line has several mini lines on one side.
let found = false;
for (const p of await page.locator(".carreau-root .carreau-pane").all()) {
  const b = await p.boundingBox();
  for (const [x, y] of [[b.x + 2, b.y + b.height / 2], [b.x + b.width - 2, b.y + b.height / 2], [b.x + b.width / 2, b.y + 2], [b.x + b.width / 2, b.y + b.height - 30]]) {
    await page.mouse.move(x, y, { steps: 2 });
    await page.waitForTimeout(320);
    const info = await page.evaluate(() => {
      const d = window.view.drag;
      const items = d.minis?.items ?? [];
      const by = { 1: items.filter((m) => m.dir === 1), "-1": items.filter((m) => m.dir === -1) };
      const side = by[1].length >= 2 ? by[1] : by["-1"].length >= 2 ? by["-1"] : null;
      if (!side) return null;
      const row = d.near.side === "left" || d.near.side === "right";
      const pos = side.map((m) => (row ? m.rect.x : m.rect.y));
      const widths = side.map((m) => Math.round(m.choice.span[1] - m.choice.span[0]));
      const band = d.near.band;
      return { side: d.near.side, widths, gaps: pos.slice(1).map((p, i) => Math.round(Math.abs(p - pos[i]) - 6)), first: Math.round(Math.min(...pos.map((p) => Math.abs(p - (row ? d.near.edge : d.near.edge))))) };
    });
    if (info) {
      console.log("several on one side:", JSON.stringify(info));
      await page.screenshot({ path: "/tmp/minis3.png", clip: { x: x - 70, y: y - 50, width: 140, height: 100 } });
      found = true;
      break;
    }
  }
  if (found) break;
}
if (!found) console.log("no edge with several mini lines on one side");
await page.keyboard.press("Escape"); await page.mouse.up();
await browser.close();
