import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=IDE");
const show = () => page.evaluate(() => { const f = (n) => (n.type === "pane" ? n.tabs.map((t) => (t.group ? `${t.title}{${f(t.group.children[0])}}` : t.title)).join("+") : `${n.type}(${n.children.map(f).join(", ")})`); return f(window.ws.root); });
await page.locator(".carreau-tab", { hasText: /^Terminal$/ }).click();
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
await page.keyboard.press("Shift+ArrowRight"); // range: editor column + Outline
await page.keyboard.press("KeyG");
const name = await page.locator(".carreau-tab-edit").inputValue();
await page.keyboard.press("Enter");
console.log(`G, Enter (default "${name}"):`, await show());
await page.keyboard.press("Shift+KeyG");
console.log("Shift+G:", await show());
await page.keyboard.press("KeyZ");
console.log("Z:      ", await show());
await browser.close();
