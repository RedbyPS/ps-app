// PS 1.71 (item 3, Jan 19 Nov 2026: "I always created like a new list, new page, and it always deletes all my pages and
// puts everything in the first main page"): no build ever deletes, collapses or saves over ids, pages or fields it does
// not know. Reading may leave them out (they are not drawn); writing puts them back exactly as they were stored.
//
// 1. carrySettings (core/actions.ts saveSettings, the one place every settings write goes through): the lists of pages,
//    their order, the section order and the task groups keep every page, section, group and field this build cannot
//    read (a newer PS's, or another build's). What the person removed here stays removed: only what this build's own
//    cleaners (core/lists.ts cleanPages, core/groups.ts cleanGroups and cleanSecOrder) leave out is carried.
// 2. mergeLists (core/cardsync.ts mergeSettings): a device whose copy was old when the person changed a list (opened
//    after a long sleep, or offline) no longer puts its whole old list over the server's. Page by page and id by id,
//    what it changed comes from it; what the other devices made or changed meanwhile stays.
// 3. lostPanelPages (views/ListPager.tsx restoreLostPages, the developer's yes to R4 on 20 Nov 2026): a page that held panels and
//    is gone from the list of pages, while the Tab layout still puts panels on it, comes back as a page of panels with
//    those panels on it. Lists and their names cannot come back (nothing remembers them). A page the person deleted
//    (tmPagesGone) never comes back.
import type { Settings, TaskGroup } from "./model";
import { MAIN, PAGES_MAX, cleanPages, type ListPage } from "./lists.ts";
import { cleanGroups, cleanSecOrder } from "./groups.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const idOf = (v: unknown): string | null => (isObj(v) && typeof v.id === "string" ? v.id : null);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PAGE_ID = /^[a-z0-9]{4,24}$/;
const SEC_KEY = /^(p1|prio|daily|g:[a-z0-9]{4,24})$/;
/** The page fields core/lists.ts cleanPages reads; any other field is a newer build's and is carried. */
const PAGE_KEYS = new Set(["id", "name", "secs", "bg", "look", "kind"]);
const GROUP_KEYS = new Set(["id", "name"]);
/** Deleted pages remembered (the newest last), so a page the person deleted is never brought back (lostPanelPages). */
export const GONE_MAX = 60;

/** `next` with every key of `stored` that `known` rejects put back after the stored key it followed (strings only). */
export function carryKeys(stored: unknown, next: readonly string[], known: (k: string) => boolean): string[] {
  const out = [...next];
  if (!Array.isArray(stored)) return out;
  let prev: string | null = null;
  for (const k of stored) {
    if (typeof k !== "string") continue;
    if (!known(k) && !out.includes(k)) {
      const i = prev === null ? -1 : out.indexOf(prev);
      out.splice(i + 1, 0, k);
    }
    if (out.includes(k)) prev = k;
  }
  return out;
}

/**
 * A list of objects with ids (pages, groups): `next` (what this build writes, from its cleaned copy) with
 * - every stored item this build could not read at all (`readIds` lacks it) back after the stored item it followed;
 * - every item in both keeping the stored fields this build does not know (`keys`), and a stored value of a known
 *   field this build rejected (`readOf` lacks it) when `next` has none;
 * - `fix` for the rest (a page's sections).
 * An item this build read and `next` left out was removed by the person: it stays removed.
 */
function carryById<T extends { id: string }>(stored: unknown, next: readonly T[], readOf: Map<string, Obj>, keys: ReadonlySet<string>,
  fix?: (s: Obj, n: Obj) => void): Obj[] {
  const out: Obj[] = next.map((n) => ({ ...n }));
  if (!Array.isArray(stored)) return out;
  const raw = new Map<string, Obj>();
  for (const s of stored) { const id = idOf(s); if (id !== null && !raw.has(id)) raw.set(id, s as Obj); }
  for (const n of out) {
    const s = raw.get(n.id as string), r = readOf.get(n.id as string);
    if (!s || !r) continue;
    for (const [k, v] of Object.entries(s)) {
      if (k in n) continue;
      if (!keys.has(k) || !(k in r)) n[k] = v;   // a field this build does not know, or a value of it this build could not read
    }
    fix?.(s, n);
  }
  let prev: string | null = null;
  const seen = new Set<string>();
  for (const s of stored) {
    const id = idOf(s);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    if (!readOf.has(id) && id !== MAIN && !out.some((x) => x.id === id)) {
      const i = prev === null ? -1 : out.findIndex((x) => x.id === prev);
      out.splice(i + 1, 0, { ...(s as Obj) });
    }
    if (out.some((x) => x.id === id)) prev = id;
  }
  return out;
}

