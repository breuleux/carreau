// Light and dark: screenshots of a few examples, with a drag in progress (lines, preview).
import { chromium } from "playwright";
const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, colorScheme: scheme });
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  for (const ex of ["IDE", "Notebook", "Deep nesting"]) {
    await page.goto("http://localhost:5317/?example=" + encodeURIComponent(ex));
    await page.waitForTimeout(300);
    if (ex === "Deep nesting") {
      const src = await page.locator(".carreau-tab").first().boundingBox();
      const tgt = await page.locator(".carreau-pane").nth(3).boundingBox();
      await page.mouse.move(src.x + 10, src.y + 5); await page.mouse.down();
      await page.mouse.move(src.x + 60, src.y - 60, { steps: 4 });
      await page.mouse.move(tgt.x + 3, tgt.y + tgt.height / 2, { steps: 6 });
    }
    if (ex === "IDE") await page.locator(".carreau-more").first().click();
    await page.screenshot({ path: `/tmp/theme-${scheme}-${ex.replace(" ", "")}.png` });
    if (ex === "Deep nesting") await page.mouse.up();
  }
  console.log(scheme, "bg:", await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "pane:", await page.evaluate(() => getComputedStyle(document.querySelector(".carreau-pane")).backgroundColor));
  await page.close();
}
await browser.close();
