import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const paneOf = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${t}$`) }) }).first();
const summary = () => page.evaluate(() => `floats=[${window.ws.floating.map((w) => (w.root.tabs ?? []).map((t) => t.title).join("+")).join(", ")}] tree=${[...document.querySelectorAll(".carreau-root .carreau-pane")].map((p) => [...p.querySelectorAll(".carreau-tab")].map((t) => t.textContent).join("+")).join(" | ")}`);
async function dragToOwnCenter(handle, paneTitle, shot) {
  const h = await handle.boundingBox();
  const p = await paneOf(paneTitle).boundingBox();
  await page.mouse.move(h.x + 5, h.y + 5); await page.mouse.down();
  await page.mouse.move(h.x + 40, h.y + 40, { steps: 5 });
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2, { steps: 6 });
  const st = await page.evaluate(() => { const z = window.view.drag?.zones?.center; return `icon=${z?.kind ?? "none"} active=${window.view.drag?.active?.target.kind ?? "none"}`; });
  if (shot) await page.screenshot({ path: shot });
  await page.mouse.up();
  return st;
}
await page.goto("http://localhost:5317/?example=IDE");
console.log("pane grip ->", await dragToOwnCenter(paneOf("Terminal").locator(".carreau-tabspace"), "Terminal", "/tmp/cloud.png"));
console.log("  ", await summary());
console.log("tab among others ->", await dragToOwnCenter(page.locator(".carreau-tab", { hasText: /^Search$/ }), "Files"));
console.log("  ", await summary());
console.log("lone tab ->", await dragToOwnCenter(page.locator(".carreau-tab", { hasText: /^Outline$/ }), "Outline"));
console.log("  ", await summary());
await page.goto("http://localhost:5317/?example=Single%20pane");
console.log("last pane ->", await dragToOwnCenter(paneOf("alpha").locator(".carreau-tabspace"), "alpha"));
await browser.close();
