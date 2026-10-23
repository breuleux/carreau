// Scroll splits' fading edges, and their cells' accent bar (resizing) and close button.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const fades = () => page.evaluate(() => [...document.querySelectorAll(".carreau-scroll")].map((s) => `${s.classList.contains("fade-start") ? "▲" : "·"}${s.classList.contains("fade-end") ? "▼" : "·"}`).join(" "));
for (const ex of ["Notebook", "Prompt column", "Scroll row"]) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(ex));
  await page.waitForTimeout(400);
  console.log(`${ex}: fades ${await fades()} | cells with a bar: ${await page.locator(".carreau-scrollcell").count()}, close buttons: ${await page.locator(".carreau-cell-close").count()}`);
  await page.screenshot({ path: `/tmp/sc-${ex.replace(/ /g, "")}.png` });
}
// Prompt column: add cells so it scrolls, then scroll up.
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
const input = page.locator(".carreau-prompt-input");
for (let i = 0; i < 6; i++) { await input.click(); await input.fill("$ ls " + i); await input.press("Enter"); }
await page.waitForTimeout(300);
console.log("prompt column, at its end:", await fades());
await page.locator(".carreau-frame-inner").hover();
await page.mouse.wheel(0, -300);
await page.waitForTimeout(400);
console.log("scrolled up a bit:", await fades());
await page.screenshot({ path: "/tmp/sc-fade.png" });
// Resize a cell by its bar: the bottom half, dragged down 80px.
const cell = page.locator(".carreau-scrollcell").first();
const h0 = (await cell.boundingBox()).height;
const g = await cell.locator(".carreau-gutter").boundingBox();
await page.mouse.move(g.x + g.width / 2, g.y + g.height * 0.8);
await page.mouse.down();
await page.mouse.move(g.x + g.width / 2, g.y + g.height * 0.8 + 80, { steps: 6 });
await page.mouse.up();
const h1 = (await cell.boundingBox()).height;
const size = await page.evaluate(() => window.ws.node(document.querySelector(".carreau-scrollcell").dataset.id).size);
console.log(`resized: ${Math.round(h0)} → ${Math.round(h1)}px (size ${size})`);
await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.press("KeyZ"); await page.keyboard.up("Alt");
await page.waitForTimeout(100);
console.log("undo:", Math.round((await cell.boundingBox()).height), "px, size", await page.evaluate(() => window.ws.node(document.querySelector(".carreau-scrollcell").dataset.id).size));
// The close button.
const before = await page.locator(".carreau-scrollcell").count();
await page.locator(".carreau-scrollcell").nth(1).locator(".carreau-cell-close").click();
await page.waitForTimeout(1500);
console.log(`closed one: ${before} → ${await page.locator(".carreau-scrollcell").count()} cells`);
// A split cell (Notebook's du | ssh row): both panes have a bar; either resizes the row.
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
const du = page.locator(".carreau-scrollcell", { has: page.locator(".carreau-long", { hasText: "du -sh" }) });
const ssh = page.locator(".carreau-scrollcell", { has: page.locator(".carreau-long", { hasText: "ssh build-box" }) });
const hs = async () => [Math.round((await du.boundingBox()).height), Math.round((await ssh.boundingBox()).height)];
console.log("du | ssh bars:", await du.locator(".carreau-gutter.resizes").count(), await ssh.locator(".carreau-gutter.resizes").count(), "| heights:", (await hs()).join(", "));
const gb = await ssh.locator(".carreau-gutter").boundingBox();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height * 0.85);
await page.mouse.down();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height * 0.85 + 60, { steps: 6 });
await page.mouse.up();
const duId = await du.getAttribute("data-id");
const rowSize = await page.evaluate((id) => window.ws.index().parent(id).size, duId);
console.log("dragged ssh's bar down 60px: heights", (await hs()).join(", "), "| the row's size:", rowSize);
await page.screenshot({ path: "/tmp/sc-row.png" });
await browser.close();
