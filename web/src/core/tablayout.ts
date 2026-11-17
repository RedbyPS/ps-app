// Edit mode for the Tab list (G Squad release, the developer 7 Nov 2026): "move stuff around the screen so that it's not
// just static... and also remove stuff... and maybe bring some stuff back". Pure functions only, so
// tests/tablayout.test.ts can check them: the record, where a moved panel sits on any screen size, the snapping,
// hiding and bringing back, and the op the PS Tab list sends to the main page.
//
// Storage: ONE small encrypted vault record per account (kind "tablayout", owner private, vault key), never inside
// the big settings record, so a move uploads a few hundred bytes and nothing else, and only when something changed.
//
// A moved panel keeps its place as a fraction of the room left on screen: x 0 is the left edge (less a margin),
// x 1 is flush with the right edge, the same for y. So it lands in the same spot on any screen size and can never
// be off screen. w and h are its size when it was dropped (w also fixes its width once it leaves its column).
// In the lower half it hangs from the bottom, so a panel that grows (more meetings) grows up, never off screen.
import { mailAllowed, secondAllowed } from "./mailflag.ts";
import { CAMPAIGNS_ON } from "./features.ts";

export type SlotPos = { x: number; y: number; w: number; h: number };
/** One panel's own settings (V1.55). cal: which calendar a Meetings panel shows ("" or unset: the usual one;
 *  "g:<feed>": another Google calendar the developer linked to this panel; "m:<account>": one account of the Mac's Calendar).
 *  of: a button dragged out of a panel (the Meetings panel's three) remembers the panel it came from.
 *  open (V1.57): a Time zones panel kept open by a click (unset: it opens on hover only), each copy on its own. */
export type InstCfg = { cal?: string; of?: string; open?: boolean };
/** V1.55 adds, all optional so a record from before reads exactly as it did (core/tablayout.ts migration note):
 *  extra: the copies added from the Add panel gallery (ids "<kind>.<random>"), page: the page each panel sits on
 *  (unset: the main page), size: its size (unset: 1), cfg: its own settings. */
export type TabLayout = {
  pos: Record<string, SlotPos>; hidden: string[]; at: string;
  extra?: string[]; page?: Record<string, string>; size?: Record<string, number>; cfg?: Record<string, InstCfg>;
};
export type Rect = { left: number; top: number; width: number; height: number };

/** The gap kept between a moved panel and the screen's edge, in CSS pixels. */
export const EDGE = 12;
/** How close (px) an edge must come to another edge or a centre line before it snaps to it. */
export const SNAP = 10;
const ID = /^[a-z][a-z0-9-]{0,31}(\.[a-z0-9]{4,12})?$/;
export const MAX_SLOTS = 64;
/** Copies added from the gallery (the developer: "you can have fifteen different sleep buttons"), across every page. */
export const MAX_EXTRA = 120;

/** Every panel and button of the floating Tab list that Edit mode knows, top left to bottom right.
 *  off: switched off in this build (core/features.ts), so never offered in the tray.
 *  keep: never removable (the gear opens Settings). red: the developer's own (other accounts never see it, so never in their tray). */
export type SlotInfo = { id: string; label: string; keep?: boolean; red?: boolean; mail?: boolean; off?: boolean; inner?: string; ps?: boolean; wide?: boolean;
  /** PS 1.65 (G Squad pieces): off the page until the person adds one from the Add panel gallery. The original is never drawn, only copies. */
  optIn?: boolean };
