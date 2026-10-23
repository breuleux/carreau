// Tab complexes: tabs merged together. Merged tabs are adjacent tabs of a pane sharing a
// `link` (an id): plain tabs otherwise, so that every tab operation (dragging one out,
// reordering, closing, activating) works as usual. Leaving a complex is ending up anywhere
// else than next to the other members. A complex shows its first member's body (see
// `shownIndex`), and its type, chosen by its members' merge key (`mergeKey`), decides what
// merging means (`registerComplex`). See "Tab complexes" in design.md.

import { mergeKey } from "./kinds";
import { walk } from "./tree";
import { PaneNode, SplitNode, Tab, LayoutNode } from "./types";
import type { Workspace } from "./workspace";

/** A run of merged tabs (or, where said so, a lone tab: a complex of one). */
export interface Complex {
  /** The members' link (empty for a lone unlinked tab). */
  id: string;
  /** The members' merge key (the first member's). */
  key: string | null;
  pane: PaneNode;
  /** The first member's index in the pane's tabs. */
  start: number;
  /** The members, in order. The first one's body is the one shown. */
  tabs: Tab[];
  /** The active member, if the pane's active tab is one of them. */
  active: Tab | null;
}

export interface ComplexChange {
  /** New members (all of them, for a new complex). */
  entered: Tab[];
  /** Former members, now elsewhere (dragged out, or about to close: see `closing`). */
  left: Tab[];
}

/** What merging means, for the tabs of a merge key. All optional. */
export interface ComplexType {
  /**
   * The members changed: some entered or left, or they were reordered. Runs within the
   * structural change, on its forest (normalized afterwards), so it can rearrange the layout
   * (e.g. gather the members' contents into the first one's). `complex` has one member left
   * when it dissolves: it is then replaced by that lone tab.
   */
  changed?(forest: SplitNode, complex: Complex, change: ComplexChange): void;
  /**
   * A member is about to close (before its contents close). Then it leaves the complex
   * (`changed`), and closes. E.g. hand what it holds over to the others.
   */
  closing?(forest: SplitNode, complex: Complex, tab: Tab, ws: Workspace): void;
  /**
   * The view shows a complex (or a lone tab of this key) with the first member's persistent
   * content element: update it (e.g. draw all members in it). Called on every render.
   */
  show?(complex: Complex, content: HTMLElement): void;
}

const TYPES: Record<string, ComplexType> = {};

/** Say what merging tabs with this merge key means. */
export function registerComplex(key: string, type: ComplexType): void {
  TYPES[key] = type;
}

export function complexType(key: string | null): ComplexType | undefined {
  return key === null ? undefined : TYPES[key];
}

/** The complex tab `i` of a pane belongs to (a lone tab: a complex of one). */
export function complexAt(p: PaneNode, i: number): Complex {
  const link = p.tabs[i]?.link;
  let [lo, hi] = [i, i];
  if (link) {
    while (lo > 0 && p.tabs[lo - 1].link === link) lo--;
    while (hi + 1 < p.tabs.length && p.tabs[hi + 1].link === link) hi++;
  }
  const tabs = p.tabs.slice(lo, hi + 1);
  const active = p.active >= lo && p.active <= hi ? p.tabs[p.active] : null;
  return { id: link ?? "", key: tabs[0] ? mergeKey(tabs[0]) : null, pane: p, start: lo, tabs, active };
}

/** The runs of linked tabs in a pane (lone linked tabs included). */
export function linkedRuns(p: PaneNode): Complex[] {
  const out: Complex[] = [];
  for (let i = 0; i < p.tabs.length; i++) {
    if (!p.tabs[i].link) continue;
    const c = complexAt(p, i);
    out.push(c);
    i = c.start + c.tabs.length - 1;
  }
  return out;
}

/** Whether two tabs can merge: same non-null key, and not already merged together. */
export function canMerge(p: PaneNode, i: number, tab: Tab): boolean {
  const t = p.tabs[i];
  const key = t && mergeKey(t);
  return !!t && t !== tab && key !== null && key === mergeKey(tab) && !(t.link && t.link === tab.link && complexAt(p, i).tabs.includes(tab));
}

/** A new link id. */
export function newLink(): string {
  return `x${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Make a pane's links consistent: a lone linked tab is unlinked; a link used by two runs is
 * renamed (`seen`: links already used; `keep`: first members of runs that keep theirs).
 */
export function normalizeLinks(p: PaneNode, seen = new Set<string>(), keep?: Set<Tab | undefined>): void {
  for (const run of linkedRuns(p)) {
    if (run.tabs.length < 2) delete run.tabs[0].link;
    else if (keep?.has(run.tabs[0])) continue;
    else if (seen.has(run.id)) {
      const id = newLink();
      for (const t of run.tabs) t.link = id;
    } else seen.add(run.id);
  }
}

/** The runs of each link (several, when members left it: the complex is one of them). */
function runsById(forest: LayoutNode): Map<string, Complex[]> {
  const out = new Map<string, Complex[]>();
  for (const { node } of walk(forest))
    if (node.type === "pane") for (const run of linkedRuns(node)) out.set(run.id, [...(out.get(run.id) ?? []), run]);
  return out;
}

/** Of a link's runs, the complex: the one keeping the most former members, else the longest. */
function mainRun(runs: Complex[], was: string[]): Complex | undefined {
  const kept = (c: Complex) => c.tabs.filter((t) => was.includes(t.id)).length;
  return [...runs].sort((a, b) => kept(b) - kept(a) || b.tabs.length - a.tabs.length)[0];
}

/**
 * Run a structural change (`fn`, on a forest) and tell complex types how their complexes
 * changed (`changed`). Then make the links consistent (normalization follows).
 */
export function trackComplexes<R>(forest: SplitNode, fn: () => R): R {
  const before = new Map([...runsById(forest)].map(([id, runs]) => [id, mainRun(runs, [])!.tabs.map((t) => t.id)]));
  const value = fn();
  const after = runsById(forest);
  const tabsById = new Map<string, Tab>();
  for (const { node } of walk(forest)) if (node.type === "pane") for (const t of node.tabs) tabsById.set(t.id, t);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(id) ?? [];
    const c = mainRun(after.get(id) ?? [], was);
    if (!c || (was.length === c.tabs.length && c.tabs.every((t, i) => t.id === was[i]))) continue;
    const entered = c.tabs.filter((t) => !was.includes(t.id));
    const left = was.filter((x) => !c.tabs.some((t) => t.id === x)).flatMap((x) => tabsById.get(x) ?? []);
    complexType(c.key)?.changed?.(forest, c, { entered, left });
  }
  // Links: lone ones go, and one used in several places (by members that left) is renamed,
  // except for the complex's own run.
  const seen = new Set<string>();
  const mains = new Set([...after].map(([id, runs]) => mainRun(runs, before.get(id) ?? [])?.tabs[0]));
  const panesList = [...walk(forest)].flatMap(({ node }) => (node.type === "pane" ? [node] : []));
  for (const p of panesList) for (const run of linkedRuns(p)) if (mains.has(run.tabs[0]) && run.tabs.length > 1) seen.add(run.id);
  for (const p of panesList) normalizeLinks(p, seen, mains);
  return value;
}
