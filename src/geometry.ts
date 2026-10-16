// Rectangles and sides.

import { Orientation, Rect, Side } from "./types";

export const SIDES: Side[] = ["left", "right", "top", "bottom"];

/** The axis a side is on: left/right are along rows (x), top/bottom along columns (y). */
export const sideAxis: Record<Side, Orientation> = { left: "row", right: "row", top: "column", bottom: "column" };
export const sideIsStart: Record<Side, boolean> = { left: true, top: true, right: false, bottom: false };
export const opposite: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/** The coordinate of a rect's edge on a side. */
export function edge(r: Rect, side: Side): number {
  return side === "left" ? r.x : side === "right" ? r.x + r.w : side === "top" ? r.y : r.y + r.h;
}

/** A rect's extent along a side (the coordinates the side spans). */
export function span(r: Rect, side: Side): [number, number] {
  return sideAxis[side] === "row" ? [r.y, r.y + r.h] : [r.x, r.x + r.w];
}

/** The part of a rect next to a side, `frac` of its size across that side. */
export function slice(r: Rect, side: Side, frac: number): Rect {
  switch (side) {
    case "left":
      return { ...r, w: r.w * frac };
    case "right":
      return { ...r, x: r.x + r.w * (1 - frac), w: r.w * frac };
    case "top":
      return { ...r, h: r.h * frac };
    case "bottom":
      return { ...r, y: r.y + r.h * (1 - frac), h: r.h * frac };
  }
}

/**
 * A band along a side: `from`..`to` measured inward from the edge (negative = outward),
 * spanning `along` (defaults to the rect's own extent).
 */
export function band(r: Rect, side: Side, from: number, to: number, along = span(r, side)): Rect {
  const e = edge(r, side);
  const [a0, a1] = along;
  const [u0, u1] = sideIsStart[side] ? [e + from, e + to] : [e - to, e - from];
  return sideAxis[side] === "row" ? { x: u0, y: a0, w: u1 - u0, h: a1 - a0 } : { x: a0, y: u0, w: a1 - a0, h: u1 - u0 };
}

/** The coordinate of a point across / along a side's axis. */
export function across(side: Side, x: number, y: number): number {
  return sideAxis[side] === "row" ? x : y;
}
export function along(side: Side, x: number, y: number): number {
  return sideAxis[side] === "row" ? y : x;
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

export function union(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
