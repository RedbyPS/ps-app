// Priorities in the Tab list (the developer, 18 Oct 2026). Priority 1 is a GROUP that can be empty: tasks
// flagged p1 always sit together at the top (one outline around them all); every other task counts
// on from P2 in list order. Dragging a task to the very top (or into the P1 group) makes it P1,
// dragging it out below the group drops P1, and the task editor has a Priority 1 switch. Nothing
// ever makes a task P1 by itself.
import type { Doc, Todo } from "./model";
import { isColourBg } from "./bgcolour.ts";

export const isP1 = (t: Todo) => t.p1 === true;

/** The priority level a task shares with its neighbours (PS 1.73, the developer 21 Nov 2026: "if you have more than one priority
 *  two tasks, then I want it to group together in the same way as the priority one tasks"). Tasks next to each other in
 *  the numbered list with the same `prioGroup` are one level: they show the same P number and sit in one box. Only a
 *  numbered task (not P1, not "no priority") has one; anything else is null. */
export const levelTag = (t: { p1?: boolean; unranked?: boolean; prioGroup?: string | null }): string | null =>
  !t.p1 && !t.unranked && typeof t.prioGroup === "string" && t.prioGroup ? t.prioGroup : null;

/** The list in display order: P1 tasks first, then by order. The tasks of one priority level stay together
 *  (each level sorts by its first task's order), so a level is never split by a stray order number. */
export function sortPrio(list: Doc<Todo>[]): Doc<Todo>[] {
  // The P1 group first, then the numbered tasks, then the ones with no priority yet; each by order.
  const rank = (t: Todo) => (isP1(t) ? 0 : t.unranked ? 2 : 1);
  const head = new Map<string, number>();
  for (const d of list) { const g = levelTag(d.data); if (g) head.set(g, Math.min(head.get(g) ?? Infinity, d.data.order ?? 0)); }
  const key = (t: Todo) => { const g = levelTag(t); return g ? head.get(g)! : t.order ?? 0; };
  const tag = (t: Todo) => levelTag(t) ?? "";
  return [...list].sort((a, b) => rank(a.data) - rank(b.data) || key(a.data) - key(b.data)
    || (tag(a.data) < tag(b.data) ? -1 : tag(a.data) > tag(b.data) ? 1 : 0) || (a.data.order ?? 0) - (b.data.order ?? 0));
}

export type PrioItem = { id: string; p1: boolean; unranked?: boolean; prioGroup?: string | null };
/** The P number each task shows: 1 for the P1 group, then 2, 3, ... A task with no priority yet
 *  (unranked) gets no number and does not use one up. Neighbours on the same level (prioGroup) share a number. */