/** tmPages to write: `next` plus every page, field and section key of the stored list this build cannot read. */
export function carryPages(stored: unknown, next: readonly ListPage[]): ListPage[] {
  const read = new Map(cleanPages(stored).map((p) => [p.id, p as unknown as Obj]));
  return carryById(stored, next, read, PAGE_KEYS, (s, n) => {
    n.secs = carryKeys(s.secs, Array.isArray(n.secs) ? (n.secs as string[]) : [], (k) => SEC_KEY.test(k));
  }) as unknown as ListPage[];
}
/** The ids of pages in a stored list that this build cannot read (a newer id, or past this build's page limit). */
function unreadPageIds(stored: unknown): Set<string> {
  const read = new Set(cleanPages(stored).map((p) => p.id)), out = new Set<string>();
  if (Array.isArray(stored)) for (const s of stored) { const id = idOf(s); if (id !== null && id !== MAIN && !read.has(id)) out.add(id); }
  return out;
}
/** tmPageOrder to write: `next` plus the place of every page this build cannot read, and of ids it cannot read. */
export function carryPageOrder(stored: unknown, next: readonly string[], storedPages: unknown): string[] {
  const unread = unreadPageIds(storedPages);
  return carryKeys(stored, next, (k) => !unread.has(k) && (k === MAIN || PAGE_ID.test(k)));
}
/** tmSecOrder to write: `next` plus every section key this build cannot read, in its place. */
export function carrySecOrder(stored: unknown, next: readonly string[]): string[] {
  const read = new Set(cleanSecOrder(stored));
  return carryKeys(stored, next, (k) => read.has(k) || SEC_KEY.test(k));
}
/** tmGroups to write: `next` plus every group and group field this build cannot read. */
export function carryGroups(stored: unknown, next: readonly TaskGroup[]): TaskGroup[] {
  const read = new Map(cleanGroups(stored).map((g) => [g.id, g as unknown as Obj]));
  return carryById(stored, next, read, GROUP_KEYS) as unknown as TaskGroup[];
}

/** Pages this build could read in `stored` and that `next` no longer has: the person deleted them (by hand, a look, a
 *  reset). Added to tmPagesGone; a page that is back (Undo) leaves it. */
export function goneAfter(stored: unknown, next: readonly { id: string }[], gone: unknown): string[] {
  const now = new Set(next.map((p) => p.id));
  const was = Array.isArray(gone) ? gone.filter((x): x is string => typeof x === "string" && PAGE_ID.test(x)) : [];
  const out = was.filter((id) => !now.has(id));
  for (const p of cleanPages(stored)) if (!now.has(p.id) && !out.includes(p.id)) out.push(p.id);
  return out.slice(-GONE_MAX);
}

/**
 * The one settings write (core/actions.ts saveSettings): the patch with every list it sets carried over the stored
 * record (`stored`: this device's copy as stored, never cleaned). Keys it does not set are not touched.
 */
export function carrySettings(stored: Partial<Settings> | null | undefined, patch: Partial<Settings>): Partial<Settings> {
  const s = (stored ?? {}) as Obj, p = { ...patch } as Obj;
  if (Array.isArray(p.tmPages)) {
    p.tmPages = carryPages(s.tmPages, p.tmPages as ListPage[]);
    const gone = goneAfter(s.tmPages, p.tmPages as ListPage[], s.tmPagesGone);
    if (!same(gone, Array.isArray(s.tmPagesGone) ? s.tmPagesGone : [])) p.tmPagesGone = gone;
  }
  if (Array.isArray(p.tmPageOrder)) p.tmPageOrder = carryPageOrder(s.tmPageOrder, p.tmPageOrder as string[], s.tmPages);
  if (Array.isArray(p.tmSecOrder)) p.tmSecOrder = carrySecOrder(s.tmSecOrder, p.tmSecOrder as string[]);
  if (Array.isArray(p.tmGroups)) p.tmGroups = carryGroups(s.tmGroups, p.tmGroups as TaskGroup[]);
  return p as Partial<Settings>;
}

// ---------- 2. merging a list changed on an old copy ----------

/** The settings that are lists merged item by item (mergeLists), never one device's whole list over the other's. */
export const LIST_KEYS: ReadonlySet<string> = new Set(["tmPages", "tmPageOrder", "tmSecOrder", "tmGroups", "tmPagesGone"]);

/** Strings: this device's order, with what the server added meanwhile after the item it followed there, and without
 *  what the server removed meanwhile (that this device still had as it was). */
