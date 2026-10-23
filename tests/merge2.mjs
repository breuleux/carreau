// Leaving a complex within its pane (the plain dot by it), clicking a prompt-column's tab
// (focus into the prompt), and the holders' tabs highlighted when the focus is inside a group.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const tabs = () => page.evaluate(() => [...document.querySelectorAll(".carreau-tabbar .carreau-tabs")].map((s) => [...s.children].map((c) => (c.classList.contains("carreau-tab-link") ? "🔗" : c.querySelector(".carreau-tab-short").textContent)).join(" ")).join(" | "));
const box = (text) => page.locator(".carreau-tab", { hasText: text }).first().boundingBox();
async function dragTo(fromText, x, y, shot) {
  const a = await box(fromText);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 15, a.y + a.height / 2 - 15, { steps: 4 });
  await page.mouse.move(x, y, { steps: 8 });
  const dots = await page.evaluate(() => ({ plain: document.querySelectorAll(".carreau-dot:not(.join)").length, join: document.querySelectorAll(".carreau-dot.join").length, active: document.querySelector(".carreau-dot.active")?.classList.contains("join") ? "join" : document.querySelector(".carreau-dot.active") ? "plain" : "none" }));
  if (shot) await page.screenshot({ path: shot, clip: { x: Math.max(0, a.x - 120), y: a.y - 20, width: 360, height: a.height + 40 } });
  await page.mouse.up();
  return dots;
}

await page.goto("http://localhost:5317/?example=Plots");
await page.waitForTimeout(200);
// Merge Cosine onto Sine (the link icon over Sine's middle).
const s = await box("Sine");
await dragTo("Cosine", s.x + s.width / 2, s.y + s.height / 2);
console.log("merged:", await tabs());
// Cosine (last member) by the right end of the complex: the plain dot, just past it.
let c = await box("Cosine");
console.log("dots by the complex's end:", JSON.stringify(await dragTo("Cosine", c.x + c.width + 2, c.y + c.height / 2, "/tmp/merge2-dots.png")));
console.log("Cosine out, same pane:", await tabs());
// Back in, then to the front of the complex: the join dot just inside its start.
const s2 = await box("Sine");
await dragTo("Cosine", s2.x + s2.width / 2, s2.y + s2.height / 2);
const s3 = await box("Sine");
console.log("dots by the complex's start:", JSON.stringify(await dragTo("Cosine", s3.x + 7, s3.y + s3.height / 2)));
console.log("Cosine first, still merged:", await tabs());

await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
await page.waitForTimeout(200);
await page.locator(".carreau-tab", { hasText: "Notes" }).click();
await page.locator(".carreau-tab", { hasText: "Prompt" }).click();
await page.waitForTimeout(100);
console.log("clicked the Prompt tab:", await page.locator("#status").textContent(), "| focus:", await page.evaluate(() => document.activeElement.className));
// The focus inside the group: its holder's tab is highlighted.
await page.locator(".carreau-long", { hasText: "make test" }).click();
await page.waitForTimeout(100);
console.log("a cell selected:", await page.locator("#status").textContent(), "| holder highlighted:", await page.locator(".carreau-pane.focus-path").count());
await page.screenshot({ path: "/tmp/merge2-path.png", clip: { x: 0, y: 700, width: 1000, height: 100 } });
await browser.close();
