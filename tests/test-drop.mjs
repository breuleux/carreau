import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { row, column, pane, applyDropForest, panes, find, scrollColumn, normalize } = await server.ssrLoadModule("/src/model.ts");
// single-tree convenience (the app always works on several trees)
const applyDrop = (root, subject, target) => {
  const r = applyDropForest([root], subject, target);
  return r ? { root: r.trees[0], paneId: r.paneId, floated: r.floated } : null;
};
let fails = 0;
const check = (name, ok) => { console.log(ok ? "ok  " : "FAIL", name); if (!ok) fails++; };
// row[ column[P, Q], R ], P has a single tab
const root = row([column([pane(["P"], 2), pane(["Q"])]), pane(["R"])]);
const [P, Q, R] = panes(root);
const col = root.children[0];
const tab = { kind: "tab", tabId: P.tabs[0].id };
check("lone tab: top of its own column is a no-op", applyDrop(root, tab, { kind: "side", targetId: col.id, side: "top" }) === null);
check("lone tab: top of the root row is meaningful (spans full width)", applyDrop(root, tab, { kind: "side", targetId: root.id, side: "top" }) !== null);
check("lone tab: left of the column is meaningful", applyDrop(root, tab, { kind: "side", targetId: col.id, side: "left" }) !== null);
check("lone tab: below Q is meaningful", applyDrop(root, tab, { kind: "side", targetId: Q.id, side: "bottom" }) !== null);
check("lone tab: between column and R is meaningful", applyDrop(root, tab, { kind: "between", splitId: root.id, index: 1 }) !== null);
check("pane: top of its own column is a no-op", applyDrop(root, { kind: "pane", paneId: P.id }, { kind: "side", targetId: col.id, side: "top" }) === null);
// tab with siblings: splitting off is meaningful
const root2 = row([pane(["A", "B"]), pane(["C"])]);
const [A] = panes(root2);
check("tab with siblings: left of own pane is meaningful", applyDrop(root2, { kind: "tab", tabId: A.tabs[0].id }, { kind: "side", targetId: A.id, side: "left" }) !== null);
// swap
{
  const root4 = row([pane(["A", "B"]), pane(["C", "D"])]);
  const [X, Y] = panes(root4);
  Y.active = 1;
  const r = applyDrop(root4, { kind: "tab", tabId: X.tabs[0].id }, { kind: "swap", paneId: Y.id });
  const [X2, Y2] = panes(r.root);
  check("tab swap trades with the active tab", X2.tabs.map((t) => t.title).join() === "D,B" && Y2.tabs.map((t) => t.title).join() === "C,A");
  const r2 = applyDrop(root4, { kind: "pane", paneId: X.id }, { kind: "swap", paneId: Y.id });
  const [X3, Y3] = panes(r2.root);
  check("pane swap trades all tabs", X3.tabs.map((t) => t.title).join() === "C,D" && Y3.tabs.map((t) => t.title).join() === "A,B");
  check("swap with own pane is a no-op", applyDrop(root4, { kind: "tab", tabId: X.tabs[0].id }, { kind: "swap", paneId: X.id }) === null);
}
// float
{
  const root5 = row([pane(["A", "B"]), pane(["C"])]);
  const [X, Y] = panes(root5);
  const r = applyDrop(root5, { kind: "pane", paneId: X.id }, { kind: "float", paneId: X.id });
  check("float a pane: removed from tree", r && r.floated.id === X.id && r.root.type === "pane" && r.root.id === Y.id);
  const r2 = applyDrop(root5, { kind: "tab", tabId: X.tabs[1].id }, { kind: "float", paneId: X.id });
  check("float a tab among others: new pane with that tab", r2 && r2.floated.tabs.map((t) => t.title).join() === "B" && panes(r2.root).length === 2);
  check("float over another pane: no", applyDrop(root5, { kind: "pane", paneId: X.id }, { kind: "float", paneId: Y.id }) === null);
  check("float the last pane: no", applyDrop(pane(["solo"]), { kind: "tab", tabId: "x" }, { kind: "float", paneId: "nope" }) === null);
}
// several trees (floating windows)
{
  const main = row([pane(["A"]), pane(["B"])]);
  const fl = pane(["F"]);
  const [A, B] = panes(main);
  const r = applyDropForest([main, fl], { kind: "pane", paneId: A.id }, { kind: "side", targetId: fl.id, side: "left" });
  check("pane from main onto a window's edge splits the window", r && r.trees[0].type === "pane" && r.trees[1].type === "row" && r.trees[1].children.length === 2);
  const r2 = applyDropForest([main, fl], { kind: "tab", tabId: fl.tabs[0].id }, { kind: "tab", paneId: B.id, index: 1 });
  check("last tab out of a window closes it", r2 && r2.trees[1] === null && panes(r2.trees[0])[1].tabs.length === 2);
  const r3 = applyDropForest([pane(["solo"]), fl], { kind: "tab", tabId: fl.tabs[0].id }, { kind: "float", paneId: fl.id });
  check("floating a window's only pane again is a no-op", r3 === null);
  const solo = pane(["solo"]);
  const r4 = applyDropForest([solo, fl], { kind: "pane", paneId: solo.id }, { kind: "tab", paneId: fl.id, index: 1 });
  check("the main tree cannot be emptied", r4 === null);
  const r5 = applyDropForest([main], { kind: "external", node: row([pane(["X"]), pane(["Y"])]) }, { kind: "side", targetId: B.id, side: "right" });
  check("docking a split window inserts its whole tree", r5 && panes(r5.trees[0]).length === 4);
}
// scroll splits: always the root of a group tab
{
  const { normalizeTree } = await server.ssrLoadModule("/src/model.ts");
  const inGroup = (n) => n.type === "pane" && n.tabs.length === 1 && n.tabs[0].group && n.tabs[0].group.children[0];
  const sc = normalize(row([pane(["L"]), scrollColumn([pane(["only"])])]));
  check("a scroll-column in a row is wrapped in a group tab", inGroup(sc.children[1])?.type === "scroll-column");
  check("... titled after it", sc.children[1].tabs[0].title === "Scroll column");
  check("... and keeps a single child", inGroup(sc.children[1]).children.length === 1);
  const sc2 = normalizeTree(scrollColumn([column([pane(["a"]), pane(["b"])]), pane(["c"])]));
  check("a scroll-column at the root is wrapped too", inGroup(sc2)?.type === "scroll-column");
  check("a plain column inside it is still flattened", inGroup(sc2).children.length === 3);
  const again = normalizeTree(sc2);
  check("wrapping is idempotent", again === sc2 && inGroup(again).type === "scroll-column");
  const root3 = normalizeTree(row([pane(["L"]), scrollColumn([pane(["a"]), pane(["b"])])]));
  const [L, , a] = panes(root3);
  check("(pane order: L, holder, a)", a.tabs[0].title === "a");
  const res = applyDrop(root3, { kind: "tab", tabId: L.tabs[0].id }, { kind: "side", targetId: a.id, side: "bottom" });
  check("dropping below a cell inserts into the scroll-column", inGroup(res.root)?.children.length === 3);
  const res2 = applyDrop(root3, { kind: "tab", tabId: L.tabs[0].id }, { kind: "side", targetId: a.id, side: "left" });
  check("dropping left of a cell wraps it in a plain row", inGroup(res2.root)?.children[0].type === "row");
  const findType = (n, type) => n.type === type ? n : (n.type === "pane" ? n.tabs.map((t) => t.group) : n.children).filter(Boolean).map((c) => findType(c, type)).find(Boolean);
  const sc3b = findType(root3, "scroll-column");
  check("(sc3b is the scroll-column)", sc3b.type === "scroll-column");
  check("a scroll-column takes nothing on its left or right", ["left", "right"].every((side) => applyDrop(root3, { kind: "tab", tabId: L.tabs[0].id }, { kind: "side", targetId: sc3b.id, side }) === null));
  const titles = (r) => findType(r.root, "scroll-column").children.map((c) => c.tabs[0].title).join(",");
  const top = applyDrop(root3, { kind: "tab", tabId: L.tabs[0].id }, { kind: "side", targetId: sc3b.id, side: "top" });
  check("its top: first cell", top && titles(top) === "L,a,b");
  const bottom = applyDrop(root3, { kind: "tab", tabId: L.tabs[0].id }, { kind: "side", targetId: sc3b.id, side: "bottom" });
  check("its bottom: last cell", bottom && titles(bottom) === "a,b,L");
  check("beside its holder is fine", applyDrop(root3, { kind: "tab", tabId: L.tabs[0].id }, { kind: "side", targetId: root3.children[1].id, side: "right" }) !== null);
  // the whole scroll-column moves with its holder
  const holder = root3.children[1];
  const res3 = applyDrop(root3, { kind: "pane", paneId: holder.id }, { kind: "side", targetId: L.id, side: "left" });
  check("the holder (with its scroll-column) moves as a whole", res3.root.children[0].tabs?.[0].group?.children[0].type === "scroll-column");
}
await server.close();
{
  // A plain column's own sides: along its axis, into it (1/N of it); across, an enclosing row.
  const c = column([pane(["a"]), pane(["b"])]);
  const root4 = row([pane(["L"]), c, pane(["M"])]);
  const [L4] = panes(root4);
  const sub = { kind: "tab", tabId: L4.tabs[0].id };
  const top = applyDrop(root4, sub, { kind: "side", targetId: c.id, side: "top" });
  const col4 = top.root.children[0];
  check("column top: first child", col4.type === "column" && col4.children.map((x) => x.tabs[0].title).join(",") === "L,a,b");
  const w = col4.children.map((x) => x.weight);
  check("…taking 1/N of the column", Math.abs(w[0] - w[1]) < 1e-9 && Math.abs(w[1] - w[2]) < 1e-9);
  const lone = column([pane(["a"]), pane(["b"])]);
  const left = applyDrop(lone, { kind: "external", node: pane(["X"]) }, { kind: "side", targetId: lone.id, side: "left" });
  check("column left, at the root: an enclosing row", left.root.type === "row" && left.root.children[1].type === "column");
}
{
  // Spiral: row[1, column[2, …]]. Left of 1 halves 1; left of the row gives thirds.
  const one = pane(["1"]);
  const sp = row([one, column([pane(["2"]), pane(["3"])])]);
  const x = { kind: "external", node: pane(["5"]) };
  const ws = (r) => r.root.children.map((c) => c.weight.toFixed(2)).join(" ");
  const half = applyDrop(sp, x, { kind: "side", targetId: one.id, side: "left" });
  const third = applyDrop(sp, x, { kind: "side", targetId: sp.id, side: "left" });
  check(`left of 1: 5 and 1 share 1's half (${ws(half)})`, ws(half) === "0.75 0.75 1.50");
  check(`left of the row: thirds (${ws(third)})`, ws(third) === "1.00 1.00 1.00");
}
process.exit(fails ? 1 : 0);
