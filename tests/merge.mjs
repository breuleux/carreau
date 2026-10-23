// Merging tabs by dragging: plots (a link icon over the target tab), then prompts.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const tabs = () => page.evaluate(() => [...document.querySelectorAll(".carreau-tabbar .carreau-tabs")].map((s) => [...s.children].map((c) => (c.classList.contains("carreau-tab-link") ? "🔗" : c.querySelector(".carreau-tab-short").textContent)).join(" ")).join(" | "));
async function drag(fromText, toText, { hold } = {}) {
  const a = await page.locator(".carreau-tab", { hasText: fromText }).first().boundingBox();
  const b = await page.locator(".carreau-tab", { hasText: toText }).first().boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 20, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  const zone = await page.evaluate(() => ({ links: document.querySelectorAll(".carreau-link").length, active: document.querySelectorAll(".carreau-link.active").length }));
  if (hold) await page.screenshot({ path: hold });
  await page.mouse.up();
  return zone;
}

await page.goto("http://localhost:5317/?example=Plots");
await page.waitForTimeout(200);
console.log("plots:", await tabs());
console.log("dragging Cosine over Sine: link icons", JSON.stringify(await drag("Cosine", "Sine", { hold: "/tmp/merge-drag.png" })));
console.log("merged:", await tabs());
console.log("legend:", await page.locator(".carreau-content:not([hidden]) .legend").allTextContents());
await page.locator(".carreau-tab", { hasText: "Cosine" }).click();
console.log("Cosine clicked, legend (bold = active):", await page.locator(".carreau-content:not([hidden]) .legend b").allTextContents());
await page.screenshot({ path: "/tmp/merge-plots.png" });

await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Merging prompts"));
await page.waitForTimeout(200);
const cells = () => page.evaluate(() => [...document.querySelectorAll(".carreau-group:not([hidden]) > .carreau-framed")].map((f) => [...f.querySelectorAll(":scope > .carreau-frame-inner > .carreau-pane")].map((p) => p.querySelector(".carreau-tab-short")?.textContent).join(",")).join(" | "));
console.log("prompts:", await tabs(), "| cells:", await cells());
console.log("dragging Bob over Ann:", JSON.stringify(await drag("Bob", "Ann")));
console.log("merged:", await tabs(), "| cells:", await cells(), "| placeholder:", await page.locator(".carreau-group:not([hidden]) .carreau-prompt-input").getAttribute("placeholder"));
await page.locator(".carreau-group:not([hidden]) .carreau-prompt-input").click();
await page.keyboard.type("hello from bob"); await page.keyboard.press("Enter"); await page.waitForTimeout(100);
console.log("typed:", await cells());
await page.screenshot({ path: "/tmp/merge-prompts.png" });
// Closing Bob (its ×): his cells stay, now Ann's; the pair is gone.
await page.locator(".carreau-tab", { hasText: "Bob" }).locator(".carreau-tab-close").click();
await page.waitForTimeout(150);
console.log("Bob closed:", await tabs(), "| cells:", await cells());
await browser.close();
