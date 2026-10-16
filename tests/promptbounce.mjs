import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
await page.waitForSelector(".carreau-prompt-input");
const input = page.locator(".carreau-prompt-input");
// add cells so it overflows
for (let i = 0; i < 12; i++) { await input.click(); await input.fill("$ ls " + i); await input.press("Enter"); }
const info = () => page.evaluate(() => {
  const p = document.querySelector(".carreau-prompt");
  const sc = document.querySelector(".carreau-frame-inner");
  const r = p.getBoundingClientRect();
  return { inScroller: sc.contains(p), promptTop: Math.round(r.top), scrollTop: Math.round(sc.scrollTop), max: sc.scrollHeight - sc.clientHeight, cells: sc.querySelectorAll(":scope > .carreau-pane").length };
});
console.log("after submits", await info());
const sc = page.locator(".carreau-frame-inner");
await sc.hover();
await page.mouse.wheel(0, -5000);
await page.waitForTimeout(300);
console.log("scrolled up", await info());
// selection / navigation: focus is on prompt; check selected class
console.log("prompt selected", await page.locator(".carreau-prompt.selected").count());
await page.screenshot({ path: "/tmp/carreau-check/prompt.png" });
// submit while scrolled up: does it stick to the end?
await input.fill("hello"); await input.press("Enter"); await page.waitForTimeout(200);
console.log("after submit while up", await info());
await browser.close();