export const SLOTS: readonly SlotInfo[] = [
  { id: "clocks", label: "Time zones" },
  { id: "pomodoro", label: "Pomodoro" },   // V1.58: between Time zones and Sentry mode (views/Pomodoro.tsx)
  { id: "sentry", label: "Sentry mode (AI)" },   // V1.48: between Time zones and Timelines
  { id: "timelines", label: "Timelines" },
  { id: "series", label: "Series map" },
  { id: "numerology", label: "Numerology", red: true },
  { id: "meetings", label: "Meetings" },
  { id: "campaigns", label: "Campaign stats", red: true, off: !CAMPAIGNS_ON },   // core/features.ts
  { id: "dimx", label: "Dimension X" },
  { id: "rules", label: "Rule book", red: true },
  { id: "fitness", label: "Fitness" },
  { id: "soundboard", label: "Soundboard" },
  { id: "glass", label: "Transparency slider, Keep overlay and Hover mode" },
  { id: "afk", label: "Away badge" },
  { id: "screentime", label: "Screen time" },
  { id: "brief", label: "Morning brief", red: true },
  { id: "endday", label: "End day" },
  { id: "net", label: "Network" },
  { id: "activity", label: "Activity monitor", ps: true },   // PS 1.65 (views/ActivityMonitor.tsx): the chart button next to Network, Mac only
  { id: "lowpower", label: "Low power mode" },   // PS 1.65 (views/LowPowerButton.tsx): the on/off button, next to Network
  { id: "mixer", label: "Volume mixer" },
  { id: "clipboard", label: "Clear clipboard" },
  { id: "gear", label: "Settings", keep: true },
  { id: "security", label: "Security" },
  { id: "second", label: "Second Computer" },   // PS 1.65: everyone's, once Second Computer is switched on (slotOk)
  { id: "gsquad", label: "G Squad" },
  { id: "dnd", label: "Do Not Disturb" },
  { id: "pskeys", label: "Tab and Lock", keep: true },
  { id: "mail", label: "Client emails", mail: true },
  { id: "screenrec", label: "Record screen", ps: true },   // PS 1.60 (views/ScreenRec.tsx): right below the email panel, only after the person switched screen recording on
  { id: "receipts", label: "Purchases" },   // PS 1.65 (views/Purchases.tsx): the receipts finance screen, below Record screen
  { id: "squadp1", label: "Squad Priority 1" },   // PS 1.63 (views/SquadP1Panel.tsx): under the email panel and Record screen, above Sleep
  // PS 1.65 G Squad pieces (core/squadpieces.ts, views/SquadPieces.tsx): parts of G Squad as panels of their own. Off the page until added in Edit mode.
  { id: "sqchat", label: "Squad chat", optIn: true },
  { id: "sqconvs", label: "Conversations", optIn: true },
  { id: "sqboard", label: "Squad leaderboard", optIn: true },
  { id: "sqdone", label: "Squad tasks done", optIn: true },
  { id: "sqnow", label: "Working now", optIn: true },
  { id: "meetnotes", label: "Meeting notes" },
  { id: "leftovers", label: "Notes left over" },
  { id: "undo", label: "Undo" },
  { id: "newtasks", label: "New tasks", red: true },
  { id: "overdue", label: "Overdue" },
  { id: "sleep", label: "Sleep" },   // V1.47: bottom right, level with Dimension X
  // V1.55: the buttons inside a panel that can be dragged out to be buttons of their own (and back in). inner: the
  // panel they live in. They are never a Slot of their own in the list: a copy only exists once dragged out or added.
  { id: "calrefresh", label: "Calendar refresh", inner: "meetings" },
  { id: "privacy", label: "Private mode", inner: "meetings" },
];
/** Panels wide enough to get a width handle in the overview (buttons only get the size handle). */
const WIDE = new Set(["clocks", "timelines", "meetings", "campaigns", "dimx", "glass", "mail", "squadp1", "sqchat", "sqconvs", "sqboard", "sqdone", "sqnow", "meetnotes", "leftovers", "newtasks", "overdue", "series", "numerology"]);
const KNOWN = new Map(SLOTS.map((s) => [s.id, s]));
/** The kind of a panel: its own id, or the part before the dot for a copy ("sleep.k3f9a" is a Sleep). */
export const kindOf = (id: string) => id.split(".")[0];
export const isCopy = (id: string) => id.includes(".");
export const slotLabel = (id: string) => KNOWN.get(kindOf(id))?.label ?? id;
export const slotInfo = (id: string) => KNOWN.get(kindOf(id));
/** Off the page by default: only copies of it are ever drawn (the original is not on any page). */
export const isOptIn = (id: string) => !isCopy(id) && !!KNOWN.get(id)?.optIn;
/** Drawn where there is no Edit mode (the website, the phone's own page): every panel but an opt in original, which is on no page. */
export const drawsBare = (id: string) => !isOptIn(id);
export const isWide = (id: string) => WIDE.has(kindOf(id));
/** Can it be taken off the screen? A copy always can; of the originals all but the gear and Tab and Lock. */
export const canHide = (id: string) => KNOWN.has(kindOf(id)) && (isCopy(id) || !KNOWN.get(id)!.keep);

