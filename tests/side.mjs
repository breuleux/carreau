import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=IDE");
await page.locator(".carreau-tab", { hasText: /^Files$/ }).click();
const mode = () => page.evaluate(() => window.nav.mode);
async function tryKey(alt) {
  await page.keyboard.down(alt); await page.keyboard.press("KeyQ");
  const m = await mode();
  await page.keyboard.up(alt);
  const after = await mode();
  return `${m} → after release ${after}`;
}
for (const side of ["either", "left", "right"]) {
  await page.evaluate((side) => (window.nav.config.activation.side = side), side);
  console.log(`side=${side.padEnd(6)} AltLeft: ${await tryKey("AltLeft")} | AltRight: ${await tryKey("AltRight")}`);
}
// side=left: holding left Alt, pressing+releasing right Alt doesn't end the mode
await page.evaluate(() => (window.nav.config.activation.side = "left"));
await page.keyboard.down("AltLeft"); await page.keyboard.press("KeyQ");
await page.keyboard.down("AltRight"); await page.keyboard.up("AltRight");
console.log("left held, right tapped:", await mode());
await page.keyboard.up("AltLeft");
console.log("left released:", await mode());
await browser.close();
