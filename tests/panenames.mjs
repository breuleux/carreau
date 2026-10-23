// Naming panes (⋯ menu, Alt+Q N), the name left of the tabs, "Send to" (⋯ menu, tab right click).
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const bars = () => page.evaluate(() => [...document.querySelectorAll(".carreau-tabbar:not([hidden])")].map((b) => (b.querySelector(".carreau-pane-name")?.textContent ? `[${b.querySelector(".carreau-pane-name").textContent}] ` : "") + [...b.querySelectorAll(".carreau-tab-short")].map((t) => t.textContent).join(" ")).join(" | "));
const tab = (name) => page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: new RegExp(`^${name}$`) }) });
const paneOf = (name) => page.locator(".carreau-pane", { has: tab(name) });
await page.goto("http://localhost:5317/?example=IDE");
await page.waitForTimeout(200);
// ⋯ → Name pane… → type, Enter.
await paneOf("Terminal").locator(".carreau-more").click();
console.log("⋯ menu:", (await page.locator(".carreau-menu > button, .carreau-menu > .carreau-menu-sub > .carreau-menu-subtitle").allTextContents()).join(" · "));
await page.locator(".carreau-menu button", { hasText: "Name pane…" }).click();
await page.keyboard.type("left");
console.log("typed a reserved name: invalid", await page.locator(".carreau-pane-name-edit").evaluate((i) => i.classList.contains("invalid")));
await page.keyboard.press("Enter");
console.log("Enter on it: still editing", await page.locator(".carreau-pane-name-edit").count() === 1);
await page.locator(".carreau-pane-name-edit").fill("logs"); await page.keyboard.press("Enter");
await page.waitForTimeout(100);
console.log("named:", await bars());
// Alt+Q N on the editor pane: "main".
await tab("main.ts").click();
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyN"); await page.keyboard.up("Alt");
await page.waitForTimeout(100);
await page.keyboard.type("code"); await page.keyboard.press("Enter");
await page.waitForTimeout(100);
console.log("Alt+Q N:", await bars());
await page.screenshot({ path: "/tmp/names-bars.png", clip: { x: 0, y: 380, width: 1000, height: 420 } });
// Right click a tab: its menu; Send to → logs.
await tab("model.ts").click({ button: "right" });
console.log("tab menu:", (await page.locator(".carreau-menu > button, .carreau-menu > .carreau-menu-sub > .carreau-menu-subtitle").allTextContents()).join(" · "));
await page.locator(".carreau-menu-subtitle").hover();
await page.waitForTimeout(100);
console.log("send to:", (await page.locator(".carreau-submenu button").evaluateAll((bs) => bs.map((b) => b.textContent + (b.disabled ? "(off)" : "")))).join(" "));
await page.screenshot({ path: "/tmp/names-menu.png" });
await page.locator(".carreau-submenu button", { hasText: "logs" }).click();
await page.waitForTimeout(100);
console.log("model.ts sent to logs:", await bars());
// ⋯ of "Outline" → Send to → ← (the whole pane, into the neighbour on the left).
await paneOf("Outline").locator(".carreau-more").click();
await page.locator(".carreau-menu-subtitle").hover();
await page.locator(".carreau-submenu button", { hasText: "←" }).click();
await page.waitForTimeout(100);
console.log("Outline's pane sent ←:", await bars());
await page.evaluate(() => window.ws.undo());
await page.waitForTimeout(100);
console.log("undo:", await bars());
// Remove a name.
await paneOf("Terminal").locator(".carreau-more").click();
await page.locator(".carreau-menu button", { hasText: "Remove name" }).click();
await page.waitForTimeout(100);
console.log("name removed:", await bars());
await browser.close();