function mergeOrder(base: unknown[], local: unknown[], remote: unknown[]): unknown[] {
  const B = new Set(base.map((x) => JSON.stringify(x))), L = new Set(local.map((x) => JSON.stringify(x))), R = new Set(remote.map((x) => JSON.stringify(x)));
  const out = local.filter((x) => { const k = JSON.stringify(x); return R.has(k) || !B.has(k); });
  let prev: unknown = undefined;
  for (const x of remote) {
    const k = JSON.stringify(x);
    if (!L.has(k) && !B.has(k) && !out.some((y) => JSON.stringify(y) === k)) {
      const i = prev === undefined ? -1 : out.findIndex((y) => JSON.stringify(y) === JSON.stringify(prev));
      out.splice(i + 1, 0, x);
    }
    if (out.some((y) => JSON.stringify(y) === k)) prev = x;
  }
  return out;
}
/** Items with ids: each item from the side that changed it (this device when both did); one side's new items kept;
 *  an item one side removed is removed, unless the other side changed it meanwhile (a change is never lost). */
function mergeItems(base: unknown[], local: unknown[], remote: unknown[]): unknown[] {
  const map = (a: unknown[]) => { const m = new Map<string, unknown>(); for (const x of a) { const id = idOf(x); if (id !== null && !m.has(id)) m.set(id, x); } return m; };
  const B = map(base), L = map(local), R = map(remote);
  const pick = (id: string): unknown => {
    const b = B.get(id), l = L.get(id), r = R.get(id);
    if (l !== undefined && r !== undefined) return b !== undefined && same(l, b) ? r : l;
    if (l !== undefined) return b !== undefined && same(l, b) ? undefined : l;   // the server removed it; kept if changed here
    if (r !== undefined) return b !== undefined && same(r, b) ? undefined : r;   // removed here; kept if changed there
    return undefined;
  };
  const out: unknown[] = [];
  for (const x of local) { const id = idOf(x); if (id === null) { out.push(x); continue; } const v = pick(id); if (v !== undefined && !out.some((y) => idOf(y) === id)) out.push(v); }
  let prev: string | null = null;
  for (const x of remote) {
    const id = idOf(x);
    if (id === null) continue;
    if (!out.some((y) => idOf(y) === id)) {
      const v = pick(id);
      if (v !== undefined) { const i = prev === null ? -1 : out.findIndex((y) => idOf(y) === prev); out.splice(i + 1, 0, v); }
    }
    if (out.some((y) => idOf(y) === id)) prev = id;
  }
  return out;
}
/**
 * One list setting this device changed, merged with the server's newer copy. base: the list as it was on this device
 * before its unsent change (core/actions.ts keeps it). Without a base (a change from before PS 1.71): this device's.
 */
export function mergeLists(key: string, base: unknown, local: unknown, remote: unknown): unknown {
  if (!LIST_KEYS.has(key) || !Array.isArray(local) || !Array.isArray(remote) || base === undefined) return local;
  const b = Array.isArray(base) ? base : [];
  return key === "tmPages" || key === "tmGroups" ? mergeItems(b, local, remote) : mergeOrder(b, local, remote);
}

// ---------- 3. pages of panels that got lost ----------

/**
 * Pages the Tab layout still puts panels on (`layoutPages`: a panel id to its page, from the cleaned layout, so only
 * panels this build knows) that are not in the list of pages and were not deleted by the person: each comes back as a
 * page of panels, in the order first seen. name(n): the name of the n-th page of panels (views/ListPager.tsx).
 */
export function lostPanelPages(layoutPages: Record<string, string> | undefined, st: Pick<Settings, "tmPages"> & { tmPagesGone?: unknown },
  name: (n: number) => string): ListPage[] {
  const pages = cleanPages(st.tmPages);
  const have = new Set([MAIN, ...pages.map((p) => p.id)]);
  const gone = new Set(Array.isArray(st.tmPagesGone) ? st.tmPagesGone.filter((x): x is string => typeof x === "string") : []);
  const unread = unreadPageIds(st.tmPages);
  const out: ListPage[] = [];
  let n = pages.filter((p) => p.kind === "panels").length + 2;
  for (const page of Object.values(layoutPages ?? {})) {
    if (typeof page !== "string" || !PAGE_ID.test(page) || have.has(page) || gone.has(page) || unread.has(page)) continue;
    if (pages.length + out.length >= PAGES_MAX) break;
    have.add(page);
    out.push({ id: page, name: name(n++), secs: [], kind: "panels" });
  }
  return out;
}
