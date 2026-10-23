// With the prompt selected, renaming the tab (%) and naming the pane (N) act on the prompt
// column's pane and its tab, not on the cell above the prompt.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://localhost:5317/?example=" + encodeURIComponent("Prompt column"));
await page.waitForTimeout(300);
const selectPrompt = () => page.evaluate(() => { const q = [...(function* w(n) { yield n; for (const c of n.children ?? []) yield* w(c); for (const t of n.tabs ?? []) if (t.group) yield* w(t.group); })(window.ws.root)].find((n) => n.type === "prompt"); window.ws.select({ id: q.id }); });
const state = () => page.evaluate(() => { const ps = [...(function* w(n) { yield n; for (const c of n.children ?? []) yield* w(c); for (const t of n.tabs ?? []) if (t.group) yield* w(t.group); })(window.ws.root)].filter((n) => n.type === "pane"); return ps.map((p) => (p.name ? `[${p.name}] ` : "") + p.tabs.map((t) => t.title).join("+")).join(" | "); });
for (const [key, typed, label] of [["Percent", "Chat", "% (rename tab)"], ["KeyN", "talk", "N (name pane)"]]) {
  await selectPrompt();
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt"); await page.keyboard.press("KeyQ");
  await page.waitForTimeout(100);
  await page.evaluate((a) => window.nav.run(a), key === "Percent" ? "renameTab" : "namePane");
  await page.waitForTimeout(100);
  const field = page.locator(".carreau-tab-edit, .carreau-pane-name-edit");
  console.log(label, "editing:", await field.count(), "in the column's pane:", await field.evaluate((i) => !!i.closest(".carreau-pane")?.querySelector(".carreau-frame-inner")));
  await field.fill(typed); await page.keyboard.press("Enter"); await page.waitForTimeout(100);
  console.log("  →", await state());
}
await browser.close();