export function prioNumbers(list: PrioItem[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 1, last: string | null = null;
  for (const t of list) {
    if (t.p1) { out.set(t.id, 1); continue; }
    if (t.unranked) continue;
    const g = levelTag(t);
    if (!(g && g === last)) n++;
    out.set(t.id, n);
    last = g;
  }
  return out;
}

/** The numbered tasks cut into their levels, top to bottom: P2 first. Each run is the ids that share a P number. */
export function prioRuns(list: PrioItem[]): { level: number; ids: string[] }[] {
  const nums = prioNumbers(list), out: { level: number; ids: string[] }[] = [];
  for (const t of list) {
    const n = nums.get(t.id);
    if (n == null || n === 1) continue;
    const last = out[out.length - 1];
    if (last && last.level === n) last.ids.push(t.id); else out.push({ level: n, ids: [t.id] });
  }
  return out;
}
/** A priority level gets its own box (like Priority 1) once two or more tasks share it. One task alone stays a plain
 *  row with its P badge, as before: a box round a single row would only add noise. */
export const LEVEL_GROUP_MIN = 2;

/** A new level tag (a short random id). */
export function newLevelTag(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return "l" + Array.from(b, (x) => (x % 36).toString(36)).join("");
}

/**
 * After a drag inside Priorities (next = the new order of the numbered tasks and the ones below them): the level tag
 * the moved task has now. `into`: the box the pointer was let go over (its tag), null when it was let go outside
 * every box, undefined when there is no pointer to go by. Let go inside a box: that level. Between two tasks of one
 * level: that level. Otherwise it keeps its own level only while it still sits next to it (no pointer), else it is a
 * level of its own.
 */
export function levelAfterMove(next: string[], moved: string, tags: Map<string, string | null>, into?: string | null): string | null {
  if (into) return into;
  const at = next.indexOf(moved);
  if (at < 0) return null;
  const a = tags.get(next[at - 1]) ?? null, b = tags.get(next[at + 1]) ?? null;
  if (a && a === b) return a;
  if (into === null) return null;
  const own = tags.get(moved) ?? null;
  return own && (a === own || b === own) ? own : null;
}

type Placed = { id?: string; order?: number; p1?: boolean; unranked?: boolean; prioGroup?: string | null };
/**
 * Where a task goes to join priority level `level` (2 or more): at the end of that level's tasks, with its tag. A
 * level that is one task so far gets a new tag, given to that task too (`pair`), so the two become a group. Past the
 * last level: a level of its own at the end of the numbered tasks. `ranked` is the one-off list as the Tab list shows
 * it (sortPrio), without the task being placed.
 */
export function placeInLevel(ranked: Placed[], level: number, tag: () => string = newLevelTag): { order: number; prioGroup: string | null; pair?: { id: string; prioGroup: string } } {
  const group = ranked.filter((t) => t.p1 === true);
  const numbered = ranked.filter((t) => t.p1 !== true && !t.unranked);
  const firstFree = ranked.find((t) => t.p1 !== true && t.unranked)?.order;
  const items = numbered.map((t, i) => ({ id: t.id ?? `#${i}`, p1: false, prioGroup: t.prioGroup ?? null }));
  const runs = prioRuns(items);
  const between = (before?: number, after?: number) =>
    before != null && after != null && after > before ? (before + after) / 2 : before != null ? before + 1 : after != null ? after - 1 : 0;
  const run = runs.find((r) => r.level === Math.max(2, Math.round(level)));
  if (!run) {
    // Past the last level (or no numbered tasks yet): a level of its own after the numbered tasks (or after Priority 1).
    const last = numbered[numbered.length - 1] ?? group[group.length - 1];
    return { order: between(last?.order, firstFree), prioGroup: null };
  }
  const k = items.findIndex((x) => x.id === run.ids[run.ids.length - 1]);
  const order = between(numbered[k].order ?? 0, numbered[k + 1]?.order ?? firstFree);
  if (run.ids.length >= LEVEL_GROUP_MIN) return { order, prioGroup: levelTag(numbered[k]) };
  const g = tag(), only = numbered[k];
  return { order, prioGroup: g, ...(only.id ? { pair: { id: only.id, prioGroup: g } } : {}) };
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

// ---------- PS 1.73: the look of the Priority 2, 3... group boxes (the developer, 21 Nov 2026) ----------
// "I just want them to be grouped by default, like no effects or anything like that, no fancy animations by default
// for the priority two tasks". Each level has its own look: Plain (the default: a quiet box, no glow, nothing moves) or
// any of the Priority 1 outlines, and its own colour. Saved in settings.tmLvLook by level ("2", "3", ...).
export const LV_PLAIN = "plain";
export const LV_LEVEL_MAX = 20;
export type LvLook = { style: string; color: string | null };
/** The look of one level's box: the saved one, cleaned, or Plain with no colour. */
export function lvLook(v: unknown, level: number): LvLook {
  const rec = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[String(level)] : undefined;
  const r = (rec && typeof rec === "object" ? rec : {}) as { style?: unknown; color?: unknown };
  const style = typeof r.style === "string" && (r.style === LV_PLAIN || P1_DESIGNS.some((d) => d.id === r.style)) ? r.style : LV_PLAIN;
  return { style, color: p1Color(r.color) };
}
/** Every level's look after one change, cleaned; a level back to Plain with no colour is left out. */
export function lvLookPatch(v: unknown, level: number, change: Partial<LvLook>): Record<string, { style?: string; color?: string | null }> {
  const out: Record<string, { style?: string; color?: string | null }> = {};
  for (let n = 2; n <= LV_LEVEL_MAX; n++) {
    const cur = lvLook(v, n);
    const next = n === level ? lvLook({ [n]: { ...cur, ...change } }, n) : cur;
    if (next.style !== LV_PLAIN || next.color) out[String(n)] = { ...(next.style !== LV_PLAIN ? { style: next.style } : {}), ...(next.color ? { color: next.color } : {}) };
  }
  return out;
}
/** True when a level's look moves (an animated outline). Plain never does. */
export const lvMoves = (style: string) => P1_DESIGNS.some((d) => d.id === style && d.moving === true);

/** PS 1.73, the right click menu's Priority: move task `id` onto priority level `level` as the list shows it now (the
 *  number on its badge). Onto a level with other tasks: it joins them, at their end. Onto the number past the last
 *  level: a level of its own at the end. null when it is already there. `ranked` is the one-off list as shown. */
export function levelMove(ranked: (Placed & { id: string })[], id: string, level: number, tag: () => string = newLevelTag): { order: number; prioGroup: string | null; pair?: { id: string; prioGroup: string } } | null {
  const items = (l: (Placed & { id: string })[]) => l.map((x) => ({ id: x.id, p1: x.p1 === true, unranked: x.unranked === true, prioGroup: x.prioGroup ?? null }));
  const nums = prioNumbers(items(ranked));
  if (nums.get(id) === level) return null;
  const rest = ranked.filter((x) => x.id !== id);
  const mate = prioRuns(items(ranked)).find((r) => r.level === level)?.ids.find((x) => x !== id);
  const target = mate ? prioNumbers(items(rest)).get(mate) ?? Infinity : Infinity;
  return placeInLevel(rest, target === Infinity ? Number.MAX_SAFE_INTEGER : target, tag);
}

/** What a new task's priority is when the caller did not say (PS 1.73, the developer 21 Nov 2026: "stop adding in priorities at
 *  random ... Just have them at the bottom"): a one-off task on the main list with no place (no order) and no Priority 1
 *  gets none (unranked: no P number, at the bottom). Every day, repeating, a task group, the AI Inbox, and any task the
 *  caller placed (a drag to a spot, a typed P2, a picked place) or ranked itself are left as they are. */
export function newTaskRank(t: Partial<Todo>): Partial<Todo> {
  if ((t.type ?? "once") === "daily" || t.p1 === true || t.unranked !== undefined || t.order !== undefined || t.group || t.aiInbox === true) return {};
  return { unranked: true };
}

// ---------- PS 1.77: two tasks on Priority 2 make one Priority 2 group (the developer, 23 Nov 2026) ----------
// "I make one task P2, and another P2, and one of them changes to P3/P4 instead." The picker in Add task and in Edit used
// to pick a PLACE in the list (Place #2 twice gave P2, P3, P4). It now picks the priority LEVEL, the P number the list
// shows, and joins it (placeInLevel, levelMove). A drop ON a lone numbered task joins its level too (dropOnto).

type LevelItem = { id: string; p1?: boolean; unranked?: boolean; prioGroup?: string | null };
const levelItems = (l: LevelItem[]): PrioItem[] => l.map((x) => ({ id: x.id, p1: x.p1 === true, unranked: x.unranked === true, prioGroup: x.prioGroup ?? null }));

/** The priority picker's range and start: the levels as the list shows them now. `max` is one past the last level of the
 *  other tasks (a level of its own at the end), never below 2. `current`: the task's own level (2 or more), or null for a
 *  new task, a Priority 1 task or one with no priority. `ranked` is the one-off list as shown (sortPrio). */
export function levelPick(ranked: LevelItem[], id?: string | null): { current: number | null; max: number } {
  const nums = prioNumbers(levelItems(ranked));
  let top = 1;
  for (const [k, n] of nums) if (k !== id && n > top) top = n;
  const own = id ? nums.get(id) ?? null : null;
  return { current: own != null && own >= 2 ? own : null, max: top + 1 };
}

/** A drag may let go ON row `over` to join its level: a numbered task that is alone on its level (no box yet), and not
 *  already on the moved task's level. Rows in a box are joined by letting go inside the box (levelAfterMove). */
export function canDropOnto(items: PrioItem[], over: string, moved: string): boolean {
  if (over === moved) return false;
  const run = prioRuns(items).find((r) => r.ids.includes(over));
  return !!run && run.ids.length === 1;
}

/**
 * A task let go ON a lone numbered task (`over`): they become one level. `next` is the new order the drag gave (the moved
 * task next to `over`); a task with no priority is put just above `over`, so it gets a number (unrankedAfterMove). The
 * level keeps `over`'s tag when it has one; otherwise both get a new tag (`pair` is `over`'s write).
 */
export function dropOnto(next: string[], moved: string, over: string, tags: Map<string, string | null>, unranked: Set<string>, tag: () => string = newLevelTag): { next: string[]; prioGroup: string; pair?: { id: string; prioGroup: string } } {
  let order = next;
  if (unranked.has(moved)) {
    order = next.filter((x) => x !== moved);
    order.splice(Math.max(0, order.indexOf(over)), 0, moved);
  }
  const own = tags.get(over) ?? null;
  if (own) return { next: order, prioGroup: own };
  const g = tag();
  return { next: order, prioGroup: g, pair: { id: over, prioGroup: g } };
}
