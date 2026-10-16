// Every example loads without page errors, and the prompt column one with its frame.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:5317/");
const names = await page.locator("#example option").allTextContents();
for (const n of names) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(n));
  await page.waitForTimeout(150);
  console.log(n.padEnd(28), "framed:", await page.locator(".carreau-framed").count(), "| errors:", errors.splice(0).join("; ") || "none");
}
await browser.close();
