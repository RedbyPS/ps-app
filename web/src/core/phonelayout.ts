// The phone layout (V1.56, the developer 13 Nov 2026): "I want to be able to customize my GOS app and move stuff around in the
// GOS app while on the Mac version ... And I want the same thing on the iOS as well ... You can create new pages, you
// can move the navbar around, you can decide what stuff is in the navbar ... control where stuff is on the phone, what
// background your phone has, all the different appearance options."
//
// Pure functions only (tests/phonelayout.test.ts). One small encrypted vault record per phone kind (kind
// "phonelayout", owner private), separate from the Mac's Edit mode record (core/tablayout.ts), so a change on the Mac
// for the phone never moves anything on the Mac and the other way round. Written only when something changed.
//
// What a phone layout holds:
// - pages, left to right: the three built in panes the phone always had (Plan, List, Inbox) plus pages of panels made
//   here ("panels"). The List page is home and cannot be deleted; Plan and Inbox can be moved but not deleted (their
//   content is the phone's own); pages of panels can be added on either side, moved and deleted.
// - on a page of panels, tiles on a grid four columns wide (like an iPhone home screen): each tile is one panel or
//   button (Meetings, Timelines, Sleep...), any of them many times, moved and sized in whole cells.
// - the navbar (the dock): its edge (top or bottom), where it sits along that edge (full width, left, centre or right),
//   and which buttons it holds in which order. Settings is always in it (the way back to everything else).
// - each page's own background and look, and the phone's own (every page that has none of its own).
import { kindOf, copyId, slotLabel } from "./tablayout.ts";
import { mailAllowed } from "./mailflag.ts";

export type PhoneKind = "gos" | "ios";
export const PHONE_KINDS: readonly PhoneKind[] = ["gos", "ios"];
export const isPhoneKind = (v: unknown): v is PhoneKind => v === "gos" || v === "ios";
export const phoneName = (k: PhoneKind) => (k === "gos" ? "GrapheneOS" : "iPhone");

/** The grid: four cells across; a page of panels scrolls when it holds more rows than the screen shows. */
export const COLS = 4;
export const MAX_ROWS = 40;
export const MAX_H = 8;
export const MAX_PAGES = 12;
export const MAX_TILES = 40;
export const MAX_NAV = 8;

export type Tile = { id: string; c: number; r: number; w: number; h: number };
export type PageKind = "plan" | "list" | "inbox" | "panels";
export type PhonePage = { id: string; kind: PageKind; name?: string; tiles?: Tile[]; bg?: string; look?: string };
export type NavEdge = "top" | "bottom";
export type NavAlign = "full" | "left" | "center" | "right";
/** A navbar button: one of the phone's own, or "page:<id>" to open a page of panels. */
export type NavItem = string;
export type PhoneNav = { edge: NavEdge; align: NavAlign; items: NavItem[] };
export type PhoneLayout = { phone: PhoneKind; at: string; pages: PhonePage[]; nav: PhoneNav; bg?: string; look?: string };

/** The navbar buttons a phone has (the dock in gos/GosLayer.tsx). keep: never taken out. red: the developer's account only.
 *  optIn (PS 1.72, like the Tab list's Pomodoro in 1.70): not in the navbar by default; Edit mode's navbar list adds it, and
 *  it goes back in its own place in this order (toggleNav). add: its name in that list, when it differs from the button's.
 *  The order here is each button's place: a new default button goes where it should sit. */
export type NavInfo = { id: string; label: string; keep?: boolean; red?: boolean; optIn?: boolean; add?: string };
export const NAV_ITEMS: readonly NavInfo[] = [
  { id: "plan", label: "Plan" },
  { id: "list", label: "List" },
  { id: "inbox", label: "Inbox" },
  { id: "gym", label: "Gym" },
  // PS 1.72 (the developer, 21 Nov 2026): the Soundboard leaves the navbar by default, here and on the Mac's Tab list. Its own id, so a
  // navbar saved before 1.72 with the old "sounds" button no longer draws it (cleanNavItems drops ids it does not know;
  // carryUnknownPhone keeps the stored word for an older PS). Edit mode adds it back, in this place. This is the place a
  // new default button between Gym and Vault takes (the Clients workspace the developer has planned).
  { id: "soundboard", label: "Sounds", add: "Soundboard", optIn: true },
  { id: "vault", label: "Vault" },
  { id: "rules", label: "Rules", red: true },
  { id: "settings", label: "Settings", keep: true },
];
const NAV = new Map(NAV_ITEMS.map((n) => [n.id, n]));
const BUILT_IN: readonly PageKind[] = ["plan", "list", "inbox"];
export const HOME = "list";