export const emptyLayout = (): TabLayout => ({ pos: {}, hidden: [], at: "" });
const PAGE_ID = /^(main|[a-z0-9]{4,24})$/;
const CAL = /^(g:[a-z0-9]{4,24}|m:[^\u0000-\u001f]{1,80})$/;
const sizeOk = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(Math.max(SIZE_MIN, Math.min(SIZE_MAX, n)) * 100) / 100 : null; };
/** The size handle's range: half size to two and a half times. */
export const SIZE_MIN = 0.5, SIZE_MAX = 2.5;
const frac = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(1, n)) * 10000) / 10000 : null; };
const px = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(4000, Math.round(n)) : null; };

/** A layout checked: known slot ids only, fractions 0 to 1, sizes in whole pixels, nothing hidden twice. */
export function cleanLayout(v: unknown): TabLayout {
  const o = (v && typeof v === "object" ? v : {}) as { pos?: unknown; hidden?: unknown; at?: unknown; extra?: unknown; page?: unknown; size?: unknown; cfg?: unknown };
  // The copies first: every other part may only name an original or a copy that exists.
  const extra = Array.isArray(o.extra)
    ? [...new Set(o.extra.filter((x): x is string => typeof x === "string" && ID.test(x) && isCopy(x) && KNOWN.has(kindOf(x)) && !KNOWN.get(kindOf(x))!.off))].slice(0, MAX_EXTRA)
    : [];
  const has = new Set(extra);
  const real = (id: string) => ID.test(id) && (isCopy(id) ? has.has(id) : KNOWN.has(id) && !KNOWN.get(id)!.inner);
  const pos: Record<string, SlotPos> = {};
  if (o.pos && typeof o.pos === "object") {
    for (const [id, p] of Object.entries(o.pos as Record<string, unknown>).slice(0, MAX_SLOTS + MAX_EXTRA)) {
      if (!real(id) || !p || typeof p !== "object") continue;
      const q = p as Record<string, unknown>;
      const x = frac(q.x), y = frac(q.y), w = px(q.w), h = px(q.h);
      if (x === null || y === null || w === null || h === null) continue;
      pos[id] = { x, y, w, h };
    }
  }
  const hidden = Array.isArray(o.hidden) ? [...new Set(o.hidden.filter((x): x is string => typeof x === "string" && !isCopy(x) && real(x) && canHide(x)))].slice(0, MAX_SLOTS) : [];
  const at = typeof o.at === "string" && !Number.isNaN(Date.parse(o.at)) ? o.at : "";
  const out: TabLayout = { pos, hidden, at };
  const map = <T>(m: unknown, f: (v: unknown, id: string) => T | null): Record<string, T> => {
    const r: Record<string, T> = {};
    if (m && typeof m === "object" && !Array.isArray(m)) for (const [id, x] of Object.entries(m as Record<string, unknown>).slice(0, MAX_SLOTS + MAX_EXTRA)) {
      if (!real(id)) continue;
      const c = f(x, id);
      if (c !== null) r[id] = c;
    }
    return r;
  };
  const page = map(o.page, (x) => (typeof x === "string" && PAGE_ID.test(x) && x !== "main" ? x : null));
  const size = map(o.size, (x) => { const z = sizeOk(x); return z === null || z === 1 ? null : z; });
  const cfg = map(o.cfg, (x, id) => {
    if (!x || typeof x !== "object") return null;
    const q = x as Record<string, unknown>, c: InstCfg = {};
    if (typeof q.cal === "string" && CAL.test(q.cal) && kindOf(id) === "meetings") c.cal = q.cal;
    if (q.open === true && kindOf(id) === "clocks") c.open = true;
    if (typeof q.of === "string" && isCopy(id) && KNOWN.get(kindOf(id))!.inner && real(q.of) && kindOf(q.of) === KNOWN.get(kindOf(id))!.inner) c.of = q.of;
    return Object.keys(c).length ? c : null;
  });
  if (extra.length) out.extra = extra;
  if (Object.keys(page).length) out.page = page;
  if (Object.keys(size).length) out.size = size;
  if (Object.keys(cfg).length) out.cfg = cfg;
  return out;
}

