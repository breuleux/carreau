import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const tabRe = (t) => new RegExp(`^${t.replace(".", "\\.")}$`);
const summary = () => page.evaluate(() => {
  const show = (n) => (n.type === "pane" ? n.tabs.map((t) => t.title).join("+") : `${n.type}(${n.children.map(show).join(", ")})`);
  return `main=${show(window.ws.root)}\n      floats=[${window.ws.floating.map((w) => show(w.root)).join(" ; ")}]`;
});
const st = () => page.evaluate(() => { const t = window.view.drag?.active?.target; return t ? `${t.kind}${t.side ? ":" + t.side : ""}${t.index !== undefined ? ":" + t.index : ""}` : "none"; });
async function drag(handle, to, label) {
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + 5, h.y + 5); await page.mouse.down();
  await page.mouse.move(h.x + 30, h.y + 40, { steps: 5 });
  const [x, y] = await to();
  await page.mouse.move(x, y, { steps: 8 });
  const a = await st();
  if (label === "shot") await page.screenshot({ path: "/tmp/float-edge.png" });
  await page.mouse.up();
  return a;
}
await page.goto("http://localhost:5317/?example=IDE");
// float Outline via menu
const outline = page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Outline$/ }) });
await outline.locator(".carreau-more").click();
await page.locator(".carreau-menu button", { hasText: "Float" }).click();
const win = page.locator(".carreau-float");
// move the window somewhere central (quick move, no dock)
const bar = await page.locator(".carreau-float-bar").boundingBox();
await page.mouse.move(bar.x + 20, bar.y + 5); await page.mouse.down();
await page.mouse.move(500, 250, { steps: 8 }); await page.mouse.up();
console.log("floated:", await summary());
// 1. drag the "Search" tab into the window's tab bar (after Outline)
console.log("tab into window tab bar ->", await drag(page.locator(".carreau-tab", { hasText: /^Search$/ }), async () => {
  const t = await win.locator(".carreau-tab", { hasText: /^Outline$/ }).boundingBox(); return [t.x + t.width + 2, t.y + t.height / 2];
}));
console.log("  ", await summary());
// 2. drag the Terminal pane onto the window's left third => splits the window
console.log("pane onto window's left third ->", await drag(page.locator(".carreau-root .carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Terminal$/ }) }).locator(".carreau-tabspace"), async () => {
  const w = await win.boundingBox(); return [w.x + w.width * 0.12, w.y + w.height * 0.6];
}, "shot"));
console.log("  ", await summary());
// widen the window so that both of Terminal's tabs are in view
await page.evaluate(() => { window.ws.floating[0].rect.w = 700; window.ws.emit(); });
// 3. drag a tab from inside the window back into the main tree (Problems -> right third of main.ts)
console.log("tab out of window ->", await drag(win.locator(".carreau-tab", { hasText: /^Problems$/ }), async () => {
  const m = await page.locator(".carreau-root .carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^main\.ts$/ }) }).boundingBox(); return [m.x + m.width * 0.9, m.y + m.height / 2];
}));
console.log("  ", await summary());
// 4. dock the whole (split) window: hold its bar still on the left third of Files
const fb = await page.locator(".carreau-float-bar").boundingBox();
const files = await page.locator(".carreau-root .carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Files$/ }) }).boundingBox();
await page.mouse.move(fb.x + 20, fb.y + 5); await page.mouse.down();
await page.mouse.move(files.x + files.width * 0.15, files.y + files.height / 2, { steps: 10 });
await page.waitForTimeout(1200);
console.log("dock window ->", await st());
await page.mouse.up();
console.log("  ", await summary());
await browser.close();
