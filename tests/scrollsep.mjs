import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
await page.evaluate(() => { window.ws.root.children[0].weight = 2.2; window.ws.emit(); }); // show all sidebar tabs
await page.waitForTimeout(200);
const cellPane = (short) => page.locator(".carreau-pane", { has: page.locator(":scope > .carreau-tabbar .carreau-tab-short", { hasText: new RegExp(`^${short}$`) }) }).last();
const st = () => page.evaluate(() => { const d = window.view.drag; const t = d?.active?.target; return t ? `${t.kind}${t.side ? ":" + t.side : ""}${t.index !== undefined ? ":" + t.index : ""}${d.active.edge ? " (edge " + d.active.edge.side + ")" : ""}${d.active.straddle ? " (between cells)" : ""}` : "none"; });
const cells = () => page.evaluate(() => [...document.querySelectorAll(".carreau-scroll > [data-id]")].map((e) => e.querySelector(".carreau-tab-short")?.textContent).join(", "));
const t = await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: /^deploy$/ }) }).boundingBox();
await page.mouse.move(t.x + 10, t.y + 5); await page.mouse.down();
await page.mouse.move(t.x + 80, t.y - 80, { steps: 5 });
const ls = await cellPane("ls").boundingBox();
const ex = await cellPane("Explain").boundingBox();
for (const [label, x, y] of [
  ["ls: very top edge", ls.x + ls.width / 2, ls.y + 3],
  ["ls: top third", ls.x + ls.width / 2, ls.y + ls.height * 0.2],
  ["ls: bottom third", ls.x + ls.width / 2, ls.y + ls.height * 0.85],
  ["ls: left third", ls.x + ls.width * 0.1, ls.y + ls.height / 2],
  ["ls|Explain separator", ex.x + ex.width / 2, ex.y - 1],
]) {
  await page.mouse.move(x, y, { steps: 4 });
  console.log(label.padEnd(22), await st());
  if (label === "ls: very top edge") await page.screenshot({ path: "/tmp/scrollsep-top.png", clip: { x: ls.x - 5, y: ls.y - 5, width: ls.width + 10, height: ls.height + 10 } });
}
// drop at the very top
await page.mouse.move(ls.x + ls.width / 2, ls.y + 3, { steps: 3 });
await page.mouse.up();
console.log("dropped at the very top:", await cells());
// last cell: bottom edge (scroll to the end first)
await page.evaluate(() => (document.querySelector(".carreau-scroll").scrollTop = 1e6));
await page.waitForTimeout(100);
const t2 = await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: /^tests$/ }) }).boundingBox();
const last = await cellPane("git log").boundingBox();
await page.mouse.move(t2.x + 10, t2.y + 5); await page.mouse.down();
await page.mouse.move(t2.x + 80, t2.y - 80, { steps: 5 });
await page.mouse.move(last.x + last.width / 2, last.y + last.height - 3, { steps: 6 });
console.log("git log: very bottom edge", await st());
await page.mouse.up();
console.log("dropped at the very bottom:", await cells());
await browser.close();
