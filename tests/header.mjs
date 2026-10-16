import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
await page.goto("http://localhost:5317/?example=IDE");
// shrink the Files pane to force tabs to ellipsize
await page.screenshot({ path: "/tmp/header.png", clip: { x: 0, y: 30, width: 1000, height: 60 } });
const space = await page.locator(".carreau-pane", { has: page.locator(".carreau-tab", { hasText: /^Files$/ }) }).locator(".carreau-tabspace").boundingBox();
console.log("Files header space width:", Math.round(space.width));
await browser.close();
