// Over a scroll split's empty space (here, a prompt column's): its edge 20% (where empty) split
// beside its pane, except at the prompt's end (bottom); elsewhere, into it.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Single pane"));
await page.waitForTimeout(200);
const tab = (t) => ({ id: "t" + t, title: t, content: t });
const load = (withCell) => page.evaluate(([withCell, A, B, C]) => {
  window.ws.load({ floating: [], root: { type: "row", id: "r", weight: 1, children: [
    { type: "pane", id: "pa", weight: 1, active: 0, tabs: [A, B] },
    { type: "prompt-column", id: "pc", weight: 1, children: [...(withCell ? [{ type: "pane", id: "pcell", weight: 1, active: 0, tabs: [C] }] : []), { type: "prompt", id: "q", weight: 1 }] },
  ] } });
}, [withCell, tab("A"), tab("B"), tab("C")]);
const probe = async (label, withCell) => {
  await load(withCell); await page.waitForTimeout(200);
  const sc = await page.locator(".carreau-frame-inner").boundingBox();
  const b = await page.locator(".carreau-tab", { hasText: /^B$/ }).boundingBox();
  await page.mouse.move(b.x + 10, b.y + 10); await page.mouse.down();
  await page.mouse.move(b.x + 60, b.y - 60, { steps: 4 });
  for (const [n, fx, fy] of [["left10%", 0.1, 0.5], ["right10%", 0.9, 0.5], ["left30%", 0.3, 0.5], ["top10%", 0.5, 0.1], ["bottom10%", 0.5, 0.9], ["mid", 0.5, 0.5]]) {
    await page.mouse.move(sc.x + sc.width * fx, sc.y + sc.height * fy, { steps: 3 });
    console.log(label, n.padEnd(10), await page.evaluate(() => { const t = window.view.drag.active?.target; return t ? `${t.kind} ${t.targetId ?? t.splitId ?? ""} ${t.side ?? t.index ?? ""}` : "none"; }));
  }
  await page.keyboard.press("Escape"); await page.mouse.up(); await page.waitForTimeout(600);
};
await probe("empty", false);
await probe("1cell", true);
await browser.close();
