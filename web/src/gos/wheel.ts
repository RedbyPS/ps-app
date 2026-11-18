// The phone's wheel menu (PS 1.67). The developer, 18 Nov 2026: replace the hamburger at the top left with a round button at the bottom
// left. Hold it, follow a glowing path to the middle of the screen, and every screen PS has fans out in a circle around the
// finger; nudge towards one and let go to launch it full screen. Inspired by a shade switcher he liked and the feel of a game's
// radio station wheel, but PS's own design (no copied look or assets).
//
// This file is the pure part: which items, in which ring and order, where each sits, which one the finger points at, where the
// label goes and the path the finger follows. No React, no DOM (gos/PhoneWheel.tsx draws it, tests/phonewheel.test.ts checks it).
import { MENU, menuItems, type MenuId } from "./menu.ts";

export type WheelId = MenuId | "sleep" | "dnd" | "gym" | "sounds" | "whatsnew" | "plan" | "inbox" | "vault";
export type WheelSection = "Most used" | "Your day" | "Tools";

export interface WheelItem {
  id: WheelId;
  label: string;
  /** The one line summary shown next to the finger. */
  line: string;
  section: WheelSection;
  /** An SVG path, 24 by 24, stroked. PS Rules draws its badge instead. */
  icon: string;
  /** 0 the inner ring (the most used), 1 the outer ring. */
  ring: 0 | 1;
}

