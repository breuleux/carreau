// Headless checks of Workspace logic (run through vite's SSR loader).
import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { Workspace } = await server.ssrLoadModule("/src/workspace.ts");
const { row, column, pane, serialize, panes, applyDropForest, scrollColumn, groupPane, normalizeTree } = await server.ssrLoadModule("/src/model.ts");
const { promptColumn, secondaryOf, submitPrompt, configurePrompts } = await server.ssrLoadModule("/src/prompt.ts");
const strip = (s) => s.replace(/"weight": [\d.e-]+/g, (m) => `"weight": ${(+m.split(": ")[1]).toFixed(6)}`);
let fails = 0;
const check = (name, ok) => { console.log(ok ? "ok  " : "FAIL", name); if (!ok) fails++; };

// row of rows collapses
{
  const ws = new Workspace(row([row([pane(["a"]), pane(["b"])]), row([pane(["c"]), pane(["d"])], 2)]));
  check("row of rows flattened", ws.root.type === "row" && ws.root.children.length === 4 && ws.root.children.every((c) => c.type === "pane"));
  { const w = ws.root.children.map((c) => c.weight); check("weight ratios preserved (rescaled to average 1)", Math.abs(w[0] / w[2] - 0.5) < 1e-9 && Math.abs(w[1] / w[3] - 0.5) < 1e-9 && Math.abs(w.reduce((a, b) => a + b) - 4) < 1e-9); }
  const ws2 = new Workspace(column([column([pane(["a"])]), pane(["b"])]));
  check("column of single column flattened", ws2.root.children.every((c) => c.type === "pane"));
}

