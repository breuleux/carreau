// Prompt columns, rendering (see prompt.ts). Import this module (and prompt.css) to show them.
// The column itself is rendered by the view, as a split with a fixed last child: the prompt
// sits below the scrolling cells. Here: the prompt, with its persistent input field.

import { PromptNode, promptOptions, speakerOf, submitPrompt } from "./prompt";
import { View, registerRenderer } from "./view";

const fieldKey = (id: string) => `prompt:${id}`;

registerRenderer("prompt", {
  fill(el, node, view) {
    el.classList.add("carreau-prompt");
    el.addEventListener("pointerdown", () => view.ws.selection.id !== node.id && view.ws.select({ id: node.id }));
  },
  // The field persists across renders: what's typed, and the focus, survive. Merged, it says
  // who types (the complex's active member: the cells come from it).
  attached(el, node, view) {
    const field = view.persist(fieldKey(node.id), el, () => makeField(view, node as PromptNode));
    const speaker = speakerOf(view.ws, node.id);
    const base = promptOptions(view.ws).placeholder ?? "Type, then Enter";
    field.placeholder = speaker?.link ? `${base} (as ${speaker.title})` : base;
  },
  // Leaving navigation mode on the prompt: into its field, at the end.
  commitFocus(node, view) {
    const field = view.persisted(fieldKey(node.id)) as HTMLInputElement | undefined;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  },
});

function makeField(view: View, node: PromptNode): HTMLInputElement {
  const ws = view.ws;
  const field = Object.assign(document.createElement("input"), {
    className: "carreau-prompt-input",
    spellcheck: false,
  });
  // Enter submits; the field clears and keeps the focus.
  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !field.value.trim()) return;
    e.preventDefault();
    const text = field.value.trim();
    field.value = "";
    submitPrompt(ws, node.id, text);
  });
  // Focusing the field (a click, Tab) selects the prompt. (Not when a render re-focuses it.)
  field.addEventListener("focus", () => !view.rendering && ws.selection.id !== node.id && ws.select({ id: node.id }));
  return field;
}
