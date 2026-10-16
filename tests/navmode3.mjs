import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Grid%203%C3%973");
const st = () => page.evaluate(() => {
  const n = window.ws.node(window.ws.selection.id);
  const sel = n?.type === "pane" ? n.tabs[0].title : n?.type + (window.ws.selection.range ? `[${window.ws.selection.range}]` : "");
  const grid = window.ws.root.children.map((c) => c.children.map((p) => p.tabs[0].title).join(" ")).join(" | ");
  return `${document.querySelector("#status").textContent.match(/^\[[^\]]*\]/)?.[0] ?? "[off]"} sel=${sel}  grid: ${grid}`;
});
await page.locator(".carreau-tab", { hasText: /^B2$/ }).click();
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
console.log("sticky:              ", await st());
// one-shot prefix: S then →
await page.keyboard.press("KeyS");
console.log("S pressed:           ", await st());
await page.keyboard.press("ArrowRight");
console.log("then → (swap):       ", await st());
await page.keyboard.press("ArrowRight");
console.log("then → (plain move): ", await st());
// held prefix: hold S, ↓ ↓
await page.keyboard.down("KeyS");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowUp");
await page.keyboard.press("ArrowUp");
await page.keyboard.up("KeyS");
console.log("hold S, ↓ ↑ ↑:       ", await st());
await page.keyboard.press("ArrowDown");
console.log("then ↓ (plain move): ", await st());
// S then a non-direction key cancels
await page.keyboard.press("KeyS"); await page.keyboard.press("KeyU");
console.log("S then U (cancel):   ", await st());
// multi-selection doesn't stick
await page.keyboard.press("Shift+ArrowLeft");
await page.keyboard.press("Shift+ArrowUp");
console.log("Shift+← Shift+↑:     ", await st());
await page.keyboard.press("ArrowRight");
console.log("→ from multi:        ", await st());
await page.keyboard.press("KeyP");
console.log("P (parent):          ", await st());
await page.keyboard.press("ArrowUp");
console.log("↑ from parent:       ", await st());
// held mode also: Alt held, S, ←
await page.keyboard.press("KeyQ");
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ");
await page.keyboard.press("KeyS"); await page.keyboard.press("ArrowLeft");
await page.keyboard.up("Alt");
console.log("Alt+Q S ← (held):    ", await st());
await browser.close();
