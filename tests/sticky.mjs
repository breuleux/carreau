// Sticky (reverse) scroll splits: content at the end; stays at the end while growing.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=Sticky");
await page.waitForTimeout(300);
const info = () => page.evaluate(() => [...document.querySelectorAll(".carreau-scroll")].map((sc) => {
  const row = sc.classList.contains("carreau-scroll-row");
  const r = sc.getBoundingClientRect(), f = sc.firstElementChild.getBoundingClientRect(), l = sc.lastElementChild.getBoundingClientRect();
  const gapStart = row ? f.left - r.left : f.top - r.top, gapEnd = row ? r.right - l.right : r.bottom - l.bottom;
  const max = row ? sc.scrollWidth - sc.clientWidth : sc.scrollHeight - sc.clientHeight;
  return `${sc.classList.contains("carreau-reverse") ? "sticky" : "normal"} ${row ? "row" : "col"}: n=${[...sc.children].filter((c) => c.dataset.id).length} gapStart=${gapStart.toFixed(0)} gapEnd=${gapEnd.toFixed(0)} scroll=${(row ? sc.scrollLeft : sc.scrollTop).toFixed(0)}/${max}`;
}).join("\n  "));
console.log("initial:\n ", await info());
await page.screenshot({ path: "/tmp/sticky.png" });
// grow the sticky column: add cells (a re-render, like a new command)
const add = (n) => page.evaluate((n) => {
  const sc = [...document.querySelectorAll(".carreau-scroll-column.carreau-reverse")][0];
  const node = window.ws.index().node(sc.dataset.scroll ?? sc.dataset.id);
  for (let i = 0; i < n; i++) { const id = Math.random().toString(36).slice(2, 8); node.children.push({ type: "pane", id: "p" + id, weight: 1, active: 0, tabs: [{ id: "t" + id, title: "cmd " + id, content: "line\n".repeat(6) }] }); }
  window.ws.emit();
}, n);
await add(6); await page.waitForTimeout(200);
console.log("after adding 6:\n ", await info());
// content growing without a re-render: a cell's content gets longer
await page.evaluate(() => { const sc = document.querySelector(".carreau-scroll-column.carreau-reverse"); const c = sc.lastElementChild.querySelector(".carreau-content"); c.textContent += "\nmore\nmore\nmore\nmore\nmore"; });
await page.waitForTimeout(200);
console.log("after growing the last cell:\n ", await info());
// scroll up, then grow: stays put
await page.evaluate(() => (document.querySelector(".carreau-scroll-column.carreau-reverse").scrollTop = 100));
await page.waitForTimeout(100);
await add(1); await page.waitForTimeout(200);
console.log("scrolled up, then added 1:\n ", await info());
// menu toggle on the sticky column's holder
const holder = page.locator(".carreau-pane", { has: page.locator(":scope > .carreau-body > .carreau-group > .carreau-framed > .carreau-scroll-column.carreau-reverse") });
await holder.locator(":scope > .carreau-tabbar .carreau-more").click();
const items = await page.locator(".carreau-menu button").allTextContents();
console.log("menu:", items);
await page.locator(".carreau-menu button", { hasText: "Stick to top" }).click();
await page.waitForTimeout(100);
console.log("after Stick to top:\n ", await info());
await page.evaluate(() => window.ws.undo()); await page.waitForTimeout(100);
console.log("after undo:", await page.evaluate(() => document.querySelectorAll(".carreau-reverse").length), "sticky splits");
console.log("serialized:", await page.evaluate(() => (JSON.stringify(window.ws.data()).match(/"reverse":true/g) ?? []).length), "reverse flags");
await browser.close();