/** The panels and buttons each phone can show on a page of panels (the editor's gallery offers only these, so it
 *  never offers what the phone cannot draw). Mac only ones (Sentry, the transparency slider, Away badge, Network,
 *  Volume mixer, Security, Second Computer, Tab and Lock) are never here. gos: PS GOS only (its shell clears the
 *  clipboard and counts screen time; the iPhone web app can do neither). red: the developer's account only. */
export type PhonePanel = { kind: string; w: number; h: number; gos?: boolean; red?: boolean; mail?: boolean };
export const PHONE_PANELS: readonly PhonePanel[] = [
  { kind: "meetings", w: 4, h: 4 },
  { kind: "clocks", w: 4, h: 2 },
  { kind: "timelines", w: 4, h: 1 },
  { kind: "series", w: 2, h: 1 },
  { kind: "dimx", w: 2, h: 2 },
  { kind: "overdue", w: 4, h: 4 },
  { kind: "meetnotes", w: 4, h: 4 },
  { kind: "leftovers", w: 4, h: 2 },
  { kind: "undo", w: 2, h: 1 },
  { kind: "endday", w: 2, h: 1 },
  { kind: "sleep", w: 2, h: 1 },
  { kind: "dnd", w: 1, h: 1 },
  { kind: "fitness", w: 1, h: 1 },
  { kind: "soundboard", w: 1, h: 1 },
  { kind: "screentime", w: 2, h: 1, gos: true },
  { kind: "clipboard", w: 1, h: 1, gos: true },
  { kind: "numerology", w: 2, h: 1, red: true },
  { kind: "rules", w: 1, h: 1, red: true },
  { kind: "brief", w: 1, h: 1, red: true },
  { kind: "mail", w: 4, h: 4, mail: true },
  { kind: "newtasks", w: 4, h: 4, red: true },
];
const PANEL = new Map(PHONE_PANELS.map((p) => [p.kind, p]));
/** Can this phone draw this panel? */
export function phoneCan(kind: string, phone: PhoneKind, red: boolean): boolean {
  const p = PANEL.get(kind);
  return !!p && (!p.gos || phone === "gos") && (p.mail ? mailAllowed() : !p.red || red);
}
/** The gallery for a page: every panel this phone can draw, with how many sit on this page and on the whole phone. */
export function phoneGallery(l: PhoneLayout, page: string, red: boolean): { kind: string; label: string; here: number; all: number }[] {
  const all = l.pages.flatMap((p) => p.tiles ?? []);
  const here = l.pages.find((p) => p.id === page)?.tiles ?? [];
  return PHONE_PANELS.filter((p) => phoneCan(p.kind, l.phone, red)).map((p) => ({
    kind: p.kind, label: slotLabel(p.kind), here: here.filter((t) => kindOf(t.id) === p.kind).length, all: all.filter((t) => kindOf(t.id) === p.kind).length,
  }));
}

/** The navbar a phone had before V1.56 (gos/GosLayer.tsx): every button, Rules only on the developer's account. */
export const defaultNavItems = (red: boolean): NavItem[] => NAV_ITEMS.filter((n) => (red || !n.red) && !n.optIn).map((n) => n.id);
export function defaultPhoneLayout(phone: PhoneKind, red = false): PhoneLayout {
  return { phone, at: "", pages: BUILT_IN.map((k) => ({ id: k, kind: k })), nav: { edge: "bottom", align: "full", items: defaultNavItems(red) } };
}

