import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const paneOf = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${t}$`) }) });
async function hoverShots(example, tab, steps) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(example));
  const t = await page.locator(".carreau-tab", { hasText: new RegExp(`^${tab}$`) }).boundingBox();
  await page.mouse.move(t.x + 5, t.y + 5); await page.mouse.down();
  await page.mouse.move(t.x + 60, t.y + 60, { steps: 5 });
  for (const [target, fx, fy, shot, clip] of steps) {
    const r = await paneOf(target).boundingBox();
    await page.mouse.move(fx(r), fy(r), { steps: 6 });
    await page.screenshot({ path: shot, clip });
    console.log(shot, await page.evaluate(() => { const d = window.view.drag; return d.active ? `${d.active.target.kind} ${d.active.ownerId}` : "none"; }));
  }
  await page.mouse.up();
}
const clipL = { x: 150, y: 30, width: 400, height: 770 };
await hoverShots("IDE", "Outline", [
  ["main.ts", (r) => r.x + 30, (r) => r.y + r.height / 2, "/tmp/l-main-a.png", clipL],
  ["main.ts", (r) => r.x + 30, (r) => r.y + r.height / 2 + 18, "/tmp/l-main-b.png", clipL],
  ["main.ts", (r) => r.x + r.width / 2, (r) => r.y + r.height / 2, "/tmp/l-main-center.png", clipL],
  ["Terminal", (r) => r.x + 10, (r) => r.y + r.height / 2, "/tmp/l-term.png", clipL],
]);
await hoverShots("Deep nesting", "E", [
  ["A", (r) => r.x + 10, (r) => r.y + r.height / 2, "/tmp/l-deep.png", { x: 0, y: 30, width: 700, height: 770 }],
]);
await browser.close();
