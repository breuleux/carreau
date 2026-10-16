import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Uneven");
const paneOf = (t) => page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${t}$`) }) });
async function drag(tab, target, fx, fy, shot) {
  const t = await page.locator(".carreau-tab", { hasText: new RegExp(`^${tab}$`) }).boundingBox();
  const y = await paneOf(target).boundingBox();
  await page.mouse.move(t.x + 5, t.y + 5); await page.mouse.down();
  await page.mouse.move(y.x + y.width / 2, y.y + y.height / 2, { steps: 8 });
  await page.mouse.move(fx(y), fy(y), { steps: 4 });
  await page.screenshot({ path: shot });
  await page.mouse.up();
}
// Y's top boundary (between X and Y): just above Y's top edge -> in the gap
await drag("Docs", "Y", (r) => r.x + r.width / 2 + 30, (r) => r.y - 1, "/tmp/between-top.png");
const heights = await Promise.all(["X", "Docs", "Y", "Z"].map(async (t) => (await paneOf(t).boundingBox()).height));
const tot = heights.reduce((a, b) => a + b);
console.log("column fractions", heights.map((h) => (h / tot).toFixed(3)).join(" "));
// Y's left boundary (between Main column and XYZ column)
await drag("Logs", "Y", (r) => r.x + 2, (r) => r.y + r.height / 2, "/tmp/between-left.png");
const ws = await page.evaluate(() => {
  const row = window.ws.root.children[1];
  return row.children.map((c) => `${c.type}:${c.weight.toFixed(2)}`).join(" ");
});
console.log("row", ws);
await page.screenshot({ path: "/tmp/between-after.png" });
await browser.close();