// swap up/down & left/right restore
const build = () => column([row([pane(["U1"]), pane(["U2"])]), row([pane(["L"]), column([pane(["C"]), pane(["D"])]), pane(["R"])], 2)]);
for (const [a, b] of [["swapUp", "swapDown"], ["swapLeft", "swapRight"], ["swapRight", "swapLeft"], ["swapDown", "swapUp"]]) {
  const ws = new Workspace(build());
  const c = panes(ws.root).find((p) => p.tabs[0].title === "C");
  ws.select({ id: c.id });
  const before = strip(serialize(ws.root));
  ws.run(a);
  const mid = strip(serialize(ws.root));
  ws.run(b);
  check(`${a} then ${b} restores (changed in between: ${mid !== before})`, strip(serialize(ws.root)) === before && ws.selection.id === c.id);
}
// unexpand
{
  const ws = new Workspace(build());
  const c = panes(ws.root).find((p) => p.tabs[0].title === "C");
  ws.select({ id: c.id });
  ws.run("expandRight"); const s1 = JSON.stringify(ws.selection);
  ws.run("expandLeft");
  ws.run("expandUp");
  ws.run("unexpand"); ws.run("unexpand");
  check("unexpand twice returns to first expansion", JSON.stringify(ws.selection) === s1);
  ws.run("unexpand");
  check("unexpand back to pane", ws.selection.id === c.id && !ws.selection.range);
  ws.run("maximize"); ws.run("expandRight"); ws.run("unexpand");
  check("expand widens the maximization, unexpand doesn't narrow it", ws.maximized.id !== c.id || !!ws.maximized.range);
  ws.run("restore");
  ws.run("parent");
  check("parent when unmaximized does not maximize", ws.maximized === null);
}
// maximization: only the maximize command changes it; cleared at the top level
{
  // row[ L, column[ row[A, B], C ] ]
  const root = row([pane(["L"]), column([row([pane(["A"]), pane(["B"])]), pane(["C"])])]);
  const ws = new Workspace(root);
  const G = root.children[1]; // the column group
  ws.select({ id: G.id });
  ws.run("maximize");
  check("maximize a group", ws.maximized.id === G.id);
  ws.run("child"); ws.run("child");
  check("child, child: maximization unchanged", ws.maximized.id === G.id);
  ws.run("parent");
  check("child, child, parent: still the original group", ws.maximized.id === G.id && ws.node(ws.selection.id).type === "row");
  ws.run("parent");
  check("back on the group: still maximized", ws.maximized.id === G.id && ws.selection.id === G.id);
  ws.run("parent");
  check("parent reaches the top level: maximization cleared", ws.selection.id === root.id && ws.maximized === null);
  // row[ L, column[ row[A, B], C ] ] inside a wrapper column, so that G's parent isn't the root
  const root2 = column([row([pane(["L"]), column([row([pane(["A"]), pane(["B"])]), pane(["C"])])]), pane(["Z"])]);
  const ws2 = new Workspace(root2);
  const G2 = root2.children[0].children[1];
  const R2 = root2.children[0];
  ws2.select({ id: G2.children[0].id }); ws2.run("maximize");
  ws2.run("parent");
  check("parent above the maximized group widens it", ws2.maximized.id === G2.id);
  ws2.run("parent");
  check("parent again widens again", ws2.maximized.id === R2.id);
  ws2.run("child"); ws2.run("child");
  check("child, child don't narrow it", ws2.maximized.id === R2.id);
  ws2.select({ id: R2.children[0].id }); ws2.run("expandRight");
  check("expand within the maximized area doesn't change it", ws2.maximized.id === R2.id);
  ws2.run("unexpand");
  check("unexpand doesn't narrow it", ws2.maximized.id === R2.id);
  ws.select({ id: G.id }); ws.run("maximize");
  ws.select({ id: G.children[0].id });
  ws.toggleMaximize();
  check("M on a narrower selection maximizes it", ws.maximized?.id === G.children[0].id);
  ws.toggleMaximize();
  check("M on the maximized selection restores the previous view", ws.maximized?.id === G.id);
  ws.select({ id: root.id });
  ws.toggleMaximize();
  check("M at the top level clears", ws.maximized === null);
}
// undo / redo: layout changes only; consecutive resizes of one splitter coalesce
{
  const ws = new Workspace(row([pane(["A"]), column([pane(["B"]), pane(["C"])]), pane(["D"])]));
  const title = () => { const n = ws.node(ws.selection.id); return n.type === "pane" ? n.tabs[n.active].title : n.type; };
  const layout = () => JSON.stringify(ws.root, (k, v) => (k === "id" || k === "weight" || k === "active" ? undefined : v));
  const start = layout();
  ws.run("undo");
  check("undo with nothing to undo is harmless", title() === "A" && layout() === start);
  ws.run("focusRight");
  ws.run("maximize");
  ws.run("undo");
  check("navigation and maximize are not undo steps", title() === "C" && ws.maximized !== null);
  ws.run("restore");
  ws.run("swapUp");
  const swapped = layout();
  check("swapped C up", swapped !== start);
  ws.run("focusLeft"); ws.run("focusRight");
  ws.run("undo");
  check("undo swap (skipping navigation): layout back, selection as before the swap", layout() === start && title() === "C");
  ws.run("redo");
  check("redo swap", layout() === swapped && title() === "C");
  ws.run("undo");
  // a drag & drop move
  const [A, , , D] = panes(ws.root);
  const r = applyDropForest(ws.trees(), { kind: "pane", paneId: D.id }, { kind: "side", targetId: A.id, side: "left" });
  ws.commitDrop(r);
  check("moved D to the far left", panes(ws.root)[0].tabs[0].title === "D");
  ws.run("redo");
  check("a new step clears redo", panes(ws.root)[0].tabs[0].title === "D");
  ws.run("undo");
  check("undo the move", layout() === start);
  // resizes: same splitter coalesces, another splitter doesn't
  const weights = () => ws.root.children.map((c) => c.weight.toFixed(2)).join(",");
  const w0 = weights();
  const resize = (key, i, dw) => { const t = ws.beginResize(key); ws.root.children[i - 1].weight += dw; ws.root.children[i].weight -= dw; ws.endResize(t); };
  const k1 = `${ws.root.id}:1`, k2 = `${ws.root.id}:2`;
  resize(k1, 1, 0.1); ws.run("focusRight"); resize(k1, 1, 0.1); resize(k1, 1, 0.1);
  const w1 = weights();
  resize(k2, 2, 0.2);
  const w2 = weights();
  ws.run("undo");
  check("undo the other splitter's resize", weights() === w1);
  ws.run("undo");
  check("one undo reverts all consecutive resizes of a splitter", weights() === w0);
  ws.run("redo"); ws.run("redo");
  check("redo both", weights() === w2);
  // float & close tab
  ws.float(panes(ws.root)[1].id, { x: 0, y: 0, w: 300, h: 200 });
  ws.run("undo");
  check("undo float", ws.floating.length === 0 && panes(ws.root).length === 4);
  const nTabs = () => panes(ws.root).reduce((s, p) => s + p.tabs.length, 0);
  const n0 = nTabs();
  await ws.closeTab(panes(ws.root)[0].tabs[0].id);
  ws.run("undo");
  check("undo close tab", nTabs() === n0);
}
// groups
{
  const show = (n) => (n.type === "pane" ? n.tabs.map((t) => (t.group ? `${t.title}{${show(t.group.children[0])}}` : t.title)).join("+") : `${n.type}(${n.children.map(show).join(", ")})`);
  const ws = new Workspace(row([pane(["A"]), column([pane(["B"]), pane(["C"])]), pane(["D"])]));
  const col = ws.root.children[1];
  ws.select({ id: col.id });
  ws.group("stack");
  check("group a column", show(ws.root) === "row(A, stack{column(B, C)}, D)");
  const holder = ws.root.children[1];
  check("the holder pane takes the column's place and is selected", holder.type === "pane" && ws.selection.id === holder.id);
  // a tab dropped into the holder's tab bar: switch between the group and the tab
  const [A] = panes(ws.root);
  const r = applyDropForest(ws.trees(), { kind: "tab", tabId: A.tabs[0].id }, { kind: "tab", paneId: holder.id, index: 1 });
  ws.commitDrop(r);
  check("a tab joins the group's tab bar", show(ws.root) === "row(stack{column(B, C)}+A, D)");
  const h = ws.root.children[0];
  check("collapse needs a single group tab", !ws.canCollapse(h.id));
  // navigation into and out of the group
  h.active = 0;
  ws.select({ id: h.id }); ws.run("child");
  check("child of the holder: a pane of the group (its root column is skipped)", ["B", "C"].includes(ws.node(ws.selection.id).tabs?.[0].title));
  ws.run("parent");
  check("parent from inside the group: the holder", ws.selection.id === h.id);
  ws.select({ id: panes(ws.root).find((p) => p.tabs[0].title === "B").id });
  ws.run("focusRight");
  check("focus moves out of the group to D", ws.node(ws.selection.id).tabs[0].title === "D");
  ws.run("focusLeft");
  check("focus moves back into the group", ["B", "C"].includes(ws.node(ws.selection.id).tabs[0].title));
  // cycles: dropping the group tab (or its holder) into its own layout is not offered
  const B = panes(ws.root).find((p) => p.tabs[0].title === "B");
  check("a group tab can't go inside itself", applyDropForest(ws.trees(), { kind: "tab", tabId: h.tabs[0].id }, { kind: "side", targetId: B.id, side: "left" }) === null);
  check("its holder can't either", applyDropForest(ws.trees(), { kind: "pane", paneId: h.id }, { kind: "tab", paneId: B.id, index: 1 }) === null);
  // emptying a group removes its tab
  const C = panes(ws.root).find((p) => p.tabs[0].title === "C");
  ws.commitDrop(applyDropForest(ws.trees(), { kind: "pane", paneId: B.id }, { kind: "side", targetId: ws.root.children[1].id, side: "right" }));
  ws.commitDrop(applyDropForest(ws.trees(), { kind: "pane", paneId: C.id }, { kind: "side", targetId: ws.root.children[1].id, side: "right" }));
  check("a group emptied by drags disappears with its tab", show(ws.root) === "row(A, D, C, B)");
  // collapse; undo
  const ws2 = new Workspace(row([pane(["A"]), column([pane(["B"]), pane(["C"])])]));
  ws2.select({ id: ws2.root.id, range: [0, 0] }); // a range of one: just A
  ws2.select({ id: ws2.root.children[1].id });
  ws2.group("g");
  const before = show(ws2.root);
  ws2.collapse(ws2.root.children[1].id);
  check("collapse restores the layout", show(ws2.root) === "row(A, column(B, C))");
  ws2.run("undo");
  check("undo collapse", show(ws2.root) === before);
  ws2.run("undo");
  check("undo group", show(ws2.root) === "row(A, column(B, C))");
  // grouping a range, and a whole tree
  const ws3 = new Workspace(row([pane(["A"]), pane(["B"]), pane(["C"])]));
  ws3.select({ id: ws3.root.id, range: [1, 2] });
  ws3.group("bc");
  check("group a range", show(ws3.root) === "row(A, bc{row(B, C)})");
  ws3.select({ id: ws3.root.id });
  ws3.group("all");
  check("group the whole tree", show(ws3.root) === "all{row(A, bc{row(B, C)})}");
  ws3.select({ id: ws3.root.id });
  ws3.collapse();
  check("collapse the selected pane", show(ws3.root) === "row(A, bc{row(B, C)})");
  ws3.select({ id: panes(ws3.root).find((p) => p.tabs[0].title === "C").id });
  ws3.collapse();
  check("collapse from inside a group: the enclosing one", show(ws3.root) === "row(A, B, C)");
}
// a group's root split is skipped by parent/child (it's the same area as its holder's body)
{
  const ws = new Workspace(row([pane(["A"]), column([pane(["B"]), pane(["C"])])]));
  ws.select({ id: ws.root.children[1].id }); ws.group("Zazz");
  const zazz = ws.root.children[1];
  const inner = zazz.tabs[0].group.children[0];
  const [B, C] = inner.children;
  ws.select({ id: zazz.id }); ws.run("child");
  check("child of Zazz: straight into B or C", [B.id, C.id].includes(ws.selection.id));
  ws.select({ id: C.id }); ws.run("parent");
  check("parent of C: Zazz (skipping the B+C column)", ws.selection.id === zazz.id);
  ws.run("child");
  check("child again: back to C (last focused)", ws.selection.id === C.id);
  ws.run("expandUp");
  check("expand inside the group: the B+C range", ws.node(ws.selection.id).type === "column" || ws.selection.range);
  ws.run("parent");
  check("parent of a range in the group's root: Zazz", ws.selection.id === zazz.id);
  ws.run("parent");
  check("parent of Zazz: the main row", ws.selection.id === ws.root.id);
  // a group holding a single pane: child of the holder is that pane
  const ws2 = new Workspace(row([pane(["A"]), pane(["B"])]));
  ws2.select({ id: ws2.root.children[1].id }); ws2.group("solo");
  const h2 = ws2.root.children[1];
  ws2.select({ id: h2.id }); ws2.run("child");
  check("child of a holder of a single pane: that pane", ws2.node(ws2.selection.id).tabs[0].title === "B");
  ws2.run("parent");
  check("and back", ws2.selection.id === h2.id);
}
// Focus when closing a tab
{
  const byTitle = (ws, t) => [ws.root, ...ws.floating.map((w) => w.root)].flatMap((r) => panes(r)).find((p) => p.tabs.some((x) => x.title === t));
  const tabId = (ws, t) => byTitle(ws, t).tabs.find((x) => x.title === t).id;
  const focused = (ws) => { const n = ws.node(ws.selection.id); return n?.type === "pane" ? n.tabs[n.active].title : `(${n?.type})`; };
  const activate = (ws, t) => { const p = byTitle(ws, t); ws.activateTab(p.id, p.tabs.findIndex((x) => x.title === t)); };

  // a tab group: back to the previously activated tab
  let ws = new Workspace(row([pane(["a", "b", "c", "d"]), pane(["X"])]));
  activate(ws, "b"); activate(ws, "d"); activate(ws, "a"); activate(ws, "c");
  await ws.closeTab(tabId(ws, "c"));
  check(`tabs: closing the focused tab goes back to the previous one (a): ${focused(ws)}`, focused(ws) === "a");
  await ws.closeTab(tabId(ws, "a"));
  check(`…and again (d): ${focused(ws)}`, focused(ws) === "d");
  // not focused: nothing special
  activate(ws, "X");
  await ws.closeTab(tabId(ws, "b"));
  check(`closing a tab that hasn't the focus leaves it (X): ${focused(ws)}`, focused(ws) === "X");

  // a plain split: back to the previously focused child
  ws = new Workspace(row([pane(["A"]), pane(["B"]), pane(["C"]), pane(["D"])]));
  activate(ws, "D"); activate(ws, "A"); activate(ws, "C");
  await ws.closeTab(tabId(ws, "C"));
  check(`split: closing the focused pane goes back to the previous one (A): ${focused(ws)}`, focused(ws) === "A");
  // nested: the parent split picks a child, then down through what was focused in it
  ws = new Workspace(row([column([pane(["T"]), pane(["U"])]), pane(["V"]), pane(["W"])]));
  activate(ws, "U"); activate(ws, "T"); activate(ws, "W"); activate(ws, "V");
  await ws.closeTab(tabId(ws, "V"));
  check(`split: then down to the last focused pane (W): ${focused(ws)}`, focused(ws) === "W");
  await ws.closeTab(tabId(ws, "W"));
  check(`…then into the column, its last focused pane (T): ${focused(ws)}`, focused(ws) === "T");

  // a scroll column: the neighbour further from the sticky end
  const sc = () => row([pane(["side"]), scrollColumn([pane(["c1"]), pane(["c2"]), pane(["c3"])])]);
  ws = new Workspace(sc());
  activate(ws, "c3"); activate(ws, "c1"); activate(ws, "c2");
  await ws.closeTab(tabId(ws, "c2"));
  check(`scroll: the next cell (c3), not the previously focused one: ${focused(ws)}`, focused(ws) === "c3");
  await ws.closeTab(tabId(ws, "c3"));
  check(`scroll: at the far end, the other neighbour (c1): ${focused(ws)}`, focused(ws) === "c1");
  ws = new Workspace(sc());
  const scroll = (w) => w.root.children[1].tabs[0].group.children[0];
  ws.toggleReverse(scroll(ws).id);
  activate(ws, "c1"); activate(ws, "c2");
  await ws.closeTab(tabId(ws, "c2"));
  check(`sticky scroll: the cell before (c1): ${focused(ws)}`, focused(ws) === "c1");

  // a group: its last pane closing removes the group tab; the holder picks its previous tab
  ws = new Workspace(row([pane(["L"]), groupPane("grp", pane(["g1"]), 1)]));
  const holder = ws.root.children[1];
  holder.tabs.push({ id: "tother", title: "other" }, { id: "tthird", title: "third" });
  activate(ws, "third"); activate(ws, "other"); activate(ws, "grp"); activate(ws, "g1");
  await ws.closeTab(tabId(ws, "g1"));
  check(`group: the holder's previous tab (other): ${focused(ws)}`, focused(ws) === "other" && ws.selection.id === holder.id);
  // closing a group tab holding the focus
  ws = new Workspace(row([pane(["L"]), groupPane("grp", row([pane(["g1"]), pane(["g2"])]), 1)]));
  activate(ws, "L"); activate(ws, "g2");
  await ws.closeTab(ws.root.children[1].tabs[0].id);
  check(`closing the group holding the focus: back to L: ${focused(ws)}`, focused(ws) === "L");

  // a floating window closing: the previously selected pane elsewhere
  ws = new Workspace(row([pane(["M1"]), pane(["M2"]), pane(["F"])]));
  activate(ws, "M2"); activate(ws, "M1");
  ws.float(byTitle(ws, "F").id, { x: 0, y: 0, w: 100, h: 100 });
  activate(ws, "M2"); activate(ws, "F");
  await ws.closeTab(tabId(ws, "F"));
  check(`window closing: the previously selected pane (M2): ${focused(ws)} (${ws.floating.length} windows)`, focused(ws) === "M2" && ws.floating.length === 0);
}
// Async close: close() is awaited (the tab shows as closing), can refuse, can be forced
{
  const titles = (ws) => panes(ws.root).map((p) => p.tabs.map((t) => t.title).join("+")).join(" | ");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const pending = new Map(); // title -> {resolve, reject}
  const forced = [];
  const life = {
    closeTab: (t) => new Promise((resolve, reject) => pending.set(t.title, { resolve, reject })),
    forceCloseTab: async (t) => { forced.push(t.title); },
  };
  let ws = new Workspace(row([pane(["a", "b"]), pane(["c"])]));
  ws.lifecycle = life;
  const id = (t) => panes(ws.root).flatMap((p) => p.tabs).find((x) => x.title === t).id;
  const pa = ws.closeTab(id("a"));
  await tick();
  check("closing: the tab stays, marked as closing", titles(ws) === "a+b | c" && ws.isClosing(id("a")));
  check("closing it again is ignored", (await ws.closeTab(id("a"))) === false && pending.size === 1);
  pending.get("a").resolve();
  check("once close() resolves: removed", (await pa) === true && titles(ws) === "b | c" && !ws.isClosing(id("b")));
  const pb = ws.closeTab(id("b"));
  await tick();
  pending.get("b").reject(new Error("unsaved changes"));
  check("close() rejects: the tab stays", (await pb) === false && titles(ws) === "b | c" && !ws.isClosing(id("b")));
  // forcing: forceClose() called (not awaited), removed at once; the late resolve does nothing
  const pc = ws.closeTab(id("c"));
  await tick();
  const cid = id("c");
  check("force close: removed at once", ws.forceClose(cid) === true && titles(ws) === "b" && forced.join() === "c");
  pending.get("c").resolve();
  check("…and the original close then does nothing", (await pc) === false && titles(ws) === "b");

  // a group's close gathers its children's; a pane's, its tabs'
  pending.clear(); forced.length = 0;
  ws = new Workspace(row([pane(["L"]), groupPane("grp", row([pane(["g1", "g2"]), pane(["g3"])]), 1)]));
  ws.lifecycle = life;
  const grp = ws.root.children[1].tabs[0].id;
  const pg = ws.closeTab(grp);
  await tick();
  check(`group close: every tab in it is asked (${[...pending.keys()]})`, [...pending.keys()].sort().join() === "g1,g2,g3");
  pending.get("g1").resolve(); pending.get("g3").resolve();
  await tick();
  check("…and it waits for all of them", ws.isClosing(grp) && titles(ws).includes("grp"));
  pending.get("g2").resolve();
  check("…then it closes", (await pg) === true && titles(ws) === "L");

  pending.clear();
  ws = new Workspace(row([pane(["x", "y"]), pane(["z"])]));
  ws.lifecycle = life;
  const xp = ws.root.children[0];
  const pp = ws.closePane(xp.id);
  await tick();
  check("pane close: all its tabs closing", ws.isClosing(xp.tabs[0].id) && ws.isClosing(xp.tabs[1].id) && pending.size === 2);
  check("forcing from any of its tabs forces the whole pane", ws.forceClose(xp.tabs[1].id) === true && titles(ws) === "z" && forced.sort().join() === "c,x,y".replace("c,", ""));
  pending.get("x").resolve(); pending.get("y").resolve();
  check("…the original close does nothing more", (await pp) === false && titles(ws) === "z");
  check("the main tree's last pane can't be closed", (await ws.closePane(ws.root.id)) === false);
}
// cellAt: same as the shortcuts; placer
{
  const build = () => row([pane(["A"]), column([pane(["B"]), row([pane(["C"]), pane(["E"])])]), pane(["D"])]);
  const title = (ws, id) => { const n = id && ws.node(id); return !n ? "null" : n.type === "pane" ? n.tabs[0].title : n.type; };
  const byTitle = (ws, t) => panes(ws.root).find((p) => p.tabs.some((x) => x.title === t));
  const cmd = { left: "focusLeft", right: "focusRight", up: "focusUp", down: "focusDown", parent: "parent", child: "child" };
  const paths = [["right"], ["right", "down"], ["right", "down", "right"], ["right", "down", "parent"], ["right", "down", "parent", "parent"], ["right", "right"], ["right", "down", "right", "right", "left"], ["right", "up"]];
  let same = true;
  for (const path of paths) {
    const a = new Workspace(build()); const b = new Workspace(build());
    // same history on both
    for (const w of [a, b]) for (const t of ["E", "B", "A"]) w.select({ id: byTitle(w, t).id });
    const got = title(a, a.focused().cellAt(path)?.id);
    let fails = false;
    for (const d of path) { const before = JSON.stringify(b.selection); b.run(cmd[d]); if (JSON.stringify(b.selection) === before) fails = true; }
    const want = fails ? "null" : title(b, b.selection.id);
    if (got !== want) { same = false; console.log("   ", path.join(","), "cellAt:", got, "shortcuts:", want); }
  }
  check("cellAt matches the shortcuts", same);
  let ws = new Workspace(build());
  ws.select({ id: byTitle(ws, "A").id });
  const A = ws.focused();
  check("cellAt: off the edge is null", A.cellAt("left") === null && A.cellAt("up") === null);
  check("cellAt: an explicit cell, then moves from it", title(ws, A.cellAt([{ id: byTitle(ws, "C").id }, "right"])?.id) === "E");
  check("cellAt: doesn't move the focus", ws.selection.id === A.id);
  check("cellAt: child of the root (most recently focused)", title(ws, ws.cell(ws.root.id).cellAt("child")?.id) === "A");

  const titles = (ws) => { const show = (n) => (n.type === "pane" ? n.tabs.map((t) => t.title).join("+") : `${n.type}(${n.children.map(show).join(", ")})`); return show(ws.root); };
  // beside the focused cell
  let placed = ws.placer({ split: "right" }).apply({ id: "tN", title: "N" });
  check(`placer: a new tab beside the focused cell: ${titles(ws)}`, titles(ws) === "row(A, N, column(B, row(C, E)), D)" && title(ws, placed.id) === "N" && ws.selection.id === placed.id);
  // into the tabs of a cell found by a path
  ws = new Workspace(build()); ws.select({ id: byTitle(ws, "A").id });
  placed = ws.placer({ split: "tab", base: "right" }).apply({ id: "tN", title: "N" });
  check(`placer: into the tabs of the cell on the right: ${titles(ws)}`, titles(ws) === "row(A, column(B, row(C+N, E)), D)");
  // a split base: its most recently focused pane
  ws = new Workspace(build()); for (const t of ["E", "A"]) ws.select({ id: byTitle(ws, t).id });
  ws.placer({ split: "tab", base: ["right", "parent"] }).apply({ id: "tN", title: "N" });
  check(`placer: into a split's tabs = its last focused pane: ${titles(ws)}`, titles(ws) === "row(A, column(B, row(C, E+N)), D)");
  // the base doesn't exist
  ws = new Workspace(build()); ws.select({ id: byTitle(ws, "A").id });
  check("placer: no base, no force: nothing", ws.placer({ split: "right", base: "left" }).apply({ id: "tN", title: "N" }) === null && titles(ws) === "row(A, column(B, row(C, E)), D)");
  placed = ws.placer({ split: "right", base: "left", force: true }).apply({ id: "tN", title: "N" });
  check(`placer: forced: a new pane where the base would be: ${titles(ws)}`, titles(ws) === "row(N, A, column(B, row(C, E)), D)");
  { const w = ws.root.children.map((c) => c.weight.toFixed(2)).join(" "); check(`…taking 1/N of the row (${w})`, w === "1.00 1.00 1.00 1.00"); }
  ws = new Workspace(build()); ws.select({ id: byTitle(ws, "B").id });
  ws.placer({ split: "tab", base: "up", force: true }).apply({ id: "tN", title: "N" });
  check(`placer: forced, up from B: above the first parent taking it (the column): ${titles(ws)}`, titles(ws) === "row(A, column(N, B, row(C, E)), D)");
  ws = new Workspace(build()); ws.select({ id: ws.root.id });
  ws.placer({ split: "bottom", base: "parent", force: true }).apply({ id: "tN", title: "N" });
  check(`placer: forced, no parent: on the split's side of the root: ${titles(ws)}`, titles(ws) === "column(row(A, column(B, row(C, E)), D), N)");
  // moving what's already there; not focusing
  ws = new Workspace(build()); ws.select({ id: byTitle(ws, "A").id });
  const dId = byTitle(ws, "D").id;
  placed = ws.placer({ split: "bottom", focus: false }).apply(ws.cell(dId));
  check(`placer: moves an existing pane, focus stays: ${titles(ws)}`, titles(ws) === "row(column(A, D), column(B, row(C, E)))" && title(ws, ws.selection.id) === "A" && placed.id === dId);
  const cTab = byTitle(ws, "C").tabs[0];
  ws.placer({ split: "tab" }).apply(cTab);
  check(`placer: moves an existing tab: ${titles(ws)}`, titles(ws) === "row(column(A+C, D), column(B, E))");
  check("placer: undoable", (ws.undo(), titles(ws) === "row(column(A, D), column(B, row(C, E)))"));
}
// spawn: the focused cell decides what the new cell is
{
  const ws = new Workspace(row([pane(["A"]), pane(["B"])]));
  const froms = [];
  ws.lifecycle = { ...ws.lifecycle, spawn: (from) => (froms.push(from.title), { id: "t" + froms.length, title: `${from.title}'` }) };
  ws.select({ id: ws.root.children[0].id });
  const show = (n) => (n.type === "pane" ? n.tabs.map((t) => t.title).join("+") : `${n.type}(${n.children.map(show).join(", ")})`);
  ws.spawn({ split: "bottom" });
  check(`spawn: made by the focused cell, placed below it: ${show(ws.root)}`, show(ws.root) === "row(column(A, A'), B)" && froms.join() === "A");
  ws.spawn({ split: "tab", base: "right", force: true });
  check(`spawn into the tabs on the right: made by the focused cell (A'), not the base: ${show(ws.root)}`, show(ws.root) === "row(column(A, A'), B+A'')" && froms.join() === "A,A'");
  ws.lifecycle = { ...ws.lifecycle, spawn: () => null };
  check("spawn: a cell can create none", ws.spawn({ split: "bottom" }) === null);
}
// moveTab: the focused tab, placed like a new cell would be
{
  const ws = new Workspace(row([pane(["A", "A2"]), pane(["B"])]));
  const show = (n) => (n.type === "pane" ? n.tabs.map((t) => t.title).join("+") : `${n.type}(${n.children.map(show).join(", ")})`);
  ws.activateTab(ws.root.children[0].id, 1);
  ws.moveTab({ split: "bottom" });
  check(`moveTab: below its pane: ${show(ws.root)}`, show(ws.root) === "row(column(A, A2), B)" && ws.node(ws.selection.id).tabs[0].title === "A2");
  ws.moveTab({ split: "tab", base: "right", force: true });
  check(`moveTab: into the tabs on the right: ${show(ws.root)}`, show(ws.root) === "row(A, B+A2)");
  ws.select({ id: ws.root.children[0].id });
  check("moveTab: a lone tab beside its own pane: nothing", ws.moveTab({ split: "bottom" }) === null && show(ws.root) === "row(A, B+A2)");
}
// Prompt columns
{
  const build = () => row([pane(["L"]), promptColumn([pane(["c1"]), pane(["c2"]), pane(["c3"])])]);
  const col = (ws) => ws.root.children[1].tabs[0].group.children[0];
  const show = (n) => (n.type === "pane" ? n.tabs.map((t) => (t.group ? `${t.title}{${show(t.group.children[0])}}` : t.title)).join("+") : n.type === "prompt" ? "⏎" : `${n.type}(${n.children.map(show).join(", ")})`);
  const titleOf = (ws, id) => { const n = id && ws.node(id); return !n ? "null" : n.type === "pane" ? n.tabs[n.active].title : n.type; };
  let ws = new Workspace(build());
  check(`prompt-column: wrapped in a holder, prompt last: ${show(ws.root)}`, show(ws.root) === "row(L, Prompt{prompt-column(c1, c2, c3, ⏎)})");
  check("a prompt outside a prompt-column goes", show(normalizeTree(row([pane(["a"]), { type: "prompt", id: "qx", weight: 1 }]))) === "a");
  const prompt = () => col(ws).children[col(ws).children.length - 1];
  const byTitle = (t) => panes(ws.root).find((p) => p.tabs.some((x) => x.title === t));
  // drops
  const L = { kind: "tab", tabId: byTitle("L").tabs[0].id };
  const atEnd = ws.tryDrop(L, { kind: "side", targetId: col(ws).id, side: "bottom" });
  check(`dropping at the column's end: just above the prompt: ${atEnd && show(atEnd.trees[0])}`, atEnd && show(atEnd.trees[0]) === "Prompt{prompt-column(c1, c2, c3, L, ⏎)}");
  check("nothing beside, into, or swapped with the prompt", ["left", "right", "top", "bottom"].every((side) => !ws.tryDrop(L, { kind: "side", targetId: prompt().id, side })) && !ws.tryDrop(L, { kind: "tab", paneId: prompt().id, index: 0 }) && !ws.tryDrop(L, { kind: "swap", paneId: prompt().id }));
  check("nor after it", show(ws.tryDrop(L, { kind: "between", splitId: col(ws).id, index: 4 }).trees[0]) === "Prompt{prompt-column(c1, c2, c3, L, ⏎)}");
  // navigation
  ws.select({ id: byTitle("c3").id });
  ws.run("focusDown");
  check("↓ from the last cell: the prompt", ws.selection.id === prompt().id);
  check(`its secondary focus: the cell above (${titleOf(ws, secondaryOf(ws, prompt().id))})`, titleOf(ws, secondaryOf(ws, prompt().id)) === "c3" && titleOf(ws, ws.operand().id) === "c3");
  ws.run("focusUp");
  check("↑ from the prompt: the last cell", titleOf(ws, ws.selection.id) === "c3");
  ws.run("focusDown");
  // operations from the prompt act on the secondary focus; the focus stays on the prompt
  const p = prompt().id;
  ws.run("swapUp");
  check(`swap from the prompt: the cell above moves: ${show(col(ws))}`, show(col(ws)) === "prompt-column(c1, c3, c2, ⏎)" && ws.selection.id === p);
  ws.undo();
  check("…undone in one step, focus back on the prompt", show(col(ws)) === "prompt-column(c1, c2, c3, ⏎)" && ws.selection.id === p);
  await ws.closeTab(byTitle("c3").tabs[0].id);
  check(`closing the secondary focus: focus stays on the prompt, the next cell above is secondary: ${show(col(ws))}`, show(col(ws)) === "prompt-column(c1, c2, ⏎)" && ws.selection.id === p && titleOf(ws, secondaryOf(ws, p)) === "c2");
  ws.moveTab({ split: "tab", base: "left", force: true });
  check(`move from the prompt: the secondary's tab goes: ${show(ws.root)}`, show(ws.root) === "row(L+c2, Prompt{prompt-column(c1, ⏎)})" && ws.selection.id === p);
  ws.lifecycle = { ...ws.lifecycle, spawn: (from) => ({ id: "tsp", title: from.title + "'" }) };
  ws.spawn({ split: "bottom" });
  check(`insert from the prompt: made by and placed after the secondary: ${show(col(ws))}`, show(col(ws)) === "prompt-column(c1, c1', ⏎)" && ws.selection.id === p);
  check("group from the prompt groups the secondary, then selects it", ws.group("g") && titleOf(ws, ws.selection.id) === "g" && show(col(ws)) === "prompt-column(c1, g{c1'}, ⏎)");
  // submitting
  ws.select({ id: p });
  configurePrompts(ws, { submit: (text) => ({ id: "tq", title: text }) });
  submitPrompt(ws, p, "hello");
  check(`submit: a new cell above the prompt, focus unchanged: ${show(col(ws))}`, show(col(ws)) === "prompt-column(c1, g{c1'}, hello, ⏎)" && ws.selection.id === p);
  // closing every cell: the prompt stays; closing the only cell with the focus: the prompt
  ws = new Workspace(row([pane(["L"]), promptColumn([pane(["only"])])]));
  ws.select({ id: byTitle("only").id });
  await ws.closeTab(byTitle("only").tabs[0].id);
  check(`last cell closed: the prompt stays and gets the focus: ${show(ws.root)}`, show(ws.root) === "row(L, Prompt{prompt-column(⏎)})" && ws.node(ws.selection.id)?.type === "prompt");
  check("an empty prompt has no secondary focus; operations do nothing", ws.operand() === null && (ws.run("swapLeft"), show(ws.root) === "row(L, Prompt{prompt-column(⏎)})"));
}
// Prompt columns: maximizing from the prompt maximizes its secondary focus, which gets the focus
{
  const ws = new Workspace(row([pane(["L"]), promptColumn([pane(["c1"]), pane(["c2"])])]));
  const col = ws.root.children[1].tabs[0].group.children[0];
  const prompt = col.children[col.children.length - 1];
  const c2 = col.children[1];
  ws.select({ id: prompt.id });
  ws.toggleMaximize();
  check("maximize from the prompt: the secondary focus is maximized, and focused", ws.maximized?.id === c2.id && !ws.maximized.range && ws.selection.id === c2.id);
  ws.toggleMaximize();
  check("…toggled again (from it): restored", ws.maximized === null && ws.selection.id === c2.id);
  ws.select({ id: prompt.id });
  ws.run("maximize");
  check("the maximize command too", ws.maximized?.id === c2.id && ws.selection.id === c2.id);
  const empty = new Workspace(row([pane(["L"]), promptColumn([])]));
  const q = empty.root.children[1].tabs[0].group.children[0].children[0];
  empty.select({ id: q.id });
  empty.toggleMaximize();
  check("an empty prompt: maximizing does nothing", empty.maximized === null && empty.selection.id === q.id);
  const plain = new Workspace(row([pane(["A"]), pane(["B"])]));
  plain.select({ id: plain.root.children[1].id });
  plain.toggleMaximize();
  check("other cells still maximize themselves", plain.maximized?.id === plain.root.children[1].id);
}
// Tab complexes (merging), generic: a test complex type records what it's told
{
  const { registerComplex, shownIndex, shape } = await server.ssrLoadModule("/src/model.ts");
  const calls = [];
  registerComplex("t", {
    changed: (_f, c, ch) => calls.push(`changed ${c.tabs.map((t) => t.title).join("+")} in:${ch.entered.map((t) => t.title).join(",")} out:${ch.left.map((t) => t.title).join(",")}`),
    closing: (_f, c, tab) => calls.push(`closing ${tab.title} of ${c.tabs.map((t) => t.title).join("+")}`),
  });
  const kt = (title, key = "t") => ({ id: "t" + title, title, key });
  const ws = new Workspace(row([pane([kt("A"), kt("N", null)]), pane([kt("B")]), pane([kt("C")]), pane([kt("X", "other")])]));
  const tabsOf = () => ws.root.children.map((p) => shape(p).replace(/^\[|\]$/g, "")).join(" | ");
  check("merge with an unmergeable tab, or another key: refused", !ws.tryDrop({ kind: "tab", tabId: "tB" }, { kind: "merge", tabId: "tN" }) && !ws.tryDrop({ kind: "tab", tabId: "tB" }, { kind: "merge", tabId: "tX" }));
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: "tB" }, { kind: "merge", tabId: "tA" }));
  check(`merge B onto A: B just after A, linked; its pane gone: ${tabsOf()}`, tabsOf() === "tA+tB,tN | tC | tX");
  check(`  told: ${calls.join("; ")}`, calls.join("; ") === "changed A+B in:A,B out:");
  check("  B focused; the complex shows A's body", ws.root.children[0].active === 1 && shownIndex(ws.root.children[0]) === 0);
  check("merge B onto A again: nothing (already merged)", !ws.tryDrop({ kind: "tab", tabId: "tB" }, { kind: "merge", tabId: "tA" }));
  calls.length = 0;
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: "tC" }, { kind: "merge", tabId: "tA" }));
  check(`C onto A: between A and B: ${tabsOf()} (${calls.join("; ")})`, tabsOf() === "tA+tC+tB,tN | tX" && calls.join("; ") === "changed A+C+B in:C out:");
  calls.length = 0;
  const link = () => ws.root.children[0].tabs[0].link;
  check("a plain tab between two members: refused (it would break the complex)", !ws.tryDrop({ kind: "tab", tabId: "tN" }, { kind: "tab", paneId: ws.root.children[0].id, index: 1 }) && !ws.tryDrop({ kind: "tab", tabId: "tA" }, { kind: "tab", paneId: ws.root.children[0].id, index: 2 }));
  check("joining a complex it can't merge with: refused", !ws.tryDrop({ kind: "tab", tabId: "tN" }, { kind: "tab", paneId: ws.root.children[0].id, index: 1, join: link() }));
  calls.length = 0; // (the refused drops above were computed: their previews told the type too)
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: "tA" }, { kind: "tab", paneId: ws.root.children[0].id, index: 2, join: link() }));
  check(`reorder within the complex (A after C, joining it there): still merged: ${tabsOf()} (${calls.join("; ")})`, tabsOf() === "tC+tA+tB,tN | tX" && calls.join("; ") === "changed C+A+B in: out:");
  calls.length = 0;
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: "tB" }, { kind: "tab", paneId: ws.root.children[0].id, index: 0, join: link() }));
  check(`B to the complex's start, joining it there: ${tabsOf()}`, tabsOf() === "tB+tC+tA,tN | tX");
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: "tA" }, { kind: "tab", paneId: ws.root.children[0].id, index: 3 }));
  check(`A as a plain tab right after the complex: out of it, in the same pane: ${tabsOf()}`, tabsOf() === "tB+tC,tA,tN | tX");
  ws.undo();
  ws.undo();
  check(`(undone twice: ${tabsOf()})`, tabsOf() === "tC+tA+tB,tN | tX");
  calls.length = 0;
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: "tA" }, { kind: "side", targetId: ws.root.children[1].id, side: "right" }));
  check(`drag A out: it leaves: ${tabsOf()} (${calls.join("; ")})`, tabsOf() === "tC+tB,tN | tX | tA" && calls.join("; ") === "changed C+B in: out:A");
  calls.length = 0;
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: "tA" }, { kind: "merge", tabId: "tB" }));
  await ws.closeTab("tC");
  check(`close C (of C+B+A): told first, it leaves, then closes: ${tabsOf()} (${calls.join("; ")})`, tabsOf() === "tB+tA,tN | tX" && calls.join("; ") === "changed C+B+A in:A out:; closing C of C+B+A; changed B+A in: out:C");
  calls.length = 0;
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: "tA" }, { kind: "tab", paneId: ws.root.children[0].id, index: 3 }));
  check(`A to the end, past N: the complex dissolves, B alone again: ${tabsOf()} (${calls.join("; ")})`, tabsOf() === "tB,tN,tA | tX" && calls.join("; ") === "changed B in: out:A" && !ws.root.children[0].tabs.some((t) => t.link));
  ws.undo();
  check("undo: merged again", tabsOf() === "tB+tA,tN | tX");
}
// Dragging a whole complex (by its link icon): a block of tabs, staying merged
{
  const { shape } = await server.ssrLoadModule("/src/model.ts");
  const kt = (title, key = "t") => ({ id: "t" + title, title, key });
  const ws = new Workspace(row([pane([kt("A"), kt("B"), kt("N", null)]), pane([kt("C"), kt("D")]), pane([kt("E")])]));
  const tabsOf = () => [ws.root, ...ws.floating.map((w) => w.root)].map((t) => shape(t).replace(/\[|\]|row|\(|\)/g, "")).join(" ; ");
  const merge = (a, b) => ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: "t" + a }, { kind: "merge", tabId: "t" + b }));
  merge("B", "A");
  merge("D", "C");
  const P = () => panes(ws.root);
  const linkOf = (title) => P().flatMap((p) => p.tabs).find((t) => t.title === title).link;
  const cx = { kind: "complex", link: linkOf("A") };
  check(`two complexes: ${tabsOf()}`, tabsOf() === "tA+tB,tN tC+tD tE");
  check("a complex swaps with nothing; nor goes into itself", !ws.tryDrop(cx, { kind: "swap", paneId: P()[2].id }) && !ws.tryDrop(cx, { kind: "tab", paneId: P()[0].id, index: 1 }));
  ws.commitDrop(ws.tryDrop(cx, { kind: "side", targetId: P()[2].id, side: "right" }));
  check(`A+B beside E: a new pane, still merged; N stays: ${tabsOf()}`, tabsOf() === "tN tC+tD tE tA+tB");
  ws.undo();
  ws.commitDrop(ws.tryDrop(cx, { kind: "tab", paneId: P()[2].id, index: 1 }));
  check(`A+B into E's tabs, after E: still merged: ${tabsOf()}`, tabsOf() === "tN tC+tD tE,tA+tB");
  ws.undo();
  ws.commitDrop(ws.tryDrop(cx, { kind: "tab", paneId: P()[1].id, index: 2, join: linkOf("C") }));
  check(`A+B joining C+D at its end: one complex: ${tabsOf()}`, tabsOf() === "tN tC+tD+tA+tB tE");
  ws.undo();
  ws.commitDrop(ws.tryDrop(cx, { kind: "merge", tabId: "tC" }));
  check(`A+B merged onto C: just after it: ${tabsOf()}`, tabsOf() === "tN tC+tA+tB+tD tE" && P()[1].tabs[P()[1].active].title === "B");
  ws.undo();
  ws.commitDrop(ws.tryDrop(cx, { kind: "float", paneId: P()[0].id }), undefined, { x: 10, y: 10, w: 200, h: 100 });
  check(`A+B floated (over its own pane): still merged: ${tabsOf()}`, tabsOf() === "tN tC+tD tE ; tA+tB");
}
// Next/previous tab from a lone tab in a group: up to the first pane with several tabs
{
  const { groupPane } = await server.ssrLoadModule("/src/model.ts");
  const inner = groupPane("G", column([pane(["x"]), pane(["y"])]), 1);
  inner.tabs.push({ id: "tH", title: "H", group: { type: "slot", id: "sH", weight: 1, children: [pane(["h1"])] } }, { id: "tT", title: "T" });
  const ws = new Workspace(row([inner, pane(["other"])]));
  const P = ws.root.children[0];
  const byTitle = (t) => panes(ws.root).find((p) => p.tabs.some((x) => x.title === t));
  ws.select({ id: byTitle("x").id });
  ws.run("nextTab");
  check(`from x (alone in its pane, in group G): the holder's next tab, H, and the focus into it (${ws.node(ws.selection.id)?.tabs?.[0].title})`, P.tabs[P.active].title === "H" && ws.selection.id === byTitle("h1").id);
  ws.run("nextTab");
  check("again (from h1): T, a content tab: the holder is focused", P.tabs[P.active].title === "T" && ws.selection.id === P.id);
  ws.run("prevTab");
  check("back (from the holder itself, which has several tabs): H, focus unchanged", P.tabs[P.active].title === "H" && ws.selection.id === P.id);
  ws.select({ id: byTitle("other").id });
  ws.run("nextTab");
  check("a lone tab outside any group: nothing", ws.selection.id === byTitle("other").id && P.tabs[P.active].title === "H");
}
// Tab complexes: merging prompt-columns
{
  const { groupPane } = await server.ssrLoadModule("/src/model.ts");
  // Two prompt-columns with known orders: a1 (1), a2 (3) | b1 (2).
  const cellP = (t, order) => ({ p: pane([t]), order });
  const col = (title, cells) => {
    const c = promptColumn(cells.map((x) => x.p));
    c.cells = Object.fromEntries(cells.map((x) => [x.p.id, { order: x.order }]));
    return groupPane(title, c, 1);
  };
  let ws = new Workspace(row([col("Ann", [cellP("a1", 1), cellP("a2", 3)]), col("Bob", [cellP("b1", 2)])]));
  const tabId = (title) => panes(ws.root).flatMap((p) => p.tabs).find((t) => t.title === title).id;
  const colOf = (title) => panes(ws.root).flatMap((p) => p.tabs).find((t) => t.title === title).group.children[0];
  const cellsOf = (title) => colOf(title).children.filter((c) => c.type !== "prompt").map((c) => c.tabs[0].title).join(",");
  const promptOf = (title) => colOf(title).children.at(-1).id;
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: tabId("Bob") }, { kind: "merge", tabId: tabId("Ann") }));
  check(`merged: all the cells in the first's column, interleaved: Ann: ${cellsOf("Ann")} | Bob: ${cellsOf("Bob")}`, cellsOf("Ann") === "a1,b1,a2" && cellsOf("Bob") === "");
  // Bob is the complex's active member: what he types comes from him.
  configurePrompts(ws, { submit: (text) => ({ id: "t" + text, title: text }) });
  submitPrompt(ws, promptOf("Ann"), "b2");
  check(`typing as Bob (active): ${cellsOf("Ann")}`, cellsOf("Ann") === "a1,b1,a2,b2" && colOf("Ann").cells[panes(ws.root).find((p) => p.tabs[0].title === "b2").id].origin === tabId("Bob"));
  // Reorder by hand: b2 to the top; it keeps that place.
  const b2 = panes(ws.root).find((p) => p.tabs[0].title === "b2").id;
  ws.commitDrop(ws.tryDrop({ kind: "pane", paneId: b2 }, { kind: "between", splitId: colOf("Ann").id, index: 0 }));
  check(`b2 moved to the top by hand: ${cellsOf("Ann")}`, cellsOf("Ann") === "b2,a1,b1,a2");
  // Bob leaves: his cells go back with him, in their order.
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: tabId("Bob") }, { kind: "side", targetId: ws.root.id, side: "right" }));
  check(`Bob dragged out: Ann: ${cellsOf("Ann")} | Bob: ${cellsOf("Bob")}`, cellsOf("Ann") === "a1,a2" && cellsOf("Bob") === "b2,b1");
  // Merged again (the other way): into Bob's column.
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: tabId("Ann") }, { kind: "merge", tabId: tabId("Bob") }));
  check(`Ann onto Bob: Bob's column first: Bob: ${cellsOf("Bob")} | Ann: ${cellsOf("Ann")}`, cellsOf("Bob") === "b2,a1,b1,a2" && cellsOf("Ann") === "");
  // Reordered: Ann first, so her column shows them all.
  const pair = panes(ws.root).find((p) => p.tabs.length === 2);
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: tabId("Ann") }, { kind: "tab", paneId: pair.id, index: 0, join: pair.tabs[0].link }));
  check(`Ann moved first in the complex: Ann: ${cellsOf("Ann")} | Bob: ${cellsOf("Bob")}`, cellsOf("Ann") === "b2,a1,b1,a2" && cellsOf("Bob") === "");
  // Closing Bob (transfer, the default): his cells stay, as Ann's.
  await ws.closeTab(tabId("Bob"));
  check(`Bob closed: his cells stay with Ann: ${cellsOf("Ann")}`, cellsOf("Ann") === "b2,a1,b1,a2" && !panes(ws.root).some((p) => p.tabs.some((t) => t.title === "Bob")) && !panes(ws.root).some((p) => p.tabs.some((t) => t.link)));
  // mergedClose: "close": the cells go with their tab.
  ws = new Workspace(row([col("Ann", [cellP("a1", 1)]), col("Bob", [cellP("b1", 2)])]));
  configurePrompts(ws, { mergedClose: "close" });
  ws.commitDrop(ws.tryDrop({ kind: "tab", tabId: tabId("Bob") }, { kind: "merge", tabId: tabId("Ann") }));
  await ws.closeTab(tabId("Ann"));
  check(`mergedClose "close": Ann closed (the first, holding everything), her cells with her: Bob: ${cellsOf("Bob")}`, cellsOf("Bob") === "b1" && !panes(ws.root).some((p) => p.tabs.some((t) => t.title === "a1")));
}
await server.close();
process.exit(fails ? 1 : 0);
