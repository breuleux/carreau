import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Notebook");
await page.evaluate(() => { window.ws.root.children[0].weight = 2.2; window.ws.emit(); });
await page.waitForTimeout(300);
const cellPane = (short) => page.locator(".carreau-pane", { has: page.locator(":scope > .carreau-tabbar .carreau-tab-short", { hasText: new RegExp(`^${short}$`) }) }).last();
const levels = () => page.evaluate(() => { const d = window.view.drag; const n = (id) => { const x = window.ws.node(id); return x?.type === "pane" ? x.tabs[0].title : x?.type; }; return d.near ? d.near.levels.map((c) => `${c.target.kind}:${c.target.kind === "side" ? n(c.target.targetId) : n(c.target.splitId)}`).join(" | ") : "no line"; });
const t = await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: /^deploy$/ }) }).boundingBox();
await page.mouse.move(t.x + 10, t.y + 5); await page.mouse.down();
await page.mouse.move(t.x + 80, t.y - 80, { steps: 5 });
for (const [label, short, fx] of [["left edge of Explain", "Explain", 0.003], ["right edge of Explain", "Explain", 0.997]]) {
  const b = await cellPane(short).boundingBox();
  await page.mouse.move(b.x + b.width * fx, b.y + b.height / 2, { steps: 5 });
  console.log(label.padEnd(22), await levels());
}
await page.keyboard.press("Escape"); await page.mouse.up();
await browser.close();
