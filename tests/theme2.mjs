// Light mode: a group and a floating window.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, colorScheme: "light" });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=IDE");
await page.waitForTimeout(300);
await page.evaluate(() => {
  const ws = window.ws;
  ws.select({ id: ws.root.children[1].id }); // the editor + terminal column
  ws.group("media");
  const outline = ws.root.children[ws.root.children.length - 1];
  window.view.floatPane(outline.id);
});
await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/theme-light-group.png" });
await browser.close();
