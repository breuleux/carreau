import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.goto("http://localhost:5317/?example=IDE");
const P = (t) => ({ type: "pane", id: "p" + t, weight: 1, active: 0, tabs: [{ id: "t" + t, title: t }] });
const cases = {
  "scroll-column short, in row": { type: "row", id: "r", weight: 1, children: [P("a"), { type: "scroll-column", id: "sc", weight: 2, children: [P("b"), P("c")] }] },
  "scroll-row short, in column": { type: "column", id: "c", weight: 1, children: [{ type: "scroll-row", id: "sr", weight: 1, children: [P("b"), P("c")] }, P("a")] },
  "scroll-column as root": { type: "scroll-column", id: "sc", weight: 1, children: [P("b"), P("c")] },
  "scroll-row in scroll-column": { type: "scroll-column", id: "sc", weight: 1, children: [P("a"), { type: "scroll-row", id: "sr", weight: 1, children: [P("b"), P("c")] }] },
};
for (const [name, root] of Object.entries(cases)) {
  await page.evaluate((root) => window.ws.load({ root, floating: [] }), root);
  await page.waitForTimeout(100);
  console.log(name.padEnd(30), await page.evaluate(() => [...document.querySelectorAll(".carreau-scroll")].map((e) => {
    const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect();
    const kids = [...e.children].filter((c) => c.dataset.id).map((c) => c.getBoundingClientRect());
    return `${e.className.split(" ").pop()} ${Math.round(r.width)}x${Math.round(r.height)} (parent ${Math.round(p.width)}x${Math.round(p.height)}) kids ${kids.map((k) => `${Math.round(k.width)}x${Math.round(k.height)}`).join(" ")}`;
  }).join(" || ")));
  await page.screenshot({ path: `/tmp/sf-${name.replace(/\W+/g, "-")}.png`, clip: { x: 0, y: 30, width: 1000, height: 770 } });
}
await browser.close();
