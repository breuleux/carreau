// Colors. Almost everything is neutral grey. Cells (tabs) have an accent color, shown only on
// the active tab of the focused pane (and a cell's `long` strip); border lines get
// low-saturation colors only to tell several possible insertions apart.

const TAB_HUES = [25, 70, 145, 195, 240, 285, 330];
const LEVEL_HUES = [250, 35, 150, 310, 95];

/** A cell's accent: its own, or one derived from its id (several cells may share one). */
export function cellAccent(t: { id: string; accent?: string }): string {
  if (t.accent) return t.accent;
  let h = 0;
  for (const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `oklch(0.74 0.13 ${TAB_HUES[h % TAB_HUES.length]})`;
}

/** A border line's k-th insertion level (outermost first): grey, then muted hues. */
export function levelColor(k: number, alpha: number, lightness: number): string {
  const chroma = k === 0 ? 0 : 0.06;
  const hue = k === 0 ? 0 : LEVEL_HUES[(k - 1) % LEVEL_HUES.length];
  return `oklch(${lightness} ${chroma} ${hue} / ${alpha})`;
}

/** Neutral grey, for icons and dots. */
export function grey(lightness: number, alpha = 1): string {
  return `oklch(${lightness} 0 0 / ${alpha})`;
}
