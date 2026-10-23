// A host command bound in navigation mode (demo: Alt+Q, D duplicates the focused tab).
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const tabs = () => page.evaluate(() => [...document.querySelectorAll(".carreau-tabbar .carreau-tabs")].map((s) => [...s.querySelectorAll(".carreau-tab-short")].map((t) => t.textContent).join(" ")).join(" | "));
const altQ = async (...keys) => { await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); for (const k of keys) await page.keyboard.press(k); await page.keyboard.up("Alt"); await page.waitForTimeout(100); };
await page.goto("http://localhost:5317/?example=IDE");
await page.waitForTimeout(200);
console.log("legend:", await page.locator("#keys").evaluate((k) => [...k.querySelectorAll("*")].map((e) => e.textContent).find((t) => t.includes("duplicateTab")) ? "has duplicateTab" : "missing"));
await page.locator(".carreau-tab", { hasText: /^Terminal$/ }).click();
console.log("before:", await tabs());
await altQ("KeyD");
console.log("Alt+Q, D on Terminal:", await tabs());
await altQ("KeyZ");
console.log("undo:", await tabs());
// From a prompt: the cell above is duplicated (the operand), the focus stays on the prompt.
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
await page.waitForTimeout(200);
await page.locator(".carreau-prompt-input").click();
await altQ("KeyD");
console.log("Alt+Q, D from the prompt:", await page.locator("#status").textContent(), "|", await page.evaluate(() => [...document.querySelectorAll(".carreau-frame-inner > .carreau-pane")].map((p) => p.querySelectorAll(".carreau-tab").length + " tab(s)").join(", ")));
await browser.close();
