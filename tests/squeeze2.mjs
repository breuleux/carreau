import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Scroll column"));
const cells = () => page.evaluate(() => { const row = [...document.querySelectorAll(".carreau-scroll > .carreau-row")][0]; const r = row.getBoundingClientRect(); return `row ${Math.round(r.width)} | ` + [...row.children].filter((c) => c.dataset.id).map((c) => `${c.querySelector(".carreau-tab-short").textContent}=${Math.round(c.getBoundingClientRect().width)}`).join(" "); });
async function dragPane(title, target, fx) {
  const h = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${title}$`) }) }).last().locator(":scope > .carreau-body > .carreau-long").boundingBox();
  const t = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: new RegExp(`^${target}$`) }) }).last().boundingBox();
  await page.mouse.move(h.x + 20, h.y + 3); await page.mouse.down();
  await page.mouse.move(h.x + 30, h.y - 30, { steps: 5 });
  await page.mouse.move(t.x + t.width * fx, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
}
console.log("start:              ", await cells());
await dragPane("Right cell", "Left cell", 0.15);
console.log("Right → left of Left:", await cells());
await dragPane("Left cell", "Right cell", 0.15);
console.log("Left → left of Right:", await cells());
await browser.close();
