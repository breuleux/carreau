// The prompt column alone in the workspace (its holder is the root): over its empty space, near
// the edges, the lines offer splitting the workspace.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
await page.waitForTimeout(200);
await page.locator(".carreau-tab", { hasText: "Notes" }).locator(".carreau-tab-close").click();
await page.waitForTimeout(200);
console.log("root:", await page.evaluate(() => window.ws.root.type + " " + window.ws.root.tabs?.map((t) => t.title).join("+")));
const sc = await page.locator(".carreau-frame-inner").boundingBox();
const ls = await page.locator(".carreau-long", { hasText: "$ ls" }).boundingBox();
await page.mouse.move(ls.x + 60, ls.y + ls.height / 2); await page.mouse.down();
await page.mouse.move(ls.x + 100, ls.y - 60, { steps: 4 });
const at = async (label, x, y) => {
  await page.mouse.move(x, y, { steps: 4 });
  console.log(label, await page.evaluate(() => { const d = window.view.drag; return `line ${d.near?.side ?? "-"} | active ${d.active?.target.kind ?? "none"}${d.active?.target.side ? ":" + d.active.target.side : ""}`; }));
};
await at("left edge, empty space:", sc.x + 2, sc.y + 80);
await page.screenshot({ path: "/tmp/spaceroot.png", clip: { x: 0, y: 30, width: 500, height: 300 } });
await at("top edge:", sc.x + sc.width / 2, sc.y + 2);
await at("middle of the empty space:", sc.x + sc.width / 2, sc.y + 80);
await at("back to the left edge:", sc.x + 2, sc.y + 80);
await page.mouse.up();
await page.waitForTimeout(150);
console.log("dropped at the left edge:", await page.evaluate(() => { const f = (n) => (n.type === "pane" ? n.tabs.map((t) => t.title).join("+") : `${n.type}(${n.children.map(f).join(", ")})`); return f(window.ws.root); }));
await browser.close();
