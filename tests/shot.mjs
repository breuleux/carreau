import { chromium } from "playwright";
const out = process.argv[2] ?? "/tmp/carreau";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
const base = "http://localhost:5317/";

await page.goto(base + "?example=Deep%20nesting");
await page.screenshot({ path: `${out}-deep.png` });
// drag tab E over pane A, near its left edge
const tabE = page.locator(".carreau-tab", { hasText: /^E$/ });
const paneA = page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^A$/ }) });
const eb = await tabE.boundingBox();
const ab = await paneA.boundingBox();
await page.mouse.move(eb.x + 5, eb.y + 5);
await page.mouse.down();
await page.mouse.move(eb.x + 40, eb.y + 40, { steps: 5 });
await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2, { steps: 5 });
await page.mouse.move(ab.x + 25, ab.y + ab.height / 2, { steps: 5 });
await page.screenshot({ path: `${out}-drag-left.png` });
await page.mouse.move(ab.x + ab.width / 2, ab.y + 32, { steps: 5 });
await page.screenshot({ path: `${out}-drag-top.png` });
await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height - 10, { steps: 5 });
await page.screenshot({ path: `${out}-drag-bottom.png` });
await page.mouse.move(ab.x + 6, ab.y + ab.height / 2, { steps: 3 });
await page.screenshot({ path: `${out}-drag-outer.png` });
await page.mouse.up();
await page.screenshot({ path: `${out}-dropped.png` });

for (const ex of ["IDE", "Grid 3×3", "Uneven", "Spiral"]) {
  await page.goto(base + "?example=" + encodeURIComponent(ex));
  await page.screenshot({ path: `${out}-${ex.replace(/\W/g, "")}.png` });
}
// navigation & maximize on IDE
await page.goto(base + "?example=IDE");
await page.keyboard.press("Alt+ArrowRight");
await page.keyboard.press("Alt+ArrowDown");
await page.keyboard.press("Alt+Shift+ArrowRight");
await page.screenshot({ path: `${out}-nav-expand.png` });
await page.keyboard.press("Alt+KeyM");
await page.screenshot({ path: `${out}-nav-max.png` });
await page.keyboard.press("Alt+KeyP");
await page.screenshot({ path: `${out}-nav-max-parent.png` });
await page.keyboard.press("Alt+KeyB");
await page.screenshot({ path: `${out}-nav-restored.png` });
console.log(await page.locator("#status").textContent());
await browser.close();
