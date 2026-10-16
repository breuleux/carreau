// Screenshot of the demo page (checks that the demo's styles load).
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/demo.png" });
await browser.close();
