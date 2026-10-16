import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
for (const ex of ["Scroll column", "Scroll row"]) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(ex));
  const info = await page.evaluate((ex) => [...document.querySelectorAll(".carreau-scroll")].map((e) =>
    `${e.className.split(" ").pop()} client=${e.clientWidth}x${e.clientHeight} scroll=${e.scrollWidth}x${e.scrollHeight} kids=${[...e.children].filter(c => c.dataset.id).map(c => Math.round(c.getBoundingClientRect()[ex === "Scroll row" ? "width" : "height"])).join(",")}`), ex);
  console.log(ex, info.join(" | "));
  const tag = ex.replace(" ", "-");
  await page.screenshot({ path: `/tmp/${tag}.png` });
  await page.evaluate(() => { const e = document.querySelector(".carreau-scroll"); e.scrollTop = 500; e.scrollLeft = 500; });
  await page.waitForTimeout(100);
  await page.screenshot({ path: `/tmp/${tag}-scrolled.png` });
}
await browser.close();
