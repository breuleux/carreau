import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Embeds");
console.log("moveBefore:", await page.evaluate(() => typeof Element.prototype.moveBefore));
await page.locator(".carreau-tab", { hasText: /^Counter A$/ }).click();
const frameOf = () => page.frameLocator('.carreau-content:not([hidden]) iframe[srcdoc]').first();
const counterA = page.frameLocator(`.carreau-content[data-tab="${await page.evaluate(() => window.ws.root.children[0].children[1].tabs[0].id)}"] iframe`);
for (let i = 0; i < 3; i++) await counterA.locator("#b").click();
await counterA.locator("input").fill("hello");
await page.waitForTimeout(1500);
const read = async (label) => console.log(label.padEnd(34), "clicks", await counterA.locator("#n").textContent(), "| input", await counterA.locator("input").inputValue(), "| age", await counterA.locator("#age").textContent(), "| selection", await page.evaluate(() => window.ws.node(window.ws.selection.id).tabs[window.ws.node(window.ws.selection.id).active].title));
await read("initial");
// switch tab and back
await page.locator(".carreau-tab", { hasText: /^Notes$/ }).click();
await page.locator(".carreau-tab", { hasText: /^Counter A$/ }).click();
await read("after tab switch");
// drag Counter A tab to the video pane's tab bar (end)
async function dragTo(tab, x, y) {
  const t = await page.locator(".carreau-tab", { hasText: new RegExp(`^${tab}$`) }).boundingBox();
  await page.mouse.move(t.x + 5, t.y + 5); await page.mouse.down();
  await page.mouse.move(t.x + 40, t.y - 30, { steps: 5 });
  await page.mouse.move(x, y, { steps: 10 });
  const a = await page.evaluate(() => window.view.drag?.active?.target.kind ?? "none");
  await page.mouse.up();
  return a;
}
const zoo = await page.locator(".carreau-tab", { hasText: /^Me at the zoo$/ }).first().boundingBox();
console.log("drop:", await dragTo("Counter A", zoo.x + zoo.width + 3, zoo.y + zoo.height / 2));
await read("after move into video pane");
// drag it to the left edge of the workspace (new pane), crossing over the video iframe
const host = await page.locator(".carreau-root").boundingBox();
console.log("drop:", await dragTo("Counter A", host.x + 3, host.y + host.height / 2));
await read("after move to new pane");
await page.keyboard.press("Alt+KeyM");
await read("after maximize");
await page.keyboard.press("Alt+KeyB");
// click inside the iframe of Counter B => selects its pane
const cb = page.frameLocator(".carreau-scroll iframe[srcdoc]");
await cb.locator("#b").click();
await page.waitForTimeout(100);
console.log("clicked in Counter B iframe -> selected:", await page.evaluate(() => window.ws.node(window.ws.selection.id).tabs[0].title));
await page.screenshot({ path: "/tmp/embeds.png" });
await browser.close();
