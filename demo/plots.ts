// Demo: plots that merge. Each plot tab draws a function; merged (dragged onto each other's
// tab), they share one plot area: the complex's first member's, where every member is drawn,
// the active one highlighted. A complex type with only a `show` hook (see src/complex.ts).

import { Complex, genId, registerComplex, Tab } from "../src/model";

const FUNCTIONS: Record<string, (x: number) => number> = {
  sine: Math.sin,
  cosine: Math.cos,
  damped: (x) => Math.exp(-x / 6) * Math.sin(2 * x),
  square: (x) => (Math.sin(x) >= 0 ? 0.8 : -0.8),
  ramp: (x) => ((x / Math.PI) % 2) - 1,
};

/** A plot tab: mergeable with other plots (key "plot"). */
export function plot(title: string, fn: keyof typeof FUNCTIONS, accent: string): Tab {
  return { id: genId("t"), title, key: "plot", icon: "∿", accent, data: { plot: fn } };
}

/** A plot tab's content: an empty plot area, drawn by `show`. */
export function plotElement(): HTMLElement {
  const el = document.createElement("div");
  el.className = "demo-plot";
  return el;
}

const W = 400;
const H = 220;
const X_MAX = 4 * Math.PI;

registerComplex("plot", {
  show(complex: Complex, content: HTMLElement) {
    const area = content.querySelector<HTMLElement>(".demo-plot");
    if (!area) return;
    const active = complex.active ?? complex.tabs[0];
    const curves = complex.tabs.map((t) => {
      const fn = FUNCTIONS[(t.data?.plot as string) ?? ""] ?? (() => 0);
      const pts = Array.from({ length: 201 }, (_, i) => {
        const x = (i / 200) * X_MAX;
        return `${((x / X_MAX) * W).toFixed(1)},${(H / 2 - fn(x) * (H / 2.6)).toFixed(1)}`;
      }).join(" ");
      const on = t === active;
      return `<polyline points="${pts}" fill="none" stroke="${t.accent ?? "currentColor"}" stroke-width="${on ? 3 : 1.5}" opacity="${on ? 1 : 0.55}"/>`;
    });
    const legend = complex.tabs
      .map((t) => `<span style="color:${t.accent}">${t === active ? "<b>" : ""}● ${t.title}${t === active ? "</b>" : ""}</span>`)
      .join(" ");
    area.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="axis"/>` +
      curves.join("") +
      `</svg><div class="legend">${legend}</div>`;
  },
});
