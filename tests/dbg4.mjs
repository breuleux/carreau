import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.goto("http://localhost:5317/?example=IDE");
console.log(await page.evaluate(() => {
  const bar = document.querySelector(".carreau-tabbar");
  const out = [...bar.children].map((e) => `${e.className} w=${e.getBoundingClientRect().width.toFixed(1)} scrollW=${e.scrollWidth} text=${e.textContent}`);
  out.push("bar scrollWidth=" + bar.scrollWidth + " clientWidth=" + bar.clientWidth + " pane w=" + bar.parentElement.getBoundingClientRect().width);
  return out.join("\n");
}));
await browser.close();