// ---------- checking a record ----------
const PAGE_ID = /^p[a-z0-9]{5,12}$/;
const TILE_ID = /^[a-z][a-z0-9-]{0,31}(\.[a-z0-9]{4,12})?$/;
const LOOKV = /^[A-Za-z0-9:#_-]{1,60}$/;
const int = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const cleanName = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u2013\u2014]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30) : "");
const lookVal = (v: unknown) => (typeof v === "string" && LOOKV.test(v) ? v : undefined);
function cleanTiles(v: unknown, phone: PhoneKind, red: boolean, seen: Set<string>): Tile[] {
  if (!Array.isArray(v)) return [];
  const out: Tile[] = [];
  for (const t of v.slice(0, MAX_TILES)) {
    if (!t || typeof t !== "object") continue;
    const q = t as Record<string, unknown>;
    const id = typeof q.id === "string" ? q.id : "";
    // A panel the phone cannot draw is dropped only when it is not known at all; a the developer only one on a stranger's
    // account never gets here (the gallery never offers it), and a kind switched off later is kept but not drawn.
    if (!TILE_ID.test(id) || !PANEL.has(kindOf(id)) || seen.has(id)) continue;
    { const pn = PANEL.get(kindOf(id))!; if (pn.mail ? !mailAllowed() : pn.red && !red) continue; }
    if (PANEL.get(kindOf(id))!.gos && phone !== "gos") continue;
    seen.add(id);
    const w = int(q.w, 1, COLS, 1), h = int(q.h, 1, MAX_H, 1);
    out.push({ id, w, h, c: int(q.c, 0, COLS - w, 0), r: int(q.r, 0, MAX_ROWS - h, 0) });
  }
  return settle(out, null);
}
/** A layout checked: known pages and panels only, the three built in pages always there exactly once, the grid kept
 *  in bounds with nothing overlapping, a navbar that always holds Settings. red: the developer's account. */
export function cleanPhoneLayout(v: unknown, phone: PhoneKind, red = false): PhoneLayout {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const pages: PhonePage[] = [];
  const ids = new Set<string>();
  const tileIds = new Set<string>();
  if (Array.isArray(o.pages)) for (const p of o.pages.slice(0, MAX_PAGES + BUILT_IN.length)) {
    if (!p || typeof p !== "object") continue;
    const q = p as Record<string, unknown>;
    const kind = q.kind;
    let page: PhonePage | null = null;
    if (BUILT_IN.includes(kind as PageKind) && q.id === kind && !ids.has(kind as string)) page = { id: kind as string, kind: kind as PageKind };
    else if (kind === "panels" && typeof q.id === "string" && PAGE_ID.test(q.id) && !ids.has(q.id) && pages.filter((x) => x.kind === "panels").length < MAX_PAGES) {
      page = { id: q.id, kind: "panels", tiles: cleanTiles(q.tiles, phone, red, tileIds) };
      const n = cleanName(q.name);
      if (n) page.name = n;
    }
    if (!page) continue;
    const bg = lookVal(q.bg), look = lookVal(q.look);
    if (bg) page.bg = bg;
    if (look) page.look = look;
    ids.add(page.id);
    pages.push(page);
  }
  // A built in page that is missing comes back where it always was (Plan left of the list, Inbox right of it).
  for (const k of BUILT_IN) {
    if (ids.has(k)) continue;
    const idx = (id: string) => pages.findIndex((p) => p.id === id);
    const at = k === "plan" ? (idx("list") >= 0 ? idx("list") : idx("inbox") >= 0 ? idx("inbox") : 0)
      : k === "list" ? (idx("plan") >= 0 ? idx("plan") + 1 : idx("inbox") >= 0 ? idx("inbox") : pages.length)
      : idx("list") + 1;
    pages.splice(at, 0, { id: k, kind: k });
    ids.add(k);
  }
  const n = (o.nav && typeof o.nav === "object" ? o.nav : {}) as Record<string, unknown>;
  const nav: PhoneNav = {
    edge: n.edge === "top" ? "top" : "bottom",
    align: n.align === "left" || n.align === "center" || n.align === "right" ? n.align : "full",
    items: cleanNavItems(Array.isArray(n.items) ? n.items : defaultNavItems(red), pages, red),
  };
  const out: PhoneLayout = { phone, at: typeof o.at === "string" && !Number.isNaN(Date.parse(o.at)) ? o.at : "", pages, nav };
  const bg = lookVal(o.bg), look = lookVal(o.look);
  if (bg) out.bg = bg;
  if (look) out.look = look;
  return out;
}
// PS 1.71 (item 3): a phone layout save never drops what this build cannot draw. A page of a kind it does not know (a
// newer PS's), a panel it does not know or cannot draw here, a navbar button it does not know, a field it does not know
// and a value it cannot read all stay in the record exactly where they were; what the person removed here stays removed.
const PHONE_TOP = new Set(["phone", "at", "pages", "nav", "bg", "look"]);
const PHONE_PAGE = new Set(["id", "kind", "name", "tiles", "bg", "look"]);
const PHONE_NAV = new Set(["edge", "align", "items"]);
type PObj = Record<string, unknown>;
const pobj = (v: unknown): v is PObj => !!v && typeof v === "object" && !Array.isArray(v);
/** Fields of `s` that `n` lacks: unknown ones (not in `known`), and known ones whose value `seen` (this build's reading
 *  of `s`) left out. */
