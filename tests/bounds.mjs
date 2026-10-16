import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=IDE");
const outline = page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Outline$/ }) });
await outline.locator(".carreau-more").click();
await page.locator(".carreau-menu button", { hasText: "Float" }).click();
const ws = await page.locator(".carreau").boundingBox();
const rect = () => page.evaluate(() => { const r = window.ws.floating[0].rect; const el = document.querySelector(".carreau"); return `x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.w)} h=${Math.round(r.h)} | right=${Math.round(r.x + r.w)}/${el.clientWidth} bottom=${Math.round(r.y + r.h)}/${el.clientHeight}`; });
const inside = () => page.evaluate(() => { const r = window.ws.floating[0].rect; const el = document.querySelector(".carreau"); return r.x >= 0 && r.y >= 0 && r.x + r.w <= el.clientWidth + 0.5 && r.y + r.h <= el.clientHeight + 0.5; });
async function dragFrom(sel, dx, dy) {
  const b = await page.locator(sel).boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}
console.log("initial:          ", await rect());
await dragFrom(".carreau-float-bar", -2000, -2000);
console.log("moved far up-left:", await rect(), "inside:", await inside());
await dragFrom(".carreau-float-bar", 3000, 3000);
console.log("moved far down-right:", await rect(), "inside:", await inside());
for (const dir of ["nw", "n", "w", "ne", "sw"]) {
  await dragFrom(`.carreau-resize-${dir}`, dir.includes("w") ? -3000 : dir.includes("e") ? 3000 : 0, dir.includes("n") ? -3000 : dir.includes("s") ? 3000 : 0);
  console.log(`resize ${dir} far out:`.padEnd(20), await rect(), "inside:", await inside());
}
await dragFrom(".carreau-resize-se", -3000, -3000);
console.log("resize se tiny:    ", await rect());
await dragFrom(".carreau-resize-se", 3000, 3000);
console.log("full size again:   ", await rect());
// shrink the viewport: the window must be refit
await page.setViewportSize({ width: 900, height: 500 });
await page.waitForTimeout(200);
console.log("after viewport shrink:", await rect(), "inside:", await inside());
await browser.close();
