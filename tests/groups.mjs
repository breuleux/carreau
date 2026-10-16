import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Embeds");
await page.waitForTimeout(800);
const show = () => page.evaluate(() => { const f = (n) => (n.type === "pane" ? n.tabs.map((t, i) => (i === n.active ? "*" : "") + (t.group ? `${t.title}{${f(t.group.children[0])}}` : t.title)).join("+") : `${n.type}(${n.children.map(f).join(", ")})`); return f(window.ws.root); });
const counterTab = await page.evaluate(() => window.ws.root.children[0].children[1].tabs[0].id);
const counter = page.frameLocator(`.carreau-content[data-tab="${counterTab}"] iframe`);
await page.locator(".carreau-tab", { hasText: /^Counter A$/ }).click();
for (let i = 0; i < 2; i++) await counter.locator("#b").click();
await page.locator(".carreau-tab", { hasText: /^Counter A$/ }).click(); // focus back to the page
// select the left column (P from Counter A) and group it with G
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyP"); await page.keyboard.press("KeyG"); await page.keyboard.up("Alt");
console.log("editing:", await page.locator(".carreau-tab-edit").count(), "default:", await page.locator(".carreau-tab-edit").inputValue());
await page.screenshot({ path: "/tmp/g-prompt.png" });
await page.keyboard.type("media");
await page.keyboard.press("Enter");
console.log("grouped:   ", await show());
await page.screenshot({ path: "/tmp/g-grouped.png" });
// drag the "About" tab into the group's tab bar
const about = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab-short", { hasText: /^About$/ }) }).last().locator(":scope > .carreau-body > .carreau-long").boundingBox();
const gtab = await page.locator(".carreau-tab.is-group", { has: page.locator(".carreau-tab-short", { hasText: /^media$/ }) }).boundingBox();
await page.mouse.move(about.x + 20, about.y + 3); await page.mouse.down();
await page.mouse.move(about.x - 50, about.y - 50, { steps: 5 });
await page.mouse.move(gtab.x + gtab.width + 8, gtab.y + gtab.height / 2, { steps: 8 });
await page.mouse.up();
console.log("tab added: ", await show());
// About is now active in the holder; switch back to the group tab
await page.locator(".carreau-tab.is-group", { has: page.locator(".carreau-tab-short", { hasText: /^media$/ }) }).click();
console.log("group tab: ", await show(), "| counter clicks:", await counter.locator("#n").textContent());
// a drop inside the group: drag Counter B (scroll column) onto the left third of the video
const cb = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Counter B$/ }) }).last().locator(":scope > .carreau-body > .carreau-long").boundingBox();
const vid = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Big Buck Bunny$/ }) }).last().boundingBox();
await page.mouse.move(cb.x + 20, cb.y + 3); await page.mouse.down();
await page.mouse.move(cb.x - 40, cb.y - 40, { steps: 5 });
await page.mouse.move(vid.x + vid.width * 0.12, vid.y + vid.height / 2, { steps: 8 });
console.log("over video's left third:", await page.evaluate(() => window.view.drag?.active?.target.kind));
await page.mouse.up();
console.log("dropped in:", await show());
await page.screenshot({ path: "/tmp/g-inside.png" });
// close About (holder back to a single group tab), then collapse via the ⋯ menu
await page.locator(".carreau-tab", { hasText: /^About$/ }).locator(".carreau-tab-close").click();
const holder = page.locator(".carreau-pane", { has: page.locator(":scope > .carreau-tabbar .carreau-tab.is-group") }).first();
await holder.locator(":scope > .carreau-tabbar .carreau-more").click();
console.log("menu:", (await page.locator(".carreau-menu button").allTextContents()).join(", "));
await page.locator(".carreau-menu button", { hasText: "Collapse" }).click();
console.log("collapsed: ", await show(), "| counter clicks:", await counter.locator("#n").textContent());
await browser.close();
