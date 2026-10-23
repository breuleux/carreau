// A line's other choices: mini lines popping out next to the cursor after 250ms, on both sides.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const state = () => page.evaluate(() => { const d = window.view.drag; const t = d.active?.target; return `active ${t?.kind ?? "none"}${t?.side ? ":" + t.side + " of " + window.ws.node(t.targetId)?.type : ""} | minis ${document.querySelectorAll(".carreau-mini").length} | dashes? ${document.querySelectorAll(".carreau-overlay rect.carreau-indicator").length} rects`; });
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Grid 3×3"));
await page.waitForTimeout(200);
const c1 = await page.locator(".carreau-tab", { hasText: /^C1$/ }).boundingBox();
const b2 = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^B2$/ }) }).boundingBox();
await page.mouse.move(c1.x + 5, c1.y + 5); await page.mouse.down();
await page.mouse.move(c1.x + 60, c1.y + 60, { steps: 4 });
const x = b2.x + 2, y = b2.y + b2.height / 2;
await page.mouse.move(x, y, { steps: 4 });
console.log("on the line:", await state());
await page.waitForTimeout(350);
console.log("after 350ms:", await state());
const minis = await page.locator(".carreau-mini").evaluateAll((gs) => gs.map((g) => { const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
await page.screenshot({ path: "/tmp/minis.png", clip: { x: x - 80, y: y - 60, width: 160, height: 120 } });
// Onto the mini on the inner side (B2's), then the outer one.
for (const m of minis) {
  await page.mouse.move(m.x, m.y, { steps: 3 });
  console.log(`on the mini at ${Math.round(m.x - x)}px:`, await state());
}
await page.screenshot({ path: "/tmp/minis-active.png" });
await page.mouse.move(x - 4, y, { steps: 3 }); // (the line, drawn on the gap's middle)
console.log("back on the line:", await state());
await page.mouse.move(b2.x + b2.width / 2, y, { steps: 6 });
console.log("away:", await state());
await page.keyboard.press("Escape"); await page.mouse.up();
await browser.close();
