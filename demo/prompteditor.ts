// Demo: a custom prompt editor (see PromptEditor in src/prompt.ts). A header above a
// multi-line field that grows with its text: Enter sends, Shift+Enter starts a new line. Any
// editor would do the same way (CodeMirror, Monaco…): an element, focus(), and update().

import type { PromptEditorFactory } from "../src/prompt";

export const headedEditor: PromptEditorFactory = (ctx) => {
  const el = Object.assign(document.createElement("div"), { className: "demo-prompt" });
  const header = Object.assign(document.createElement("div"), { className: "demo-prompt-header" });
  const area = Object.assign(document.createElement("textarea"), { className: "demo-prompt-area", rows: 1, spellcheck: false, placeholder: "Ask anything…" });
  el.append(header, area);
  const fit = () => {
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
  };
  area.addEventListener("input", fit);
  area.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const text = area.value.trim();
    if (!text) return;
    area.value = "";
    fit();
    ctx.submit(text);
  });
  area.addEventListener("focus", () => ctx.focused());
  return {
    el,
    focus() {
      area.focus({ preventScroll: true });
      area.setSelectionRange(area.value.length, area.value.length);
    },
    update({ speaker, merged, selected }) {
      header.textContent = `${speaker?.title ?? "Prompt"}${merged ? " (merged)" : ""} · Enter to send, Shift+Enter for a new line`;
      el.classList.toggle("selected", selected);
    },
  };
};
