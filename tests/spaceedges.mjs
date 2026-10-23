// A scroll split's empty space: near its edges, the border lines (its holder's); elsewhere,
// inserting into the stream.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Single pane"));
await page.waitForTimeout(200);
await page.evaluate(() => {
  const tab = (t) => ({ id: "t" + t, title: t, content: t });
  window.ws.load({ floating: [], root: { type: "row", id: "r", weight: 1, children: [
    { type: "pane", id: "pa", weight: 1, active: 0, tabs: [tab("A"), tab("B")] },
    { type: "prompt-column", id: "pc", weight: 1, children: [{ type: "prompt", id: "q", weight: 1 }] },
  ] } });
});
await page.waitForTimeout(200);
const sc = await page.locator(".carreau-frame-inner").boundingBox();
const b = await page.locator(".carreau-tab", { hasText: /^B$/ }).boundingBox();
await page.mouse.move(b.x + 10, b.y + 10); await page.mouse.down();
await page.mouse.move(b.x + 60, b.y - 60, { steps: 4 });
const at = async (label, x, y) => {
  await page.mouse.move(x, y, { steps: 4 });
  console.log(label, await page.evaluate(() => { const d = window.view.drag; return `line ${d.near?.side ?? "-"} | active ${d.active?.target.kind ?? "none"}${d.active?.target.side ? ":" + d.active.target.side : ""} | rects ${document.querySelectorAll(".carreau-overlay rect.carreau-indicator").length}`; }));
};
await at("near its left edge:", sc.x + 2, sc.y + sc.height / 2);
await at("in the middle:", sc.x + sc.width / 2, sc.y + sc.height / 2);
await at("near its top edge:", sc.x + sc.width / 2, sc.y + 2);
await page.screenshot({ path: "/tmp/spaceedges.png" });
await page.mouse.up();
await browser.close();