/** True when nothing was moved or removed (the record can then go). */
export const isDefault = (l: TabLayout) => Object.keys(l.pos).length === 0 && l.hidden.length === 0
  && !l.extra?.length && !Object.keys(l.page ?? {}).length && !Object.keys(l.size ?? {}).length && !Object.keys(l.cfg ?? {}).length;
/** One canonical text of a layout without its time: object keys sorted, removed panels in a set order. The copies
 *  keep their order (it is the order they were added, which the overview uses). */
function canon(l: TabLayout): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  const c = cleanLayout(l);
  return JSON.stringify(sort({ ...c, at: "", hidden: [...c.hidden].sort() }));
}
/** Same places, pages, sizes, settings and removed panels (the time does not count): no save is needed. */
export function sameLayout(a: TabLayout, b: TabLayout): boolean {
  return canon(a) === canon(b);
}

export function moveSlot(l: TabLayout, id: string, p: SlotPos, at: string): TabLayout {
  if (!KNOWN.has(kindOf(id)) || (isCopy(id) && !l.extra?.includes(id))) return l;
  return cleanLayout({ ...l, pos: { ...l.pos, [id]: p }, at });
}
/** Back in its own column (only its place is forgotten; it stays shown). */
export function homeSlot(l: TabLayout, id: string, at: string): TabLayout {
  const pos = { ...l.pos }; delete pos[id];
  return { ...l, pos, at };
}
export function hideSlot(l: TabLayout, id: string, at: string): TabLayout {
  if (isCopy(id)) return removeCopy(l, id, at);
  if (!canHide(id) || l.hidden.includes(id)) return l;
  return { ...l, hidden: [...l.hidden, id], at };
}
/** Brought back from the Hidden tray: where it was before it was removed (a moved panel keeps its place). */
export function showSlot(l: TabLayout, id: string, at: string): TabLayout {
  if (!l.hidden.includes(id)) return l;
  return { ...l, hidden: l.hidden.filter((h) => h !== id), at };
}
/** Reset: every original back where it started, on the main page, at its usual size; the copies go. */
export const resetLayout = (at: string): TabLayout => ({ pos: {}, hidden: [], at });

/** The hidden panels this account can bring back, in screen order (the developer's own ones only on his account). */
/** A panel the person may have: the developer's own ones need the developer's account, Client emails needs its switch (core/mailswitch.ts). */
const slotOk = (s: SlotInfo, red: boolean) => s.mail ? mailAllowed() : s.id === "second" ? secondAllowed() : red || !s.red;
export function trayOf(l: TabLayout, red: boolean): string[] {
  return SLOTS.filter((s) => l.hidden.includes(s.id) && slotOk(s, red) && !s.off).map((s) => s.id);
}