function carryFields(s: PObj, n: PObj, seen: PObj, known: ReadonlySet<string>) {
  for (const [k, v] of Object.entries(s)) if (!(k in n) && v !== undefined && (!known.has(k) || !(k in seen))) n[k] = v;
}
/** `next` with every item of `stored` that `read` does not have put back after the stored item it followed. */
function carryPlaced<T>(stored: unknown[], next: T[], key: (x: unknown) => string | null, read: ReadonlySet<string>, inNext: ReadonlySet<string>): T[] {
  const out = [...next];
  let prev: string | null = null;
  for (const x of stored) {
    const k = key(x);
    if (k === null) continue;
    if (!read.has(k) && !inNext.has(k) && !out.some((y) => key(y) === k)) {
      const i = prev === null ? -1 : out.findIndex((y) => key(y) === prev);
      out.splice(i + 1, 0, x as T);
    }
    if (out.some((y) => key(y) === k)) prev = k;
  }
  return out;
}
/** The phone layout to write: `next` (cleaned, what this build changed) plus everything of the stored record it cannot draw. */
export function carryUnknownPhone(stored: unknown, next: PhoneLayout, red = false): PhoneLayout {
  if (!pobj(stored)) return next;
  const was = cleanPhoneLayout(stored, next.phone, red);
  const wasPages = new Map(was.pages.map((p) => [p.id, p as unknown as PObj]));
  const rawPages = Array.isArray(stored.pages) ? stored.pages : [];
  const pid = (x: unknown) => (pobj(x) && typeof x.id === "string" ? x.id : null);
  const nextTiles = new Set(next.pages.flatMap((p) => (p.tiles ?? []).map((t) => t.id)));
  const readTiles = new Set(was.pages.flatMap((p) => (p.tiles ?? []).map((t) => t.id)));
  let pages = next.pages.map((p) => {
    const n = { ...p } as unknown as PObj;
    const s = rawPages.find((x) => pid(x) === p.id), r = wasPages.get(p.id);
    if (!pobj(s) || !r) return n;
    carryFields(s, n, r, PHONE_PAGE);
    if (p.kind === "panels" && Array.isArray(s.tiles)) {
      n.tiles = carryPlaced(s.tiles, [...(p.tiles ?? [])], pid, readTiles, nextTiles);
    }
    return n;
  });
  pages = carryPlaced(rawPages, pages, pid, new Set(wasPages.keys()), new Set(next.pages.map((p) => p.id)));
  const out = { ...next, pages } as unknown as PObj;
  const sn = pobj(stored.nav) ? stored.nav : {}, nav = { ...next.nav } as unknown as PObj;
  if (Array.isArray(sn.items)) {
    const readItems = new Set(was.nav.items);
    nav.items = carryPlaced(sn.items, [...next.nav.items], (x) => (typeof x === "string" ? x : null), readItems, new Set(next.nav.items));
  }
  carryFields(sn, nav, was.nav as unknown as PObj, PHONE_NAV);
  out.nav = nav;
  carryFields(stored, out, was as unknown as PObj, PHONE_TOP);
  return out as unknown as PhoneLayout;
}

