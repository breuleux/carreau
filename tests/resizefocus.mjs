// Alt+Q, ] / [: the focus wider / narrower; with Shift: taller / shorter.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const size = async (loc) => { const b = await loc.boundingBox(); return `${Math.round(b.width)}×${Math.round(b.height)}`; };
const altQ = async (...keys) => { await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); for (const k of keys) await page.keyboard.press(k); await page.keyboard.up("Alt"); await page.waitForTimeout(100); };
await page.goto("http://localhost:5317/?example=IDE");
await page.waitForTimeout(200);
await page.locator(".carreau-tab", { hasText: /^Terminal$/ }).click();
const term = page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Terminal$/ }) });
console.log("Terminal:", await size(term));
await altQ("BracketRight"); console.log("] (wider):", await size(term));
await altQ("BracketLeft", "BracketLeft"); console.log("[ [ (narrower):", await size(term));
await altQ("Shift+BracketRight"); console.log("Shift+] (taller):", await size(term));
await altQ("KeyZ"); console.log("undo:", await size(term));
// A Notebook cell: taller is its height.
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
await page.locator(".carreau-long", { hasText: "make test" }).click();
const cell = page.locator(".carreau-scrollcell", { has: page.locator(".carreau-long", { hasText: "make test" }) });
console.log("cell:", await size(cell));
await altQ("Shift+BracketRight", "Shift+BracketRight"); console.log("Shift+] twice:", await size(cell));
await altQ("Shift+BracketLeft"); console.log("Shift+[:", await size(cell));
await browser.close();