// ---------- V1.55: pages, copies, sizes and each panel's own settings (the Edit mode overview) ----------
// Migration: a record from before V1.55 has only pos, hidden and at. It reads exactly as it did: every panel on the
// main page, where it was, the removed ones still removed (and in the Add panel gallery). Nothing is rewritten until
// something is changed, and then the same one small record is written (change only).
export const MAIN_PAGE = "main";
/** A new id for a copy: "<kind>.<8 random letters and digits>". rnd: for the tests. */
export function copyId(kind: string, rnd?: () => number): string {
  const r = rnd ?? (() => { const b = new Uint8Array(1); crypto.getRandomValues(b); return b[0] / 256; });
  let t = "";
  for (let i = 0; i < 8; i++) t += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(r() * 36) % 36];
  return `${kind}.${t}`;
}
/** The page a panel sits on. pages: the pages that exist (a panel on a page that has gone is back on the main page). */
export function pageOf(l: TabLayout, id: string, pages?: ReadonlySet<string>): string {
  const p = l.page?.[id];
  return p && (!pages || pages.has(p)) ? p : MAIN_PAGE;
}
export const sizeOf = (l: TabLayout, id: string) => l.size?.[id] ?? 1;
export const cfgOf = (l: TabLayout, id: string): InstCfg => l.cfg?.[id] ?? {};
/** Every panel shown on a page: the originals that sit there (in screen order, the removed ones left out) and the
 *  copies there (in the order they were added). red: the developer's account (his own panels are only ever his). */
export function onPage(l: TabLayout, page: string, red: boolean, pages?: ReadonlySet<string>): string[] {
  const ok = (id: string) => { const s = slotInfo(id); return !!s && !s.off && slotOk(s, red); };
  const orig = SLOTS.filter((s) => !s.inner && !s.optIn && !l.hidden.includes(s.id) && ok(s.id) && pageOf(l, s.id, pages) === page).map((s) => s.id);
  const copies = (l.extra ?? []).filter((id) => ok(id) && pageOf(l, id, pages) === page);
  return [...orig, ...copies];
}
/** The inner buttons dragged out of this panel (their kinds): the panel leaves them out while they are outside. */
export function outOf(l: TabLayout, panel: string): Set<string> {
  const out = new Set<string>();
  for (const id of l.extra ?? []) if (l.cfg?.[id]?.of === panel) out.add(kindOf(id));
  return out;
}
const without = <T>(m: Record<string, T> | undefined, ids: Set<string>) => {
  if (!m) return undefined;
  const r = Object.fromEntries(Object.entries(m).filter(([k]) => !ids.has(k)));
  return Object.keys(r).length ? r : undefined;
};
const tidy = (l: TabLayout): TabLayout => {
  const out: TabLayout = { pos: l.pos, hidden: l.hidden, at: l.at };
  if (l.extra?.length) out.extra = l.extra;
  for (const k of ["page", "size", "cfg"] as const) if (l[k] && Object.keys(l[k]!).length) (out as Record<string, unknown>)[k] = l[k];
  return out;
};
/** A copy taken away for good (it can always be added again from the gallery). The buttons dragged out of it stay
 *  where they are, as buttons of their own. */
export function removeCopy(l: TabLayout, id: string, at: string): TabLayout {
  if (!l.extra?.includes(id)) return l;
  const gone = new Set([id]);
  const cfg = without(l.cfg, gone);
  if (cfg) for (const [k, c] of Object.entries(cfg)) if (c.of === id) { const { of: _of, ...rest } = c; if (Object.keys(rest).length) cfg[k] = rest; else delete cfg[k]; }
  const pos = { ...l.pos }; delete pos[id];
  return tidy({ ...l, pos, extra: l.extra.filter((x) => x !== id), page: without(l.page, gone), size: without(l.size, gone), cfg, at });
}
/** A panel or button put on a page (MAIN_PAGE: the main page). Its place on the screen comes with it. */
export function putOnPage(l: TabLayout, id: string, page: string, at: string): TabLayout {
  if (!slotInfo(id) || (isCopy(id) && !l.extra?.includes(id)) || slotInfo(id)!.inner && !isCopy(id)) return l;
  if (!PAGE_ID.test(page) || pageOf(l, id) === page) return l;
  const next = { ...(l.page ?? {}) };
  if (page === MAIN_PAGE) delete next[id]; else next[id] = page;
  return tidy({ ...l, page: next, at });
}
/** Added from the gallery onto a page. A removed original comes back first (where it was, now on this page); else a
 *  new copy, placed at `p` when given. Returns the new layout and the id that was added (null: nothing, the limit). */
