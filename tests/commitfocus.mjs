// commitFocus: leaving navigation mode focuses the cell's inside; Alt+Q gets back out of an iframe.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Embeds");
await page.waitForTimeout(800);
const state = () => page.evaluate(() => {
  const n = window.ws.node(window.ws.selection.id);
  const a = document.activeElement;
  const inFrame = a instanceof HTMLIFrameElement ? `iframe > ${a.contentDocument?.activeElement?.tagName ?? "?"}` : a?.tagName;
  return `selected: ${n.tabs[n.active].title} | focus: ${inFrame} | nav: ${window.nav.mode}`;
});
const counterA = page.frameLocator("iframe").nth(2); // Big Buck Bunny, Me at the zoo, Counter A
// select Counter A, then a round of sticky navigation mode
await page.evaluate(() => { const p = window.ws.trees().flatMap(function all(n) { return n.type === "pane" ? [n] : n.children.flatMap(all); }).find((p) => p.tabs.some((t) => t.title === "Counter A")); window.ws.activateTab(p.id, 0); });
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
console.log("sticky nav mode:        ", await state());
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
console.log("left it (Esc):          ", await state());
await page.keyboard.type("hello");
console.log("typed: input =", JSON.stringify(await counterA.locator("input").inputValue()));
// Alt+Q from inside the iframe: navigation mode, focus back in the host
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ");
console.log("Alt+Q inside the iframe:", await state());
await page.keyboard.press("ArrowRight");
console.log("→ (Alt held):           ", await state());
await page.keyboard.up("Alt");
await page.waitForTimeout(100);
console.log("released Alt:           ", await state());
console.log("input still =", JSON.stringify(await counterA.locator("input").inputValue()), "(no q typed into it)");
// back to Counter A: held mode, ←, release: its input gets the focus again
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("ArrowLeft"); await page.keyboard.up("Alt");
await page.waitForTimeout(100);
console.log("back with ←, released:  ", await state());
await page.keyboard.type("!");
console.log("typed: input =", JSON.stringify(await counterA.locator("input").inputValue()));
await browser.close();
