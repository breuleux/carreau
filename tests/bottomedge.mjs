import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
for (const [ex, dragTab] of [["Scroll column", "Inspector"], ["Notebook", "Sessions"], ["Embeds", "Notes"]]) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(ex));
  await page.waitForTimeout(300);
  await page.evaluate(() => { const e = document.querySelector(".carreau-scroll"); e.scrollTop = 1e6; });
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => {
    const sc = document.querySelector(".carreau-scroll");
    const cells = [...sc.children].filter((c) => c.dataset.id);
    const last = cells[cells.length - 1].getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    return { lastBottom: last.bottom, lastX: last.left + last.width / 2, clientBottom: s.top + sc.clientTop + sc.clientHeight, scrollTop: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
  });
  const t = await page.locator(".carreau-tab", { has: page.locator(".carreau-tab-short", { hasText: new RegExp(`^${dragTab}$`) }) }).first().boundingBox();
  await page.mouse.move(t.x + 10, t.y + 5); await page.mouse.down();
  await page.mouse.move(t.x + 60, t.y - 60, { steps: 5 });
  const res = [];
  for (const dy of [6, 3, 1, 0, -1, -3]) {
    await page.mouse.move(info.lastX, info.lastBottom - dy, { steps: 3 });
    res.push(`-${dy}px: ` + await page.evaluate(() => { const d = window.view.drag; return `${d.near?.side ?? "no line"} ${d.active ? d.active.target.kind + (d.active.target.index !== undefined ? "@" + d.active.target.index : "") : "none"}`; }));
  }
  await page.keyboard.press("Escape"); await page.mouse.up();
  console.log(ex.padEnd(14), `last cell bottom ${info.lastBottom.toFixed(1)}, viewport bottom ${info.clientBottom.toFixed(1)}, scrollTop ${info.scrollTop}/${info.max} |`, res.join(" | "));
}
await browser.close();
