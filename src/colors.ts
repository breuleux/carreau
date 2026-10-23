// Colors, as CSS `light-dark(light, dark)` values (they follow the inherited color-scheme; the
// dark side is the reference). Almost everything is neutral grey. Cells (tabs) have an accent color, shown only on
// the active tab of the focused pane (and a cell's `long` strip). Drop indicators are white
// and grey (see dnd.ts).

const TAB_HUES = [25, 70, 145, 195, 240, 285, 330];

/** A cell's accent: its own, or one derived from its id (several cells may share one). */
export function cellAccent(t: { id: string; accent?: string }): string {
  if (t.accent) return t.accent;
  let h = 0;
  for (const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = TAB_HUES[h % TAB_HUES.length];
  return `light-dark(oklch(0.62 0.15 ${hue}), oklch(0.74 0.13 ${hue}))`;
}

/** Neutral grey, for icons and dots (light chips with a dark outline: the same in both modes). */
export function grey(lightness: number, alpha = 1): string {
  return `oklch(${lightness} 0 0 / ${alpha})`;
}