/** The navbar's buttons checked: known ones, pages that exist, no twice, Settings always (added at the end if missing). */
export function cleanNavItems(items: unknown[], pages: PhonePage[], red: boolean): NavItem[] {
  const out: NavItem[] = [];
  for (const x of items) {
    if (typeof x !== "string" || out.includes(x)) continue;
    if (x.startsWith("page:")) { if (pages.some((p) => p.kind === "panels" && `page:${p.id}` === x)) out.push(x); continue; }
    const n = NAV.get(x);
    if (n && (red || !n.red)) out.push(x);
  }
  if (!out.includes("settings")) out.push("settings");
  // Too many: the last ones go, but never Settings.
  while (out.length > MAX_NAV) out.splice(out.length - 2, 1);
  return out;
}

// ---------- the grid ----------
const overlap = (a: Tile, b: Tile) => a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h;
/** Nothing overlaps: the tile just moved (first) keeps its place, the others in reading order move down until they
 *  fit (the way an iPhone home screen makes room). Pure and stable: the same tiles always settle the same way. */
export function settle(tiles: Tile[], first: string | null): Tile[] {
  const fixed: Tile[] = [];
  const lead = first ? tiles.find((t) => t.id === first) : undefined;
  if (lead) fixed.push({ ...lead });
  const rest = tiles.filter((t) => t !== lead).sort((a, b) => a.r - b.r || a.c - b.c);
  for (const t0 of rest) {
    const t = { ...t0 };
    while (fixed.some((f) => overlap(f, t)) && t.r < MAX_ROWS - t.h) t.r++;
    fixed.push(t);
  }
  // Back in the order they came (the record stays the same when nothing moved).
  return tiles.map((t) => fixed.find((f) => f.id === t.id)!);
}
/** The first free place for a tile this size, reading order (top row first, left first). */
export function freeSpot(tiles: Tile[], w: number, h: number): { c: number; r: number } {
  for (let r = 0; r <= MAX_ROWS - h; r++) for (let c = 0; c <= COLS - w; c++) {
    const t = { id: "", c, r, w, h };
    if (!tiles.some((x) => overlap(x, t))) return { c, r };
  }
  return { c: 0, r: Math.max(0, MAX_ROWS - h) };
}
/** How many rows a page uses (its height on screen). */
export const rowsUsed = (tiles: Tile[]) => tiles.reduce((m, t) => Math.max(m, t.r + t.h), 0);

