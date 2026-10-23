// Shortcuts: keys that work without navigation mode (demo: Ctrl+Tab, Cmd+←/→ switch tabs),
// but not while typing in a text field.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const active = () => page.evaluate(() => { const n = window.ws.node(window.ws.selection.id); return n?.type === "pane" ? n.tabs[n.active].title : n?.type; });
await page.goto("http://localhost:5317/?example=IDE");
await page.waitForTimeout(200);
await page.locator(".carreau-tab", { hasText: /^main\.ts$/ }).click();
console.log("start:", await active());
await page.keyboard.press("Meta+ArrowRight"); console.log("Cmd+→:", await active());
await page.keyboard.press("Meta+ArrowRight"); console.log("Cmd+→:", await active());
await page.keyboard.press("Meta+ArrowLeft"); console.log("Cmd+←:", await active());
await page.keyboard.press("Control+Tab"); console.log("Ctrl+Tab:", await active());
await page.keyboard.press("Control+Shift+Tab"); console.log("Ctrl+Shift+Tab:", await active());
console.log("nav mode still works: Alt+Q, →:", await (async () => { await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("ArrowRight"); await page.keyboard.up("Alt"); return active(); })());
// In a text field (the prompt's): Cmd+← is the field's (the caret), not a tab switch.
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
await page.waitForTimeout(200);
await page.locator(".carreau-prompt-input").click();
await page.keyboard.type("hello");
const before = await page.locator("#status").textContent();
await page.keyboard.press("Meta+ArrowLeft");
console.log("Cmd+← in the prompt's field: selection unchanged:", (await page.locator("#status").textContent()) === before, "| caret at", await page.locator(".carreau-prompt-input").evaluate((f) => f.selectionStart));
await browser.close();
