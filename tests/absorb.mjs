// Into a stream's cell: into the stream, just after it (Alt+Q I Enter; Alt+Q A ↓). And
// Alt+Q I F: a new cell in a floating window.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const stream = () => page.evaluate(() => [...document.querySelector(".carreau-frame-inner").children].filter((c) => c.dataset.id).map((c) => [...c.querySelectorAll(".carreau-tab-short")].map((t) => t.textContent).join("+") || "?").join(", "));
const altQ = async (...keys) => { await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); for (const k of keys) await page.keyboard.press(k); await page.keyboard.up("Alt"); await page.waitForTimeout(150); };
await page.goto("http://localhost:5317/?example=Notebook");
await page.waitForTimeout(300);
console.log("stream:", await stream());
await page.locator(".carreau-long", { hasText: "make test" }).click();
await altQ("KeyI", "Enter");
console.log("Alt+Q I Enter on make test:", await stream(), "|", await page.locator("#status").textContent());
await page.locator(".carreau-long", { hasText: "ls -la" }).click();
await altQ("KeyA", "ArrowDown");
console.log("Alt+Q A ↓ on ls:", await stream());
await page.locator(".carreau-long", { hasText: "Explain" }).click();
await altQ("KeyI", "KeyF");
console.log("Alt+Q I F on Explain:", await page.evaluate(() => window.ws.floating.map((w) => w.root.tabs.map((t) => t.title).join("+")).join(" ; ")), "| windows:", await page.locator(".carreau-float").count());
await page.screenshot({ path: "/tmp/absorb.png" });
await browser.close();
