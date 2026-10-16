import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:5317/?example=Single%20pane");
console.log(await page.evaluate(async () => {
  const a = document.createElement("div"), b = document.createElement("div");
  document.body.append(a, b);
  const f = document.createElement("iframe");
  f.srcdoc = "<script>window.loaded = Date.now()</script>";
  a.append(f);
  await new Promise((r) => setTimeout(r, 300));
  const w = f.contentWindow, t = w.loaded;
  let err = "none";
  try { b.moveBefore(f, null); } catch (e) { err = String(e); }
  await new Promise((r) => setTimeout(r, 300));
  return `err=${err} sameWindow=${f.contentWindow === w} loadedSame=${f.contentWindow.loaded === t} ua=${navigator.userAgent.match(/Chrome\/[\d.]+/)}`;
}));
await browser.close();
