import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.goto("http://localhost:5317/?example=Embeds");
await page.waitForTimeout(800);
console.log(await page.evaluate(async () => {
  const f = document.querySelector("iframe[srcdoc]");
  const w = f.contentWindow;
  const orig = Element.prototype.moveBefore;
  const log = [];
  Element.prototype.moveBefore = function (n, r) { try { return orig.call(this, n, r); } catch (e) { log.push(String(e)); throw e; } };
  const origAppend = Element.prototype.appendChild;
  Element.prototype.appendChild = function (n) { if (n.classList?.contains("carreau-content")) log.push("appendChild fallback"); return origAppend.call(this, n); };
  window.ws.select({ id: window.ws.root.children[1].id });
  await new Promise((r) => setTimeout(r, 300));
  return `sameWindow=${f.contentWindow === w} connected=${f.isConnected} log=${log.join(";")}`;
}));
await browser.close();