// ---------- changes (each returns a new layout; the same object when nothing changed) ----------
const withPage = (l: PhoneLayout, page: string, f: (p: PhonePage) => PhonePage | null, at: string): PhoneLayout => {
  const i = l.pages.findIndex((p) => p.id === page);
  if (i < 0) return l;
  const next = f(l.pages[i]);
  if (!next || next === l.pages[i]) return l;
  const pages = [...l.pages];
  pages[i] = next;
  return { ...l, pages, at };
};
const tilesOf = (l: PhoneLayout, page: string) => l.pages.find((p) => p.id === page)?.tiles ?? [];
const allTileIds = (l: PhoneLayout) => new Set(l.pages.flatMap((p) => (p.tiles ?? []).map((t) => t.id)));
/** A new page id ("p" and 8 letters or digits). rnd: for the tests. */
export function newPageId(rnd?: () => number): string {
  const r = rnd ?? (() => { const b = new Uint8Array(1); crypto.getRandomValues(b); return b[0] / 256; });
  let t = "p";
  for (let i = 0; i < 8; i++) t += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(r() * 36) % 36];
  return t;
}
/** A new page of panels at this place in the order (0: far left). Named "Page 2", "Page 3"... Null id: the limit. */
export function addPage(l: PhoneLayout, index: number, at: string, rnd?: () => number): { layout: PhoneLayout; id: string | null } {
  const mine = l.pages.filter((p) => p.kind === "panels");
  if (mine.length >= MAX_PAGES) return { layout: l, id: null };
  let id = newPageId(rnd);
  while (l.pages.some((p) => p.id === id)) id = newPageId(rnd);
  let k = mine.length + 2;
  while (mine.some((p) => p.name === `Page ${k}`)) k++;
  const pages = [...l.pages];
  pages.splice(Math.max(0, Math.min(pages.length, index)), 0, { id, kind: "panels", name: `Page ${k}`, tiles: [] });
  return { layout: { ...l, pages, at }, id };
}
/** A page of panels deleted (its tiles go; the gallery still has them). The built in pages are never deleted. */
export function removePage(l: PhoneLayout, id: string, at: string): PhoneLayout {
  const p = l.pages.find((x) => x.id === id);
  if (!p || p.kind !== "panels") return l;
  return { ...l, pages: l.pages.filter((x) => x.id !== id), nav: { ...l.nav, items: l.nav.items.filter((x) => x !== `page:${id}`) }, at };
}
/** The pages in a new order (every page once; anything else is ignored). */
export function orderPages(l: PhoneLayout, ids: string[], at: string): PhoneLayout {
  const have = new Map(l.pages.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const pages: PhonePage[] = [];
  for (const id of ids) { const p = have.get(id); if (p && !seen.has(id)) { seen.add(id); pages.push(p); } }
  for (const p of l.pages) if (!seen.has(p.id)) pages.push(p);
  if (pages.every((p, i) => p === l.pages[i])) return l;
  return { ...l, pages, at };
}
/** One page moved one step left (-1) or right (+1). */
export function shiftPage(l: PhoneLayout, id: string, dir: -1 | 1, at: string): PhoneLayout {
  const i = l.pages.findIndex((p) => p.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= l.pages.length) return l;
  const ids = l.pages.map((p) => p.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return orderPages(l, ids, at);
}
export function renamePage(l: PhoneLayout, id: string, name: string, at: string): PhoneLayout {
  const n = cleanName(name);
  return withPage(l, id, (p) => (p.kind !== "panels" || !n || p.name === n ? null : { ...p, name: n }), at);
}
/** A panel added from the gallery onto a page of panels: the original id the first time on this phone, then copies.
 *  Placed at its usual size in the first free place. */
export function addTile(l: PhoneLayout, page: string, kind: string, red: boolean, at: string, rnd?: () => number): { layout: PhoneLayout; id: string | null } {
  const pg = l.pages.find((p) => p.id === page);
  const info = PANEL.get(kind);
  if (!pg || pg.kind !== "panels" || !info || !phoneCan(kind, l.phone, red)) return { layout: l, id: null };
  const tiles = pg.tiles ?? [];
  if (l.pages.reduce((n, p) => n + (p.tiles?.length ?? 0), 0) >= MAX_TILES) return { layout: l, id: null };
  const used = allTileIds(l);
  let id = kind;
  if (used.has(id)) { id = copyId(kind, rnd); while (used.has(id)) id = copyId(kind, rnd); }
  const spot = freeSpot(tiles, info.w, info.h);
  const t: Tile = { id, w: info.w, h: info.h, ...spot };
  return { layout: withPage(l, page, (p) => ({ ...p, tiles: [...tiles, t] }), at), id };
}
export function removeTile(l: PhoneLayout, page: string, id: string, at: string): PhoneLayout {
  return withPage(l, page, (p) => (p.tiles?.some((t) => t.id === id) ? { ...p, tiles: p.tiles.filter((t) => t.id !== id) } : null), at);
}
/** A tile dropped at a cell (kept on the grid); the others make room below it. */
export function moveTile(l: PhoneLayout, page: string, id: string, c: number, r: number, at: string): PhoneLayout {
  return withPage(l, page, (p) => {
    const t = p.tiles?.find((x) => x.id === id);
    if (!t) return null;
    const nc = int(c, 0, COLS - t.w, t.c), nr = int(r, 0, MAX_ROWS - t.h, t.r);
    if (nc === t.c && nr === t.r) return null;
    return { ...p, tiles: settle(p.tiles!.map((x) => (x.id === id ? { ...x, c: nc, r: nr } : x)), id) };
  }, at);
}
/** A tile sized (in cells, kept on the grid: a tile too wide for its column moves left). */
export function resizeTile(l: PhoneLayout, page: string, id: string, w: number, h: number, at: string): PhoneLayout {
  return withPage(l, page, (p) => {
    const t = p.tiles?.find((x) => x.id === id);
    if (!t) return null;
    const nw = int(w, 1, COLS, t.w), nh = int(h, 1, MAX_H, t.h);
    if (nw === t.w && nh === t.h) return null;
    const nc = Math.min(t.c, COLS - nw);
    return { ...p, tiles: settle(p.tiles!.map((x) => (x.id === id ? { ...x, w: nw, h: nh, c: nc } : x)), id) };
  }, at);
}
/** A tile moved to another page of panels (to its first free place there). */
export function tileToPage(l: PhoneLayout, from: string, id: string, to: string, at: string): PhoneLayout {
  const t = tilesOf(l, from).find((x) => x.id === id);
  const dest = l.pages.find((p) => p.id === to);
  if (!t || from === to || !dest || dest.kind !== "panels") return l;
  const n = removeTile(l, from, id, at);
  const spot = freeSpot(dest.tiles ?? [], t.w, t.h);
  return withPage(n, to, (p) => ({ ...p, tiles: [...(p.tiles ?? []), { ...t, ...spot }] }), at);
}

// ---------- the navbar ----------
export function setNavEdge(l: PhoneLayout, edge: NavEdge, at: string): PhoneLayout {
  return l.nav.edge === edge ? l : { ...l, nav: { ...l.nav, edge }, at };
}
export function setNavAlign(l: PhoneLayout, align: NavAlign, at: string): PhoneLayout {
  return l.nav.align === align ? l : { ...l, nav: { ...l.nav, align }, at };
}
export function setNavItems(l: PhoneLayout, items: NavItem[], red: boolean, at: string): PhoneLayout {
  const next = cleanNavItems(items, l.pages, red);
  return next.join() === l.nav.items.join() ? l : { ...l, nav: { ...l.nav, items: next }, at };
}
/** A button put in the navbar (at the end, before Settings) or taken out (never Settings). */
export function toggleNav(l: PhoneLayout, item: NavItem, red: boolean, at: string): PhoneLayout {
  if (l.nav.items.includes(item)) return NAV.get(item)?.keep ? l : setNavItems(l, l.nav.items.filter((x) => x !== item), red, at);
  if (l.nav.items.length >= MAX_NAV) return l;
  const items = [...l.nav.items];
  // An opt in button goes back in its own place: before the first button that comes after it in NAV_ITEMS.
  const rank = (x: NavItem) => NAV_ITEMS.findIndex((n) => n.id === x);
  const mine = NAV.get(item)?.optIn ? rank(item) : -1;
  const after = mine < 0 ? -1 : items.findIndex((x) => rank(x) > mine);
  const s = items.indexOf("settings");
  items.splice(after >= 0 ? after : s < 0 ? items.length : s, 0, item);
  return setNavItems(l, items, red, at);
}
/** Every button this account can put in the navbar: the phone's own and one per page of panels. */
export function navChoices(l: PhoneLayout, red: boolean): { id: NavItem; label: string; keep: boolean; on: boolean }[] {
  const own = NAV_ITEMS.filter((n) => red || !n.red).map((n) => ({ id: n.id, label: n.add ?? n.label, keep: !!n.keep }));
  const pages = l.pages.filter((p) => p.kind === "panels").map((p) => ({ id: `page:${p.id}`, label: p.name || "Page", keep: false }));
  return [...own, ...pages].map((x) => ({ ...x, on: l.nav.items.includes(x.id) }));
}
export const navLabel = (l: PhoneLayout, item: NavItem) =>
  item.startsWith("page:") ? l.pages.find((p) => `page:${p.id}` === item)?.name || "Page" : NAV.get(item)?.label ?? item;

// ---------- each page's background and look ----------
/** A page's own background or look ("" or null: the phone's own). page null: the phone's own (every page without one). */
export function setLook(l: PhoneLayout, page: string | null, part: "bg" | "look", v: string | null, at: string): PhoneLayout {
  const val = v ? lookVal(v) : undefined;
  if (v && !val) return l;
  if (page === null) {
    if ((l[part] ?? null) === (val ?? null)) return l;
    const n = { ...l, at };
    if (val) n[part] = val; else delete n[part];
    return n;
  }
  return withPage(l, page, (p) => {
    if ((p[part] ?? null) === (val ?? null)) return null;
    const n = { ...p };
    if (val) n[part] = val; else delete n[part];
    return n;
  }, at);
}
/** What a page shows: its own background and look, else the phone's own, else null (the account's usual one). */
export function lookOf(l: PhoneLayout, page: string): { bg: string | null; look: string | null } {
  const p = l.pages.find((x) => x.id === page);
  return { bg: p?.bg ?? l.bg ?? null, look: p?.look ?? l.look ?? null };
}

// ---------- the record ----------
export const isDefaultPhone = (l: PhoneLayout, red = false) => samePhoneLayout(l, defaultPhoneLayout(l.phone, red), red);
function canon(l: PhoneLayout, red: boolean): string {
  const c = cleanPhoneLayout(l, l.phone, red);
  return JSON.stringify({ ...c, at: "" });
}
/** Same pages, tiles, navbar and looks (the time does not count): no save is needed. */
export const samePhoneLayout = (a: PhoneLayout, b: PhoneLayout, red = false) => a.phone === b.phone && canon(a, red) === canon(b, red);
/** The record for one phone kind among the account's records: the newest (two devices saving at once), the rest are
 *  folded away. */
export function pickPhoneLayout<D extends { id: string; data: unknown; updatedAt?: string | null }>(docs: D[], phone: PhoneKind): { keep: D | null; extra: D[] } {
  const mine = docs.filter((d) => (d.data as { phone?: unknown } | null)?.phone === phone);
  if (!mine.length) return { keep: null, extra: [] };
  const t = (d: D) => Date.parse((d.data as { at?: string }).at || d.updatedAt || "") || 0;
  const sorted = [...mine].sort((a, b) => t(b) - t(a) || (a.id < b.id ? -1 : 1));
  return { keep: sorted[0], extra: sorted.slice(1) };
}
export type PhoneLayoutOp = { op: "put"; id: string; data: PhoneLayout };
const okId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);
/** The PS Tab list holds no keys: its save goes to the main page as this, checked again there. */
export function cleanPhoneLayoutOp(v: unknown, red = false): PhoneLayoutOp | null {
  const o = (v && typeof v === "object" ? v : {}) as { op?: unknown; id?: unknown; data?: unknown; kind?: unknown };
  if (!okId(o.id) || o.op !== "put" || (o.kind !== undefined && o.kind !== "phonelayout")) return null;
  const phone = (o.data as { phone?: unknown } | null)?.phone;
  if (!isPhoneKind(phone)) return null;
  return { op: "put", id: o.id, data: cleanPhoneLayout(o.data, phone, red) };
}
/** A tile's name (a copy is the same panel again, so it has its kind's name). */
export const tileLabel = (id: string) => slotLabel(kindOf(id));

// ---------- the grid on screen (the Mac's editor and the phone draw tiles with these same numbers) ----------
export const GRID_PAD = 14, GRID_GAP = 10, ROW_H = 64;
/** The width of one cell on a screen this wide (CSS px). */
export const cellW = (width: number) => Math.max(20, (width - 2 * GRID_PAD - (COLS - 1) * GRID_GAP) / COLS);
/** Where a tile is drawn on a page this wide: px from the grid's top left. */
export function cellBox(t: Pick<Tile, "c" | "r" | "w" | "h">, width: number): { left: number; top: number; width: number; height: number } {
  const cw = cellW(width);
  return { left: GRID_PAD + t.c * (cw + GRID_GAP), top: t.r * (ROW_H + GRID_GAP), width: t.w * cw + (t.w - 1) * GRID_GAP, height: t.h * ROW_H + (t.h - 1) * GRID_GAP };
}
/** The cell a tile w by h lands on when its top left corner is dropped at (x, y) on a page this wide (kept on the grid). */
export function cellAt(x: number, y: number, width: number, w: number, h: number): { c: number; r: number } {
  const cw = cellW(width);
  return { c: int((x - GRID_PAD) / (cw + GRID_GAP), 0, COLS - w, 0), r: int(y / (ROW_H + GRID_GAP), 0, MAX_ROWS - h, 0) };
}
/** The size in cells a tile gets when its corner is dragged to this width and height (px). */
export function cellsFor(px: number, py: number, width: number): { w: number; h: number } {
  const cw = cellW(width);
  return { w: int((px + GRID_GAP) / (cw + GRID_GAP), 1, COLS, 1), h: int((py + GRID_GAP) / (ROW_H + GRID_GAP), 1, MAX_H, 1) };
}
