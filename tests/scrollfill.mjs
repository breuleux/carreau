import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
for (const ex of ["Scroll column", "Scroll row", "Embeds"]) {
  await page.goto("http://localhost:5317/?example=" + encodeURIComponent(ex));
  await page.waitForTimeout(300);
  console.log(ex, await page.evaluate(() => [...document.querySelectorAll(".carreau-scroll")].map((e) => {
    const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect();
    const kids = [...e.children].filter((c) => c.dataset.id).map((c) => c.getBoundingClientRect());
    const col = e.classList.contains("carreau-scroll-column");
    const used = kids.reduce((s, k) => s + (col ? k.height : k.width), 0);
    return `${e.className.split(" ").pop()}: self ${Math.round(r.width)}x${Math.round(r.height)} in parent ${Math.round(p.width)}x${Math.round(p.height)} | client ${e.clientWidth}x${e.clientHeight} | kids along axis ${Math.round(used)}`;
  }).join("\n  ")));
}
await page.screenshot({ path: "/tmp/sf.png" });
await browser.close();
