import { column, genId, LayoutNode, pane, row, scrollColumn, scrollRow, Tab } from "../src/model";

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

/** A tab with some text content: `paragraphs` paragraphs, or explicit lines. */
export function t(title: string, paragraphs: number | string[]): Tab {
  const content =
    typeof paragraphs === "number"
      ? Array.from({ length: paragraphs }, () => LOREM).join("\n\n")
      : paragraphs.join("\n");
  return { id: genId("t"), title, content };
}

/** Lines of varying lengths, for naturally sized widths. */
function lines(n: number, width: number): string[] {
  return Array.from({ length: n }, (_, i) => `${i + 1}. ${"·".repeat(Math.max(1, Math.round(width * (0.6 + 0.4 * Math.sin(i)))))}`);
}

/** A self-contained page with visible state, to see whether an iframe got reloaded. */
const STATEFUL = `<!doctype html><html><body style="font:14px system-ui;color:#ddd;background:#16171c;margin:12px">
<div>Loaded <b id="age">0</b>s ago</div>
<p><button id="b" style="font-size:16px">Clicked <span id="n">0</span> times</button></p>
<p><input placeholder="type something" style="width:90%;font-size:14px"></p>
<script>
const t0 = Date.now(); let n = 0;
setInterval(() => (document.getElementById("age").textContent = Math.round((Date.now() - t0) / 1000)), 250);
document.getElementById("b").onclick = () => (document.getElementById("n").textContent = ++n);
</script></body></html>`;

export function youtube(title: string, id: string, height?: number): Tab {
  return { id: genId("t"), title, data: { youtube: id, ...(height ? { height } : {}) } };
}

export function stateful(title: string, height?: number): Tab {
  return { id: genId("t"), title, data: { srcdoc: STATEFUL, ...(height ? { height } : {}) } };
}

export interface Example {
  name: string;
  description: string;
  build: () => LayoutNode;
}

/** A notebook cell: icon, short name, long (the command or prompt behind it), accent, status. */
export function cell(
  short: string,
  icon: string,
  long: string,
  accent: string,
  status: string | undefined,
  content: string,
): Tab {
  return { id: genId("t"), title: short, short, icon, long, accent, status, content };
}

export const SHELL = `<span style="font:600 12px ui-monospace,monospace">$</span>`;
export const PROMPT = "✦";

