import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const paneBox = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${t}$`) }) }).boundingBox();
const active = () => page.evaluate(() => { const d = window.view.drag; return `hover=${d.hoverPane} active=${d.active ? d.active.target.kind + ":" + d.active.ownerId : "none"} across=${d.near?.across.length ?? "-"}`; });
async function run(example, tab, target, dx, shot, clip, extra = []) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(example));
  const t = await page.locator(".carreau-tab", { hasText: new RegExp(`^${tab}$`) }).boundingBox();
  await page.mouse.move(t.x + 5, t.y + 5); await page.mouse.down();
  await page.mouse.move(t.x + 60, t.y + 60, { steps: 5 });
  const r = await paneBox(target);
  await page.mouse.move(r.x + dx, r.y + r.height / 2, { steps: 6 });
  console.log(shot, await active());
  await page.screenshot({ path: shot, clip });
  for (const ddx of extra) {
    await page.mouse.move(r.x + ddx, r.y + r.height / 2, { steps: 2 });
    console.log("  dx", ddx, await active());
  }
  await page.mouse.up();
}
await run("Grid 3×3", "C1", "B2", 12, "/tmp/across-grid.png", { x: 250, y: 30, width: 260, height: 770 }, [2, -2, -4, -8]);
await run("IDE", "Outline", "main.ts", 12, "/tmp/across-ide.png", { x: 100, y: 30, width: 200, height: 770 });
await browser.close();