export function addPanel(l: TabLayout, kind: string, page: string, at: string, p?: SlotPos, rnd?: () => number): { layout: TabLayout; id: string | null } {
  const s = KNOWN.get(kind);
  if (!s || s.off || !PAGE_ID.test(page)) return { layout: l, id: null };
  if (!s.inner && !s.optIn && l.hidden.includes(kind)) {
    let n = putOnPage(showSlot(l, kind, at), kind, page, at);
    if (p) n = moveSlot(n, kind, p, at);
    return { layout: n, id: kind };
  }
  if ((l.extra?.length ?? 0) >= MAX_EXTRA) return { layout: l, id: null };
  let id = copyId(kind, rnd);
  while (l.extra?.includes(id)) id = copyId(kind, rnd);
  let n = tidy({ ...l, extra: [...(l.extra ?? []), id], at });
  if (page !== MAIN_PAGE) n = putOnPage(n, id, page, at);
  if (p) n = moveSlot(n, id, p, at);
  return { layout: n, id };
}
/** A button dragged out of its panel: a button of its own on `page` at `p`, that remembers the panel it came from. */
export function pullOut(l: TabLayout, panel: string, kind: string, page: string, p: SlotPos, at: string, rnd?: () => number): { layout: TabLayout; id: string | null } {
  const s = KNOWN.get(kind);
  if (!s?.inner || kindOf(panel) !== s.inner || outOf(l, panel).has(kind)) return { layout: l, id: null };
  if (isCopy(panel) ? !l.extra?.includes(panel) : !KNOWN.has(panel)) return { layout: l, id: null };
  const r = addPanel(l, kind, page, at, p, rnd);
  if (!r.id) return r;
  return { layout: setCfg(r.layout, r.id, { of: panel }, at), id: r.id };
}
/** A dragged out button put back in a panel of its kind (the one it came from, or another): it lives inside again. */
export function pushIn(l: TabLayout, id: string, panel: string, at: string): TabLayout {
  const s = slotInfo(id);
  if (!s?.inner || !isCopy(id) || kindOf(panel) !== s.inner) return l;
  const n = removeCopy(l, id, at);
  // Put back into another panel than its own: that panel had its button inside all along, so nothing more to do;
  // its own panel gets its button back as well (it was only ever hidden while outside).
  return n;
}
/** The size handle: 1 is the usual size. */
export function setSize(l: TabLayout, id: string, z: number, at: string): TabLayout {
  if (!slotInfo(id) || (isCopy(id) && !l.extra?.includes(id))) return l;
  const v = sizeOk(z);
  if (v === null || v === sizeOf(l, id)) return l;
  const next = { ...(l.size ?? {}) };
  if (v === 1) delete next[id]; else next[id] = v;
  return tidy({ ...l, size: next, at });
}
/** A panel's own settings changed (an empty value takes that setting away). */
export function setCfg(l: TabLayout, id: string, patch: Partial<InstCfg>, at: string): TabLayout {
  if (!slotInfo(id) || (isCopy(id) && !l.extra?.includes(id))) return l;
  const c: InstCfg = { ...cfgOf(l, id), ...patch };
  for (const k of Object.keys(c) as (keyof InstCfg)[]) if (!c[k]) delete c[k];
  const next = { ...(l.cfg ?? {}) };
  if (Object.keys(c).length) next[id] = c; else delete next[id];
  return cleanLayout({ ...l, cfg: next, at });
}
/** A page deleted: the originals on it go back to the main page (never lost); the copies on it go (the gallery still
 *  has them). */
export function dropPage(l: TabLayout, page: string, at: string): TabLayout {
  if (page === MAIN_PAGE) return l;
  let n = l;
  for (const id of [...(l.extra ?? [])]) if (l.page?.[id] === page) n = removeCopy(n, id, at);
  const back = new Set(Object.entries(n.page ?? {}).filter(([, p]) => p === page).map(([id]) => id));
  return back.size ? tidy({ ...n, page: without(n.page, back), at }) : n;
}
/** The Add panel gallery: every panel and button this account can have, always (a removed one never leaves it),
 *  with how many sit on the page shown and on all pages. ps: running in PS on a Mac (some only work there). */
