import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Embeds");
await page.waitForTimeout(800);
const counterTab = await page.evaluate(() => window.ws.root.children[0].children[1].tabs[0].id);
const counter = page.frameLocator(`.carreau-content[data-tab="${counterTab}"] iframe`);
await page.locator(".carreau-tab", { hasText: /^Counter A$/ }).click();
for (let i = 0; i < 4; i++) await counter.locator("#b").click();
const state = async (label) => console.log(label.padEnd(28), "clicks", await counter.locator("#n").textContent(),
  "| floats", await page.evaluate(() => window.ws.floating.length), "| in tree", await page.evaluate((id) => !!JSON.stringify(window.ws.root).includes(id), counterTab),
  "| maximized", await page.evaluate(() => window.ws.maximized?.id ?? "-"));
// double click a tab => maximize, again => restore
const bbb = page.locator(".carreau-tab", { hasText: /^Big Buck Bunny$/ });
await bbb.dblclick(); await state("dblclick tab");
await bbb.dblclick(); await state("dblclick again");
// click grip of the Counter pane => menu => Float
const grip = page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Counter A$/ }) }).locator(".carreau-more");
await grip.click();
console.log("menu items:", await page.locator(".carreau-menu button").allTextContents());
await page.locator(".carreau-menu button", { hasText: "Float" }).click();
await state("after Float");
await page.screenshot({ path: "/tmp/float1.png" });
// move the float quickly (no hold) => stays floating
const fgrip = page.locator(".carreau-float-bar");
let g = await fgrip.boundingBox();
await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
await page.mouse.move(g.x + 205, g.y + 105, { steps: 10 });
await page.mouse.up();
await state("quick move");
console.log("float rect:", JSON.stringify(await page.evaluate(() => window.ws.floating[0].rect)));
// drag over the left edge of the video pane, hold 1.2s => docking => drop on the left third
g = await fgrip.boundingBox();
const vid = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Big Buck Bunny$/ }) }).boundingBox();
await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
await page.mouse.move(vid.x + vid.width * 0.15, vid.y + vid.height / 2, { steps: 10 });
await page.waitForTimeout(500);
console.log("after 0.5s: docking?", await page.evaluate(() => !!window.view.drag), "ring?", await page.locator(".carreau-hold").count());
await page.waitForTimeout(700);
console.log("after 1.2s: docking?", await page.evaluate(() => !!window.view.drag), "active", await page.evaluate(() => window.view.drag?.active?.target.kind + ":" + window.view.drag?.active?.target.side));
await page.screenshot({ path: "/tmp/float2.png" });
await page.mouse.up();
await state("after dock");
console.log("layout:", await page.evaluate(() => JSON.stringify(window.ws.root, (k, v) => (k === "tabs" ? v.map((t) => t.title) : ["id", "weight", "active", "data", "content"].includes(k) ? undefined : v))));
await browser.close();
