// Prompt columns, rendering (see prompt.ts). Import this module (and prompt.css) to show them.
// The column itself is rendered by the view, as a split with a fixed last child: the prompt
// sits below the scrolling cells. Here: the prompt, holding its editor (the host's, through
// `PromptOptions.editor`; by default, a one-line field: `inputEditor`).

import { PromptEditor, PromptEditorFactory, PromptNode, PromptState, promptOptions, speakerOf, submitPrompt } from "./prompt";
import { View, registerRenderer } from "./view";

const editorKey = (id: string) => `prompt:${id}`;
/** Each prompt's editor, by its element (the persistent one). */
const EDITORS = new WeakMap<HTMLElement, PromptEditor>();

registerRenderer("prompt", {
  fill(el, node, view) {
    el.classList.add("carreau-prompt");
    el.addEventListener("pointerdown", () => view.ws.selection.id !== node.id && view.ws.select({ id: node.id }));
  },
  // The editor persists across renders (what's typed, and the focus, survive), and is told
  // what it may show on every render.
  attached(el, node, view) {
    let made: PromptEditor | undefined;
    const editorEl = view.persist(
      editorKey(node.id),
      el,
      () => {
        made = makeEditor(view, node as PromptNode);
        EDITORS.set(made.el, made);
        return made.el;
      },
      () => made?.destroy?.(),
    );
    EDITORS.get(editorEl)?.update?.(stateOf(view, node.id));
  },
  // Leaving navigation mode on the prompt (or clicking its column's tab): into its editor.
  commitFocus(node, view) {
    const el = view.persisted(editorKey(node.id));
    if (el) EDITORS.get(el)?.focus();
  },
});

function makeEditor(view: View, node: PromptNode): PromptEditor {
  const ws = view.ws;
  const factory = promptOptions(ws).editor ?? inputEditor();
  return factory({
    ws,
    promptId: node.id,
    submit: (text) => void submitPrompt(ws, node.id, text),
    // (A render re-focuses a moved field: that's not the user focusing it.)
    focused: () => !view.rendering && ws.selection.id !== node.id && ws.select({ id: node.id }),
  });
}

function stateOf(view: View, promptId: string): PromptState {
  const speaker = speakerOf(view.ws, promptId);
  return { speaker, merged: !!speaker?.link, selected: view.ws.selection.id === promptId };
}

/**
 * The default editor: a one-line field. Enter submits (then the field clears and keeps the
 * focus). Merged, the placeholder says who types. `placeholder`: default, the workspace's
 * `PromptOptions.placeholder`.
 */
export function inputEditor(opts: { placeholder?: string } = {}): PromptEditorFactory {
  return (ctx) => {
    const field = Object.assign(document.createElement("input"), { className: "carreau-prompt-input", spellcheck: false });
    field.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !field.value.trim()) return;
      e.preventDefault();
      const text = field.value.trim();
      field.value = "";
      ctx.submit(text);
    });
    field.addEventListener("focus", () => ctx.focused());
    return {
      el: field,
      focus() {
        field.focus({ preventScroll: true });
        field.setSelectionRange(field.value.length, field.value.length);
      },
      update({ speaker, merged }) {
        const base = opts.placeholder ?? promptOptions(ctx.ws).placeholder ?? "Type, then Enter";
        field.placeholder = merged && speaker ? `${base} (as ${speaker.title})` : base;
      },
    };
  };
}
