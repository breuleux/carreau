// Dragging a whole complex by its link icon: into another tab bar, then beside a pane.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const tabs = () => page.evaluate(() => [...document.querySelectorAll(".carreau-tabbar .carreau-tabs")].map((s) => [...s.children].map((c) => (c.classList.contains("carreau-tab-link") ? "🔗" : c.querySelector(".carreau-tab-short").textContent)).join(" ")).join(" | "));
const tab = (name) => page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: new RegExp(`^${name}$`) }) });
async function drag(from, x, y, shot) {
  const a = await from.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 15, a.y + a.height / 2 - 15, { steps: 4 });
  await page.mouse.move(x, y, { steps: 10 });
  const ghost = await page.locator(".carreau-ghost").textContent();
  if (shot) await page.screenshot({ path: shot });
  await page.mouse.up();
  return ghost;
}
await page.goto("http://localhost:5317/?example=Plots");
await page.waitForTimeout(200);
const s = await tab("Sine").boundingBox();
await drag(tab("Cosine"), s.x + s.width / 2, s.y + s.height / 2);
console.log("merged:", await tabs());
// By the link icon, to the end of Damped's tab bar (the plain dot past Damped).
const d = await tab("Damped").boundingBox();
console.log("ghost:", await drag(page.locator(".carreau-tab-link").first(), d.x + d.width + 3, d.y + d.height / 2));
console.log("into Damped's tabs:", await tabs());
// Again, to the right third of the Square pane: a new pane beside it.
const sq = await page.locator(".carreau-pane", { has: tab("Square") }).boundingBox();
await drag(page.locator(".carreau-tab-link").first(), sq.x + sq.width - 30, sq.y + sq.height / 2, "/tmp/merge3-drag.png");
console.log("beside Square:", await tabs());
await page.screenshot({ path: "/tmp/merge3.png" });
await browser.close();
