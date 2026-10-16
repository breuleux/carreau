import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=IDE");
const widths = () => page.evaluate(() => [...document.querySelectorAll(".carreau-root > .carreau-split > [data-id]")].map((e) => Math.round(e.getBoundingClientRect().width)).join(","));
const splitters = page.locator(".carreau-root > .carreau-split > .carreau-splitter");
async function dragSplitter(i, dx) {
  const b = await splitters.nth(i).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 300); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + 300, { steps: 6 }); await page.mouse.up();
}
const w0 = await widths();
console.log("start:              ", w0);
await dragSplitter(0, 40); await dragSplitter(0, 40); await dragSplitter(0, -20);
console.log("splitter 1 x3:      ", await widths());
await dragSplitter(1, -60);
console.log("splitter 2:         ", await widths());
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
await page.keyboard.press("ArrowRight"); // navigation: not a step
await page.keyboard.press("KeyZ");
console.log("Z (undo splitter 2):", await widths());
await page.keyboard.press("KeyZ");
console.log("Z (undo splitter 1):", await widths(), (await widths()) === w0 ? "= start" : "");
await page.keyboard.press("Shift+KeyZ");
console.log("Shift+Z:            ", await widths());
await browser.close();