/** The items that are not in the old menu: each has its own screen or page on the phone. */
const EXTRA: Record<"sleep" | "dnd" | "gym" | "sounds" | "whatsnew" | "plan" | "inbox" | "vault", { label: string; line: string; icon: string }> = {
  sleep: { label: "Sleep mode", line: "A calm clock and your alarms, logged when you wake.",
    icon: "M3 18v-6.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2V18M3 15h18M3 18v2M21 18v2M6.5 9.5V8a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 12.5 8v1.5" },
  dnd: { label: "Do Not Disturb", line: "Mutes cards and sounds until you say.",
    icon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" },
  gym: { label: "Gym", line: "Your workout, sets and the rest timer.",
    icon: "M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11" },
  sounds: { label: "Sounds", line: "Your soundboard, the player and the queue.",
    icon: "M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 16.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM9 18.5V6l11-2.5v13" },
  whatsnew: { label: "What's new", line: "What changed in this version of PS.",
    icon: "M12 3l1.8 4.6L18.5 9.5l-4.7 1.9L12 16l-1.8-4.6L5.5 9.5l4.7-1.9zM18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" },
  plan: { label: "Meetings", line: "Your calls coming up, on the Plan page.",
    icon: "M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 9.5h16M8.5 3v3M15.5 3v3" },
  inbox: { label: "Inbox", line: "Client emails, notes, new tasks and Urgent.",
    icon: "M4 13.5l2.2-7.2A1.5 1.5 0 0 1 7.6 5.3h8.8a1.5 1.5 0 0 1 1.4 1l2.2 7.2V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18zM4 13.5h4.5l1.2 2h4.6l1.2-2H20" },
  vault: { label: "Vault", line: "The website's pages: clients, projects and more.",
    icon: "M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" },
};

/** Every item in order of use. The inner ring is "Most used"; the outer ring holds "Your day" (round the top) then "Tools"
 *  (round the bottom). Within a ring the first item sits at the top and each next one alternates right, left, further down,
 *  so the least used end up at the bottom of the circle, under the thumb. */
export const WHEEL_ORDER: { id: WheelId; section: WheelSection }[] = [
  // Most used: the inner ring.
  { id: "sleep", section: "Most used" }, { id: "dnd", section: "Most used" }, { id: "clocks", section: "Most used" },
  { id: "gym", section: "Most used" }, { id: "gsquad", section: "Most used" }, { id: "receipts", section: "Most used" },
  { id: "timelines", section: "Most used" }, { id: "settings", section: "Most used" },
  // Your day: the outer ring, round the top.
  { id: "goals", section: "Your day" }, { id: "screentime", section: "Your day" }, { id: "numerology", section: "Your day" },
  { id: "plan", section: "Your day" }, { id: "inbox", section: "Your day" }, { id: "series", section: "Your day" },
  { id: "brief", section: "Your day" },
  // Tools: the outer ring, round the bottom.
  { id: "sounds", section: "Tools" }, { id: "dimx", section: "Tools" }, { id: "rules", section: "Tools" },
  { id: "whatsnew", section: "Tools" }, { id: "edit", section: "Tools" }, { id: "endday", section: "Tools" },
  { id: "clipboard", section: "Tools" }, { id: "campaigns", section: "Tools" }, { id: "vault", section: "Tools" },
];
/** Room on the inner ring. Anything past this (never today) moves out. */
export const INNER_MAX = 8;

/** The wheel for this person: the old menu's items (the same the developer only and switched off rules, gos/menu.ts) plus the screens
 *  that were never in it. `show` says no to an extra the phone does not have right now (Sleep mode off, no Vault page). */
export function wheelItems({ red, has, show }: { red: boolean; has: (sel: string) => boolean; show: (id: WheelId) => boolean }): WheelItem[] {
  const menu = new Map(menuItems({ red, has }).map((m) => [m.id as WheelId, m]));
  const out: WheelItem[] = [];
  let inner = 0;
  for (const o of WHEEL_ORDER) {
    const m = menu.get(o.id);
    const x = (EXTRA as Record<string, { label: string; line: string; icon: string }>)[o.id];
    if (m) { if (!show(o.id)) continue; }
    else if (!x || !show(o.id)) continue;
    const ring: 0 | 1 = o.section === "Most used" && inner < INNER_MAX ? 0 : 1;
    if (ring === 0) inner++;
    out.push({ id: o.id, label: m?.label ?? x.label, line: m?.line ?? x.line, icon: m?.icon ?? x.icon, section: o.section, ring });
  }
  return out;
}
/** Every wheel item that came from the old menu, so nothing it offered is lost. */
export const MENU_IDS = MENU.map((m) => m.id);

// ---------- geometry ----------
export interface Pt { x: number; y: number }
/** The screen: width, height and the bars at the top and bottom that nothing may sit under. */
export interface Vp { w: number; h: number; top: number; bottom: number }

/** Angles in degrees, 0 at the top, clockwise. Item 0 at the top, then right, left, further right, further left... */
export function ringAngles(n: number): number[] {
  if (n <= 0) return [];
  const step = 360 / n;
  const a: number[] = [];
  for (let k = 0; k < n; k++) a.push(k === 0 ? 0 : k % 2 ? Math.ceil(k / 2) * step : -(k / 2) * step);
  return a.map((d) => ((d % 360) + 540) % 360 - 180);   // -180..180
}

export interface Slot { id: WheelId; ring: 0 | 1; ang: number; x: number; y: number; size: number }
export interface WheelGeo { cx: number; cy: number; rIn: number; rOut: number; bIn: number; bOut: number; slots: Slot[] }

const R_OUT_MAX = 150, R_IN_ONLY = 96;
/** Where everything sits, centred as near the finger as the screen allows (the whole outer ring stays on screen). */
export function wheelGeo(items: { id: WheelId; ring: 0 | 1 }[], finger: Pt, vp: Vp): WheelGeo {
  const inner = items.filter((i) => i.ring === 0), outer = items.filter((i) => i.ring === 1);
  const room = Math.max(120, Math.min(vp.w, vp.h - vp.top - vp.bottom)) / 2;
  let rOut = 0, rIn: number, bIn: number, bOut = 0;
  if (outer.length) {
    rOut = Math.round(Math.max(96, Math.min(R_OUT_MAX, room - 30)));
    bOut = Math.round(Math.min(48, (2 * Math.PI * rOut / outer.length) * 0.82));
    rIn = Math.round(rOut * 0.56);
  } else rIn = Math.round(Math.max(70, Math.min(R_IN_ONLY, room - 34)));
  bIn = Math.round(Math.min(56, (2 * Math.PI * rIn / Math.max(1, inner.length)) * 0.8));
  const reach = (outer.length ? rOut + bOut / 2 : rIn + bIn / 2) + 8;
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  const cx = clamp(finger.x, reach, vp.w - reach);
  const cy = clamp(finger.y, vp.top + reach, vp.h - vp.bottom - reach);
  const slots: Slot[] = [];
  const place = (list: { id: WheelId }[], ring: 0 | 1, r: number, size: number) => {
    const ang = ringAngles(list.length);
    list.forEach((it, i) => {
      const rad = (ang[i] * Math.PI) / 180;
      slots.push({ id: it.id, ring, ang: ang[i], x: Math.round(cx + Math.sin(rad) * r), y: Math.round(cy - Math.cos(rad) * r), size });
    });
  };
  place(inner, 0, rIn, bIn);
  place(outer, 1, rOut, bOut);
  return { cx, cy, rIn, rOut, bIn, bOut, slots };
}

/** The finger has to move this far from the centre before anything is picked (a resting thumb wobbles). */
export const DEAD_ZONE = 16;
/** Which item the finger points at: the ring by how far it moved, the item by its direction. Null in the dead zone. */
export function pickSlot(geo: WheelGeo, p: Pt): WheelId | null {
  const dx = p.x - geo.cx, dy = p.y - geo.cy, d = Math.hypot(dx, dy);
  if (d < DEAD_ZONE || !geo.slots.length) return null;
  const hasOuter = geo.slots.some((s) => s.ring === 1), hasInner = geo.slots.some((s) => s.ring === 0);
  const ring: 0 | 1 = !hasInner ? 1 : hasOuter && d > (geo.rIn + geo.rOut) / 2 ? 1 : 0;
  const a = (Math.atan2(dx, -dy) * 180) / Math.PI;
  let best: Slot | null = null, bestD = 999;
  for (const s of geo.slots) {
    if (s.ring !== ring) continue;
    const diff = Math.abs(((a - s.ang + 540) % 360) - 180);
    if (diff < bestD) { bestD = diff; best = s; }
  }
  return best?.id ?? null;
}

// ---------- the label next to the finger ----------
export interface Box { x: number; y: number; w: number; h: number }
export type LabelSide = "above" | "left" | "below";
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The part of the screen the thumb covers: from just above and left of the touch point, down and to the right (the hold
 *  starts at the bottom left and the thumb reaches over from the right). Nothing is ever shown there. */
export function fingerZone(f: Pt, vp: Vp): Box { return { x: f.x - 26, y: f.y - 26, w: vp.w - (f.x - 26) + 1, h: vp.h - (f.y - 26) + 1 }; }

/** Where the label goes: above the finger first, else to its left, else below and to the left. Never to the right, never
 *  under the finger, never off screen, and if it can it keeps clear of the item being picked. */
export function labelSpot(f: Pt, size: { w: number; h: number }, vp: Vp, avoid?: Box | null): { x: number; y: number; side: LabelSide } {
  const m = 10, top = vp.top + 6, bot = vp.h - vp.bottom - 6;
  const w = Math.min(size.w, vp.w - 2 * m), h = size.h;
  const zone = fingerZone(f, vp);
  const clampX = (x: number) => Math.min(vp.w - m - w, Math.max(m, x));
  const clampY = (y: number) => Math.min(bot - h, Math.max(top, y));
  const cands: { side: LabelSide; b: Box; pref: number }[] = [
    { side: "above", pref: 0, b: { x: clampX(f.x - w / 2), y: f.y - 40 - h, w, h } },
    { side: "left", pref: 1, b: { x: f.x - 44 - w, y: clampY(f.y - h / 2 - 18), w, h } },
    { side: "below", pref: 2, b: { x: Math.max(m, f.x - 30 - w), y: f.y + 34, w, h } },
  ];
  // Still above the finger but out of the picked item's way: higher than it, or beside it on the left.
  if (avoid) {
    cands.push({ side: "above", pref: 0.2, b: { x: clampX(f.x - w / 2), y: Math.min(f.y - 40 - h, avoid.y - 8 - h), w, h } });
    cands.push({ side: "above", pref: 0.3, b: { x: avoid.x - 8 - w, y: f.y - 40 - h, w, h } });
  }
  let best: { side: LabelSide; b: Box } | null = null, bestScore = Infinity;
  for (const c of cands) {
    const b = c.b;
    if (b.x < m - 0.5 || b.x + b.w > vp.w - m + 0.5 || b.y < top - 0.5 || b.y + b.h > bot + 0.5) continue;   // off screen
    if (overlap(b, zone)) continue;   // under the finger
    const score = c.pref + (avoid && overlap(b, avoid) ? 5 : 0);
    if (score < bestScore) { bestScore = score; best = c; }
  }
  if (best) return { x: Math.round(best.b.x), y: Math.round(best.b.y), side: best.side };
  // Nowhere clean (a tiny landscape screen): as high as the screen allows, left of the finger's line.
  return { x: Math.round(Math.max(m, Math.min(f.x - 30 - w, vp.w - m - w))), y: Math.round(top), side: "above" };
}

// ---------- the glowing path from the button to the middle ----------
/** The middle of the usable screen: where the wheel opens. */
export function middleOf(vp: Vp): Pt { return { x: Math.round(vp.w / 2), y: Math.round(vp.top + (vp.h - vp.top - vp.bottom) / 2) }; }
/** The bend: up from the button, then across to the middle. */
export function pathCtl(from: Pt, to: Pt): Pt { return { x: from.x + (to.x - from.x) * 0.08, y: to.y + (from.y - to.y) * 0.12 }; }
export function pathD(from: Pt, to: Pt): string {
  const c = pathCtl(from, to);
  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)}Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}
