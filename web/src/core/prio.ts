// Priorities in the Tab list (the developer, 18 Oct 2026). Priority 1 is a GROUP that can be empty: tasks
// flagged p1 always sit together at the top (one outline around them all); every other task counts
// on from P2 in list order. Dragging a task to the very top (or into the P1 group) makes it P1,
// dragging it out below the group drops P1, and the task editor has a Priority 1 switch. Nothing
// ever makes a task P1 by itself.
import type { Doc, Todo } from "./model";
import { isColourBg } from "./bgcolour.ts";

export const isP1 = (t: Todo) => t.p1 === true;

/** The list in display order: P1 tasks first, then by order. */
export function sortPrio(list: Doc<Todo>[]): Doc<Todo>[] {
  // The P1 group first, then the numbered tasks, then the ones with no priority yet; each by order.
  const rank = (t: Todo) => (isP1(t) ? 0 : t.unranked ? 2 : 1);
  return [...list].sort((a, b) => rank(a.data) - rank(b.data) || (a.data.order ?? 0) - (b.data.order ?? 0));
}

/** The P number each task shows: 1 for the P1 group, then 2, 3, ... A task with no priority yet
 *  (unranked) gets no number and does not use one up. */
export function prioNumbers(list: { id: string; p1: boolean; unranked?: boolean }[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 2;
  for (const t of list) { if (t.p1) out.set(t.id, 1); else if (!t.unranked) out.set(t.id, n++); }
  return out;
}

/**
 * After a drag (next = the new order): does the moved task have no priority now? Tasks with no
 * priority sit below the numbered ones. One that lands with a numbered task below it gets a number;
 * a numbered one that lands below a task with no priority loses its number. Otherwise nothing changes.
 */
export function unrankedAfterMove(next: string[], moved: string, unranked: Set<string>): boolean {
  const at = next.indexOf(moved);
  if (at < 0) return unranked.has(moved);
  if (unranked.has(moved)) return !next.slice(at + 1).some((id) => !unranked.has(id));
  return next.slice(0, at).some((id) => unranked.has(id));
}

/**
 * After a drag (next = the new order, P1 group first): is the moved task P1 now?
 * A P1 task stays P1 anywhere inside its group (its end included) and drops it once it goes past
 * an ordinary task. Another task joins by landing inside the group, or at the very top when there
 * is no group.
 */
export function p1AfterMove(next: string[], moved: string, p1: Set<string>): boolean {
  const at = next.indexOf(moved);
  const group = next.filter((id) => id !== moved && p1.has(id)).length;
  if (p1.has(moved)) return at <= group;
  return group > 0 ? at < group : at === 0;
}

/** The one task that moved between two orders (or null). */
export function movedId(before: string[], after: string[]): string | null {
  for (const id of after) {
    const a = before.filter((x) => x !== id), b = after.filter((x) => x !== id);
    if (a.length === b.length && a.every((x, i) => x === b[i]) && before.indexOf(id) !== after.indexOf(id)) return id;
  }
  return null;
}

/** The OUTLINE looks for the P1 group (Settings, gear). Animated ones move only inside the outline. */
/** V1.53 (the developer, 12 Nov 2026: "please remove the weird googly eyes"): "Watching you" is gone. A saved "eyes" is not in
 *  this list any more, so p1Design gives it the default look. */
export const P1_DESIGNS: { id: string; label: string; moving?: boolean }[] = [
  { id: "red-glisten", label: "Red glisten", moving: true },
  { id: "white-glisten", label: "White glisten", moving: true },
  { id: "red", label: "Red outline" },
  { id: "purple", label: "Purple outline" },
  { id: "gold", label: "Gold outline" },
  { id: "lightning", label: "Red lightning", moving: true },
  { id: "target", label: "Hit the target", moving: true },
  { id: "radar", label: "Radar lock", moving: true },
  { id: "neon", label: "Neon sign", moving: true },
  { id: "glitch", label: "Glitch", moving: true },
  { id: "rainbow", label: "Rainbow", moving: true },
  { id: "crown", label: "Crown", moving: true },
  { id: "none", label: "No outline" },
];
export const P1_DEFAULT = "red-glisten";
export const p1Design = (v?: string | null) => (P1_DESIGNS.some((d) => d.id === v) ? v! : P1_DEFAULT);

/** The BACKGROUND looks (screen wide, behind everything; Settings, gear). Independent of the outline. */
export const BG_DESIGNS: { id: string; label: string; storm?: boolean; image?: boolean }[] = [
  { id: "none", label: "None" },
  { id: "spotlight", label: "Spotlight" },
  { id: "converge", label: "All roads lead here" },
  { id: "tunnel", label: "Tunnel vision" },
  { id: "hypno", label: "Hypno spiral" },
  { id: "storm-forked", label: "Forked lightning", storm: true },
  { id: "storm-sheet", label: "Sheet lightning", storm: true },
  { id: "storm-edges", label: "Storm on the edges", storm: true },
  { id: "storm-aimed", label: "Bolts at P1", storm: true },
  { id: "storm-rumble", label: "Distant rumbles", storm: true },
  // PS 1.70: the developer's neon night city picture, also the sign in picture (views/neoncity.ts). A still picture, every build.
  { id: "neon-city", label: "Neon city", image: true },
];
/** A picture background (PS 1.70): drawn like a video, still, faded by the glass slider. */
export const isImageBg = (v?: string | null) => typeof v === "string" && BG_DESIGNS.some((d) => d.image && d.id === v);
/** A background: one of BG_DESIGNS, or one of the developer's own videos ("video:<id>", PS only: the files
 *  stay on his Mac, see ps-mac Sources/Backgrounds.swift). */
export const isVideoBg = (v?: string | null) => typeof v === "string" && /^video:[a-z0-9-]{1,48}$/.test(v);
/** A colour background ("color:<preset>" or "color:#rrggbb", core/bgcolour.ts, V1.40) is a background too. */
export const bgDesign = (v?: string | null) => (BG_DESIGNS.some((d) => d.id === v) || isVideoBg(v) || isColourBg(v) ? v! : "none");
/** Before 18 Oct 2026 the screen wide looks were outline choices: where each one moves to. */
export const OLD_SCENES: Record<string, { bg: string; outline: string }> = {
  spotlight: { bg: "spotlight", outline: "white-glisten" }, converge: { bg: "converge", outline: "red" },
  tunnel: { bg: "tunnel", outline: "red" }, hypno: { bg: "hypno", outline: "purple" },
};

/** The Priority 1 COLOUR (the developer, 2 Nov 2026: "one colour for all P1 tasks"). Unset (null) keeps the
 *  look exactly as it was. Set, every P1 task takes it: the text, the tick ring, the P1 badge, and
 *  the outline look's accent and glow. Saved as settings.p1Color, "#rrggbb". */
export const P1_COLORS: { id: string; label: string }[] = [
  { id: "#ff2e3e", label: "Red" },
  { id: "#ff7a1a", label: "Orange" },
  { id: "#ffd21f", label: "Yellow" },
  { id: "#3dff7a", label: "Green" },
  { id: "#1fe0ff", label: "Cyan" },
  { id: "#3d7bff", label: "Blue" },
  { id: "#a35bff", label: "Purple" },
  { id: "#ff3dc8", label: "Pink" },
  { id: "#ffffff", label: "White" },
];
/** A saved or typed colour, cleaned: "#rrggbb" (lower case; "#rgb" and no "#" are fine too), else null. */
export function p1Color(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let h = v.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null;
}
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hexOf = (rgb: number[]) => `#${rgb.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")}`;
/** WCAG relative luminance (0 black to 1 white). */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio between two colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** The darkest backing a P1 row ever sits on (the solid row while a background moves or flashes). */
export const P1_ROW_BACK = "#1c1219";
/** Mixed toward white just enough to reach `ratio` against the row backing; strong colours stay as they are. */
function lift(hex: string, ratio: number): string {
  const rgb = rgbOf(hex);
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = hexOf(rgb.map((x) => x + (255 - x) * t));
    if (contrast(c, P1_ROW_BACK) >= ratio) return c;
  }
  return "#ffffff";
}
/** What the page paints with a P1 colour. c: the colour itself; accent: for rings, outlines and the
 *  badge (at least 3:1 on the darkest row); text: the task's words (at least 4.5:1, so a dark pick
 *  like navy still reads on every background); on: white on the accent, or near black on a light one;
 *  rgb: "r, g, b" of the accent for glows. */
export function p1Tones(color: string): { c: string; accent: string; text: string; on: string; rgb: string } {
  const c = p1Color(color) ?? "#ff2e3e";
  const accent = lift(c, 3), text = lift(c, 4.5);
  const on = contrast(accent, "#ffffff") >= 3 ? "#ffffff" : "#17121a";   // white like today's badge, dark on light colours
  return { c, accent, text, on, rgb: rgbOf(accent).join(", ") };
}
/** Hue (0 to 359) to a strong colour, for the custom colour slider. */
export function hueColor(h: number): string {
  const x = ((Math.round(h) % 360) + 360) % 360;
  const f = (n: number) => { const k = (n + x / 30) % 12; return 255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return hexOf([f(0), f(8), f(4)]);
}
/** The hue of a colour (0 to 359), for where the custom slider's knob starts. */
export function colorHue(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}
