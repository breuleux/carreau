// A custom prompt editor (the "Custom prompt" example): focus, multi-line, submitting, persistence.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Custom prompt"));
await page.waitForTimeout(200);
const focus = () => page.evaluate(() => document.activeElement.className);
const cells = () => page.evaluate(() => [...document.querySelectorAll(".carreau-frame-inner > .carreau-pane .carreau-long")].map((l) => l.textContent));
console.log("header:", await page.locator(".demo-prompt-header").textContent());
await page.locator(".carreau-tab", { hasText: "Notes" }).click();
await page.locator(".carreau-tab", { hasText: "Chat" }).click();
console.log("clicked Chat's tab: focus on", await focus(), "|", await page.locator("#status").textContent());
await page.keyboard.type("first line");
await page.keyboard.press("Shift+Enter");
await page.keyboard.type("second line");
console.log("Shift+Enter: value", JSON.stringify(await page.locator(".demo-prompt-area").inputValue()), "| height", Math.round((await page.locator(".demo-prompt-area").boundingBox()).height));
// A re-render (selecting the notes, then back with Alt+Q, →, release): the text stays.
await page.locator(".carreau-tab", { hasText: "Notes" }).click();
console.log("after a re-render, value:", JSON.stringify(await page.locator(".demo-prompt-area").inputValue()));
await page.locator(".demo-prompt-area").click();
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
await page.waitForTimeout(100);
console.log("Alt+Q from it, released: focus back on", await focus());
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
console.log("Enter: cells", JSON.stringify(await cells()), "| field", JSON.stringify(await page.locator(".demo-prompt-area").inputValue()), "| focus", await focus());
await page.screenshot({ path: "/tmp/prompteditor.png" });
await browser.close();