export type GalleryItem = { kind: string; label: string; here: number; all: number; removed: boolean; inner?: string };
export function gallery(l: TabLayout, page: string, red: boolean, ps: boolean, pages?: ReadonlySet<string>): GalleryItem[] {
  return SLOTS.filter((s) => !s.off && slotOk(s, red) && (ps || !s.ps) && !s.keep).map((s) => {
    const ids = [...(!s.inner && !s.optIn && !l.hidden.includes(s.id) ? [s.id] : []), ...(l.extra ?? []).filter((x) => kindOf(x) === s.id)];
    return { kind: s.id, label: s.label, here: ids.filter((id) => pageOf(l, id, pages) === page).length, all: ids.length, removed: !s.inner && !s.optIn && l.hidden.includes(s.id), ...(s.inner ? { inner: s.inner } : {}) };
  });
}

// ---------- where a moved panel sits ----------
const room = (screen: number, size: number) => Math.max(0, screen - 2 * EDGE - size);
/** A dropped panel's rectangle (CSS px) as its kept place. */
export function toPos(r: Rect, vw: number, vh: number): SlotPos {
  const rx = room(vw, r.width), ry = room(vh, r.height);
  return {
    x: frac(rx > 0 ? (r.left - EDGE) / rx : 0)!, y: frac(ry > 0 ? (r.top - EDGE) / ry : 0)!,
    w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)),
  };
}
/** Where a kept place lands on a screen of this size (the same rule as the CSS in taskmap.css .ed-moved). */
export function fromPos(p: SlotPos, vw: number, vh: number): Rect {
  const width = Math.min(p.w, Math.max(0, vw - 2 * EDGE)), height = Math.min(p.h, Math.max(0, vh - 2 * EDGE));
  return { left: EDGE + p.x * room(vw, width), top: EDGE + p.y * room(vh, height), width, height };
}
/** The lower half hangs from the bottom edge, so a panel that grows grows up and stays on screen. */
export const fromBottom = (p: SlotPos) => p.y > 0.5;
/** The inline style a moved panel gets: pure CSS, so it follows any screen size with no measuring. */
export function slotStyle(p0: SlotPos, z = 1): Record<string, string> {
  const p = z === 1 ? p0 : { ...p0, w: Math.round(p0.w * z), h: Math.round(p0.h * z) };
  const E = `${EDGE}px`;
  const x = `max(${E}, calc(${E} + ${p.x} * (100vw - ${2 * EDGE}px - ${p.w}px)))`;
  const s: Record<string, string> = { left: x, width: `min(${p.w}px, calc(100vw - ${2 * EDGE}px))` };
  if (fromBottom(p)) {
    const b = `max(${E}, calc(${E} + ${Math.round((1 - p.y) * 10000) / 10000} * (100vh - ${2 * EDGE}px - ${p.h}px)))`;
    s.bottom = b; s.maxHeight = `calc(100vh - ${E} - ${b})`;
  } else {
    const t = `max(${E}, calc(${E} + ${p.y} * (100vh - ${2 * EDGE}px - ${p.h}px)))`;
    s.top = t; s.maxHeight = `calc(100vh - ${E} - ${t})`;
  }
  return s;
}

/** V1.58 (the developer, 13 Nov 2026: "put the Pomodoro timer in between the time zones and the AI sentry mode by default"). A
 *  new button that follows another: on a list nobody rearranged it sits in its place in the column (TaskMap.tsx puts it
 *  there). On one where its leader was moved in Edit mode, and it was never moved itself, it sits right below the
 *  leader, the same distance in from the left. Hidden leader, another page, or moved itself: the usual place. */
