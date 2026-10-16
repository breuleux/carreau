// Prompt column: typing, Enter, Alt+Q out of the field, the secondary focus, W from the prompt.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
await page.waitForTimeout(300);
const cells = () => page.evaluate(() => [...document.querySelectorAll(".carreau-framed > .carreau-frame-inner > [data-id], .carreau-framed > [data-id]")].map((e) => (e.classList.contains("carreau-prompt") ? "⏎" : e.querySelector(".carreau-tab-short")?.textContent) + (e.classList.contains("secondary") ? "(2nd)" : "")).join(", "));
const state = () => page.evaluate(() => { const n = window.ws.node(window.ws.selection.id); const a = document.activeElement; return `selected: ${n.type === "prompt" ? "prompt" : n.tabs[n.active].title} | focus: ${a.className || a.tagName} | nav: ${window.nav.mode}`; });
const geo = () => page.evaluate(() => { const c = document.querySelector(".carreau-framed").getBoundingClientRect(); const p = document.querySelector(".carreau-prompt").getBoundingClientRect(); return `prompt bottom ${Math.round(c.bottom - p.bottom)}px from the column's bottom`; });
console.log("start:", await cells(), "|", await geo());
await page.locator(".carreau-prompt-input").click();
console.log("clicked the field:", await state());
await page.keyboard.type("$ whoami"); await page.keyboard.press("Enter");
await page.keyboard.type("why is the sky blue"); await page.keyboard.press("Enter");
await page.waitForTimeout(100);
console.log("typed two:", await cells(), "|", await state());
// Alt+Q from the field: navigation mode, the field let go, the secondary focus shows
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
await page.waitForTimeout(100);
console.log("Alt+Q, Q:", await state(), "|", await cells());
await page.screenshot({ path: "/tmp/prompt-nav.png" });
await page.keyboard.press("KeyW");
await page.waitForTimeout(150);
console.log("W, closing:", await cells(), "| spinner on the cell:", await page.locator(".carreau-framed .carreau-long .carreau-closing").count());
await page.waitForTimeout(1300);
console.log("W (closes the secondary):", await cells(), "|", await state());
await page.keyboard.press("ArrowUp");
console.log("↑:", await state(), "|", await cells());
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
console.log("↓, Esc:", await state());
await page.keyboard.type("x");
console.log("typed x: field =", JSON.stringify(await page.locator(".carreau-prompt-input").inputValue()));
// many cells: the prompt stays visible at the bottom, the column at its end
for (let i = 0; i < 8; i++) { await page.keyboard.press("Backspace"); await page.keyboard.type(`$ date`); await page.keyboard.press("Enter"); }
await page.waitForTimeout(200);
console.log("after 8 more:", await geo(), "| scroll:", await page.evaluate(() => { const c = document.querySelector(".carreau-framed > .carreau-frame-inner"); return `${Math.round(c.scrollTop)}/${c.scrollHeight - c.clientHeight}`; }));
await page.screenshot({ path: "/tmp/prompt-full.png" });
await browser.close();