/** Points along the path, for following the finger (made once per hold). */
export function pathPts(from: Pt, to: Pt, n = 48): Pt[] {
  const c = pathCtl(from, to), out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * from.x + 2 * u * t * c.x + t * t * to.x, y: u * u * from.y + 2 * u * t * c.y + t * t * to.y });
  }
  return out;
}
/** How far along the path the finger is (0 at the button, 1 at the middle) and how far off it. */
export function along(pts: Pt[], p: Pt): { t: number; off: number } {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i].x - p.x) ** 2 + (pts[i].y - p.y) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return { t: pts.length > 1 ? bi / (pts.length - 1) : 1, off: Math.sqrt(bd) };
}
/** Close enough to the middle to open the wheel. */
export const ARRIVE = 52;
export function arrived(pts: Pt[], p: Pt): boolean {
  const end = pts[pts.length - 1];
  if (Math.hypot(p.x - end.x, p.y - end.y) <= ARRIVE) return true;
  const a = along(pts, p);
  return a.t >= 0.94 && a.off <= ARRIVE * 1.4;
}

/** Hold this long before the path shows (a quick tap and release shows the hint instead). Moving the finger first starts it too. */
export const HOLD_MS = 260;
export const START_MOVE = 14;
/** The words this feature puts on screen that are not item labels or lines. */
export const WHEEL_WORDS = { hint: "Please hold", button: "Open the wheel", hold: "Hold, then slide to the middle" } as const;