export const FOLLOWS: Readonly<Record<string, string>> = { pomodoro: "clocks" };
export const FOLLOW_GAP = 8;
export function followStyle(l: TabLayout, id: string): Record<string, string> | null {
  const lead = FOLLOWS[id];
  if (!lead || isCopy(id) || l.pos[id] || l.hidden.includes(lead)) return null;
  const p = l.pos[lead];
  if (!p || (l.page?.[lead] ?? "main") !== (l.page?.[id] ?? "main")) return null;
  const z = sizeOf(l, lead), h = Math.round(p.h * z);
  const s = slotStyle(p, z);
  const out: Record<string, string> = { left: s.left };
  if (s.top) out.top = `calc(${s.top} + ${h + FOLLOW_GAP}px)`;
  else out.bottom = `max(${EDGE}px, calc(${s.bottom} - ${FOLLOW_GAP}px - 40px))`;
  return out;
}

/** Kept on screen: never past the margin on any side (a panel larger than the screen sits at the top left). */
export function clampRect(r: Rect, vw: number, vh: number): Rect {
  const left = Math.max(EDGE, Math.min(r.left, vw - EDGE - r.width));
  const top = Math.max(EDGE, Math.min(r.top, vh - EDGE - r.height));
  return { ...r, left, top };
}

export type Snapped = { left: number; top: number; gx: number | null; gy: number | null };
/** Snaps a rectangle being dragged: its edges and centre to the screen's margins and centre lines and to the edges
 *  and centres of the other panels, whichever is nearest within SNAP px, each axis on its own. gx/gy: the line it
 *  snapped to (for the pink guide), or null. The result is always on screen. */
export function snapRect(r: Rect, others: Rect[], vw: number, vh: number, near = SNAP): Snapped {
  const c = clampRect(r, vw, vh);
  const xs: number[] = [EDGE, vw / 2, vw - EDGE], ys: number[] = [EDGE, vh / 2, vh - EDGE];
  for (const o of others) {
    if (o.width <= 0 || o.height <= 0) continue;
    xs.push(o.left, o.left + o.width / 2, o.left + o.width);
    ys.push(o.top, o.top + o.height / 2, o.top + o.height);
  }
  const best = (start: number, size: number, lines: number[]) => {
    let move = 0, line: number | null = null, d = near + 0.001;
    for (const l of lines) for (const edge of [start, start + size / 2, start + size]) {
      const dd = Math.abs(l - edge);
      if (dd < d) { d = dd; move = l - edge; line = l; }
    }
    return { move, line };
  };
  const bx = best(c.left, c.width, xs), by = best(c.top, c.height, ys);
  const s = clampRect({ ...c, left: c.left + bx.move, top: c.top + by.move }, vw, vh);
  return { left: s.left, top: s.top, gx: s.left === c.left + bx.move ? bx.line : null, gy: s.top === c.top + by.move ? by.line : null };
}

// ---------- the record and the PS Tab list's op ----------
/** Several layout records can exist for a moment (two Macs saving at once): the newest wins, the rest are folded away. */
export function pickLayout<D extends { id: string; data: unknown; updatedAt?: string | null }>(docs: D[]): { keep: D | null; extra: D[] } {
  if (!docs.length) return { keep: null, extra: [] };
  const t = (d: D) => { const a = cleanLayout(d.data).at; return Date.parse(a || d.updatedAt || "") || 0; };
  const sorted = [...docs].sort((a, b) => t(b) - t(a) || (a.id < b.id ? -1 : 1));
  return { keep: sorted[0], extra: sorted.slice(1) };
}
export type LayoutOp = { op: "put"; id: string; data: TabLayout } | { op: "remove"; id: string };
const okId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);
/** The Tab list holds no keys: its save goes to the main page as this, checked again there. */
export function cleanLayoutOp(v: unknown): LayoutOp | null {
  const o = (v && typeof v === "object" ? v : {}) as { op?: unknown; id?: unknown; data?: unknown; kind?: unknown };
  if (!okId(o.id)) return null;
  if (o.op === "remove") return { op: "remove", id: o.id };
  if (o.op !== "put" || (o.kind !== undefined && o.kind !== "tablayout")) return null;
  return { op: "put", id: o.id, data: cleanLayout(o.data) };
}
