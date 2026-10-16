// Prompt columns: a column of cells sticking to its bottom, with an input field (the prompt)
// below them, like a terminal or a chat. Self-contained: it plugs into the core through its
// extension points (node types and kinds, operand redirection). No DOM here: rendering is in
// prompt-view.ts, styles in prompt.css. See "Prompt columns" in design.md.

import { kind, leafKind, registerKind, splitKind } from "./kinds";
import { genId } from "./model";
import { LayoutNode, PaneNode, SplitNode, Tab } from "./types";
import { Workspace, registerBehavior } from "./workspace";

/**
 * The input field of a prompt-column: always its last child, fixed at its bottom. It can be
 * focused (selected), but not moved, closed, or dropped onto. What is typed in it is UI state.
 */
export interface PromptNode {
  type: "prompt";
  id: string;
  weight: number;
}

declare module "./types" {
  interface NodeTypes {
    prompt: PromptNode;
  }
  interface SplitTypes {
    "prompt-column": true;
  }
}

// ---------------------------------------------------------------------------
// Kinds

/** A cell of its own (it can be focused), pinned: nothing moves it, nothing goes into it. */
registerKind("prompt", { ...leafKind, cell: true, pinned: true });

registerKind("prompt-column", {
  ...splitKind("column", true),
  // Its prompt stays last, below the cells: insertions at its end go just before it.
  lastFixed: true,
  alwaysSticky: true,
  groupTitle: "Prompt",
  // Exactly one prompt, last (the first one, keeping its id), even with no cells: a
  // prompt-column never disappears for being empty.
  normalizeChildren: (_n, kids) => [...kids.filter((x) => !kind(x).pinned), kids.find((x) => x.type === "prompt") ?? promptNode()],
});

// ---------------------------------------------------------------------------
// Construction

/** A column of cells sticking to its bottom, with a prompt below them. */
export function promptColumn(children: LayoutNode[], weight = 1): SplitNode {
  return { type: "prompt-column", id: genId("pc"), weight, children: [...children, promptNode()] };
}

export function promptNode(): PromptNode {
  return { type: "prompt", id: genId("q"), weight: 1 };
}

// ---------------------------------------------------------------------------
// The secondary focus: what cell operations act on, from a focused prompt

/** A prompt's secondary focus: the cell just above it (in a split there, its most recently focused cell). */
export function secondaryOf(ws: Workspace, promptId: string): string | null {
  const e = ws.index().get(promptId);
  const col = e?.parent;
  const above = col?.type === "prompt-column" ? col.children[e!.index - 1] : undefined;
  return above ? ws.descend(above) : null;
}

// From a focused prompt, cell operations act on the secondary focus, and maximizing
// maximizes it (the focus then goes there: a maximized prompt alone would show nothing).
const secondary = (ws: Workspace, n: LayoutNode) => {
  const id = secondaryOf(ws, n.id);
  return id ? { id } : null;
};
registerBehavior("prompt", { operand: secondary, maximize: secondary });

// ---------------------------------------------------------------------------
// Submitting

export interface PromptOptions {
  /** What submitted text becomes: a new cell above the prompt (null: none). Default: a text tab. */
  submit?(text: string): Tab | null;
  /** The field's placeholder. */
  placeholder?: string;
}

const OPTIONS = new WeakMap<Workspace, PromptOptions>();

/** Set how a workspace's prompts behave (merged with what was set before). */
export function configurePrompts(ws: Workspace, opts: PromptOptions): void {
  OPTIONS.set(ws, { ...OPTIONS.get(ws), ...opts });
}

export function promptOptions(ws: Workspace): PromptOptions {
  return OPTIONS.get(ws) ?? {};
}

/**
 * Submit what was typed in a prompt: it becomes a cell (`PromptOptions.submit`), added just
 * above the prompt, like a drop (undoable). The focus stays where it is. Returns the new pane,
 * or null.
 */
export function submitPrompt(ws: Workspace, promptId: string, text: string): string | null {
  const col = ws.index().parent(promptId);
  if (col?.type !== "prompt-column") return null;
  const { submit } = promptOptions(ws);
  const tab = submit ? submit(text) : { id: genId("t"), title: text.slice(0, 24) || "…", content: text };
  if (!tab) return null;
  const node: PaneNode = { type: "pane", id: genId("p"), weight: 1, tabs: [tab], active: 0 };
  const result = ws.tryDrop({ kind: "external", node }, { kind: "between", splitId: col.id, index: col.children.length - 1 });
  if (!result) return null;
  ws.commitDrop(result, undefined, undefined, false);
  return result.paneId;
}
