// Tab dwell during a drag: resting (still) on a tab for a moment focuses it; motion resets
// the wait. (buche: peeking at tabs while dragging cells around.)
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Single pane"));
await page.waitForTimeout(200);
// pa shows A (B hidden), pc holds the dragged tab C.
await page.evaluate(() => {
  const tab = (t) => ({ id: "t" + t, title: t, content: t });
  window.ws.load({ floating: [], root: { type: "row", id: "r", weight: 1, children: [
    { type: "pane", id: "pa", weight: 1, active: 0, tabs: [tab("A"), tab("B")] },
    { type: "pane", id: "pc", weight: 1, active: 0, tabs: [tab("C")] },
  ] } });
});
await page.waitForTimeout(200);
const active = () => page.evaluate(() => window.ws.node("pa").active);
const shown = () => page.evaluate(() => window.ws.node("pa").tabs[window.ws.node("pa").active].title);
const c = await page.locator(".carreau-tab", { hasText: /^C$/ }).boundingBox();
const b = await page.locator(".carreau-tab[data-tab=tB]").boundingBox();
await page.mouse.move(c.x + 10, c.y + 8); await page.mouse.down();
await page.mouse.move(c.x + 80, c.y - 60, { steps: 4 });
// Wiggle over B: motion keeps resetting the wait.
const bx = b.x + b.width / 2, by = b.y + b.height / 2;
await page.mouse.move(bx, by, { steps: 3 });
for (let i = 0; i < 8; i++) {
  await page.mouse.move(bx + (i % 2 ? 3 : -3), by, { steps: 2 });
  await page.waitForTimeout(60);
}
console.log("after 480ms of motion: active =", await active(), "(expected 0)");
// Now hold still: the wait completes.
await page.waitForTimeout(450);
console.log("after 450ms at rest:   active =", await active(), "shown =", await shown(), "(expected 1, B)");
// Cancel: the focus stays (the drag just goes away).
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
console.log("after cancel:          active =", await active(), "shown =", await shown(), "(expected 1, B)");
await browser.close();