export const examples: Example[] = [
  {
    name: "Notebook",
    description:
      "Cells in a scroll column show their command or prompt on top and hide a lone tab. Tab icons show statuses: done (faded), error (red), unresponsive (blinking).",
    build: () =>
      row([
        pane(
          [
            { id: genId("t"), title: "Sessions", icon: "☰" },
            { id: genId("t"), title: "build", icon: SHELL, status: "unresponsive", accent: "oklch(0.78 0.13 75)" },
            { id: genId("t"), title: "tests", icon: SHELL, status: "error", accent: "oklch(0.72 0.15 25)" },
            { id: genId("t"), title: "deploy", icon: SHELL, status: "done", accent: "oklch(0.75 0.12 160)" },
          ],
          1,
        ),
        scrollColumn(
          [
            pane([cell("ls", SHELL, "$ ls -la ~/projects/carreau", "oklch(0.75 0.12 160)", "done",
              ["total 48", "drwxr-xr-x  src/", "drwxr-xr-x  testscripts/", "-rw-r--r--  design.md", "-rw-r--r--  package.json"].join("\n"))]),
            pane([cell("Explain", PROMPT, "Explain what normalizeTree does, in two sentences.", "oklch(0.72 0.13 300)", undefined,
              "It normalizes a whole layout tree, then wraps a root scroll split in a group tab. Scroll splits thereby always live in a tab, so they can be moved around as a whole.")]),
            pane([cell("make test", SHELL, "$ make test", "oklch(0.72 0.15 25)", "error",
              ["running 63 checks…", "FAIL weights preserved", "  expected 0.5,0.5,1,1", "make: *** [test] Error 1"].join("\n"))]),
            row([
              pane([cell("du", SHELL, "$ du -sh node_modules", "oklch(0.75 0.11 230)", "done", "41M\tnode_modules")]),
              pane([cell("ssh", SHELL, "$ ssh build-box", "oklch(0.78 0.13 75)", "unresponsive", "(no response for 2 minutes)")]),
            ]),
            pane([
              cell("Draft", PROMPT, "Draft release notes for the cells feature.", "oklch(0.72 0.13 300)", undefined,
                "Cells now carry an icon, a short name, a long description, an accent and a status."),
              cell("Shorter", PROMPT, "Make it shorter.", "oklch(0.72 0.13 300)", "done", "Cells: icons, statuses, accents, and their command on top."),
            ]),
            pane([cell("git log", SHELL, "$ git log --oneline -3", "oklch(0.75 0.12 160)", "done",
              ["b112feb Navigation improvements", "d258bdb Add design document", "8ee3113 Improvements"].join("\n"))]),
          ],
          3,
        ),
      ]),
  },
  {
    name: "Embeds",
    description:
      "Start a video, type in a counter page, then move tabs and panes around, switch tabs, maximize: nothing should reload.",
    build: () =>
      row([
        column(
          [
            pane([youtube("Big Buck Bunny", "aqz-KE-bpKQ"), youtube("Me at the zoo", "jNQXAC9IVRw")], 3),
            pane([stateful("Counter A"), t("Notes", 1)], 2),
          ],
          3,
        ),
        scrollColumn(
          [
            pane([t("About", ["Cells in this scroll-column hold embeds too.", "Scroll, then drag them around."])]),
            pane([youtube("Video cell", "jNQXAC9IVRw", 220)]),
            pane([stateful("Counter B", 160)]),
            pane([t("Filler", 3)]),
          ],
          2,
        ),
      ]),
  },
  {
    name: "IDE",
    description: "Sidebar, editor with tabs over a terminal, outline on the right.",
    build: () =>
      row([
        pane(["Files", "Search", "Git"], 1),
        column(
          [pane(["main.ts", "model.ts", "view.ts", "README.md"], 3), pane(["Terminal", "Problems"], 1)],
          4,
        ),
        pane(["Outline"], 1.2),
      ]),
  },
  {
    name: "Deep nesting",
    description:
      "Row ⊃ column ⊃ row ⊃ column: hover the top-left pane while dragging to see four nested left indicators.",
    build: () =>
      row([
        column([
          row([column([pane(["A"]), pane(["B"])]), pane(["C"])], 2),
          pane(["D"]),
        ], 2),
        pane(["E"]),
      ]),
  },
  {
    name: "Grid 3×3",
    description: "Three columns of three panes each.",
    build: () =>
      row(
        [0, 1, 2].map((c) =>
          column([0, 1, 2].map((r) => pane([`${String.fromCharCode(65 + c)}${r + 1}`]))),
        ),
      ),
  },
  {
    name: "Uneven",
    description: "Wildly different weights: thin strips and a large main area.",
    build: () =>
      column([
        pane(["Toolbar"], 0.4),
        row(
          [
            pane(["Narrow"], 0.5),
            column([pane(["Main", "Docs", "Logs"], 5), pane(["Status"], 0.6)], 6),
            column([pane(["X"], 1), pane(["Y"], 2), pane(["Z"], 3)], 2),
          ],
          8,
        ),
      ]),
  },
  {
    name: "Spiral",
    description: "Each split halves the remaining space, alternating orientation.",
    build: () =>
      row([
        pane(["1"], 1),
        column([
          pane(["2"], 1),
          row([
            column([pane(["5"], 1), pane(["4"], 1)], 1),
            pane(["3"], 1),
          ]),
        ]),
      ]),
  },
  {
    name: "Scroll column",
    description:
      "The middle is a scroll-column: cells size themselves to their content and the column scrolls. A row of cells sits inside it.",
    build: () =>
      row([
        pane(["Outline"], 1),
        scrollColumn(
          [
            pane([t("Intro", 1)]),
            pane([t("Setup", ["import carreau", "ws = Workspace(layout)"])]),
            row([pane([t("Left cell", 2)]), pane([t("Right cell", 1)])]),
            pane([t("Long cell", 4), t("Other tab", 1)]),
            pane([t("Short", ["one line"])]),
            pane([t("Analysis", 3)]),
            row([pane([t("A", 1)]), pane([t("B", 3)]), pane([t("C", 2)])]),
            pane([t("Conclusion", 2)]),
          ],
          3,
        ),
        pane(["Inspector"], 1),
      ]),
  },
  {
    name: "Scroll row",
    description:
      "The top strip is a scroll-row of cards that size their width to their content; the second card is a column of two panes.",
    build: () =>
      column([
        scrollRow(
          [
            pane([t("Card 1", lines(6, 20))]),
            column([pane([t("Stacked a", lines(3, 50))]), pane([t("Stacked b", lines(2, 30))])]),
            pane([t("Card 3", lines(8, 12))]),
            pane([t("Wide card", lines(5, 90))]),
            pane([t("Card 5", lines(4, 35)), t("Alt", lines(3, 10))]),
            pane([t("Card 6", lines(7, 25))]),
            pane([t("Card 7", lines(3, 60))]),
          ],
          2,
        ),
        row([pane(["Main", "Docs"], 2), pane(["Log"], 1)], 3),
      ]),
  },
  {
    name: "Sticky",
    description:
      "Sticky scroll splits (⋯ → Stick to top / bottom, left / right): short content sits at the end, and scrolled to the end, they stay there as content grows. Like a terminal.",
    build: () =>
      column([
        row(
          [
            { ...scrollColumn([
              pane([cell("ls", SHELL, "$ ls", "oklch(0.75 0.12 160)", "done", "src/  testscripts/  design.md")]),
              pane([cell("make", SHELL, "$ make", "oklch(0.75 0.12 160)", "done", "build ok")]),
              pane([cell("make test", SHELL, "$ make test", "oklch(0.72 0.15 25)", "error", "FAIL weights preserved")]),
            ]), reverse: true },
            scrollColumn([
              pane([cell("Explain", PROMPT, "What is a sticky scroll split?", "oklch(0.72 0.13 300)", undefined, "One that sticks to its end.")]),
              pane([cell("Shorter", PROMPT, "Shorter.", "oklch(0.72 0.13 300)", "done", "Sticks to the end.")]),
            ]),
          ],
          3,
        ),
        { ...scrollRow([pane([t("Card 1", lines(3, 20))]), pane([t("Card 2", lines(3, 30))]), pane([t("Card 3", lines(3, 15))])], 1), reverse: true },
      ]),
  },
  {
    name: "Single pane",
    description: "One pane with many tabs; drag a tab to a side to split.",
    build: () => pane(["alpha", "beta", "gamma", "delta", "epsilon"]),
  },
];
