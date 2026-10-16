import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Notebook");
await page.evaluate(() => { window.ws.root.children[0].weight = 2.2; window.ws.emit(); });
await page.waitForTimeout(300);
const cellPane = (short) => page.locator(".carreau-pane", { has: page.locator(":scope > .carreau-tabbar .carreau-tab-short", { hasText: new RegExp(`^${short}$`) }) }).last();
const levels = () => page.evaluate(() => { const d = window.view.drag; const n = (id) => { const x = window.ws.node(id); return x?.type === "pane" ? x.tabs[0].title : x?.type; }; return d.near ? d.near.levels.map((c) => `${c.target.kind}:${c.target.kind === "side" ? n(c.target.targetId) : n(c.target.splitId) + "@" + c.target.index}`).join(" | ") + `   → active ${d.active?.target.kind}` : "no line"; });
const t = await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: /^deploy$/ }) }).boundingBox();
await page.mouse.move(t.x + 10, t.y + 5); await page.mouse.down();
await page.mouse.move(t.x + 80, t.y - 80, { steps: 5 });
const ls = await cellPane("ls").boundingBox();
await page.mouse.move(ls.x + ls.width / 2, ls.y + 3, { steps: 6 });
console.log("top of first cell:", await levels());
await page.screenshot({ path: "/tmp/scrollsep2.png", clip: { x: ls.x - 10, y: ls.y - 6, width: 300, height: 30 } });
// a few positions along the line pick the different options (dashes)
for (let dx = 0; dx < 60; dx += 18) {
  await page.mouse.move(ls.x + 40 + dx, ls.y + 3, { steps: 1 });
  console.log("  at +" + dx, await page.evaluate(() => { const t = window.view.drag.active?.target; return t ? `${t.kind}${t.index !== undefined ? "@" + t.index : ""}` : "none"; }));
}
// bottom of the last cell: not the holder's bottom (the header is there): separator only
await page.mouse.move(ls.x + ls.width / 2, ls.y + ls.height / 2, { steps: 3 });
await page.evaluate(() => (document.querySelector(".carreau-scroll").scrollTop = 1e6));
await page.waitForTimeout(150);
const last = await cellPane("git log").boundingBox();
await page.mouse.move(last.x + last.width / 2, last.y + last.height - 3, { steps: 4 });
console.log("bottom of last cell:", await levels());
await page.keyboard.press("Escape");
await page.mouse.up();
await browser.close();
