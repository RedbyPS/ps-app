// Several to-do lists as pages in the Tab list, like the iPhone home screen (V1.55, rules in core/lists.ts). This file
// draws them and moves them:
// - the pager: the current page in the list column; while a swipe moves, its neighbours are drawn beside it and the
//   whole strip of pages follows the fingers (one transform a frame), then a spring carries it home.
// - the main list is home; lists sit on both sides of it. Past the first and the last page there is an empty page with
//   a big + in the middle of the screen. Click it: the + flies in an arc to the green Add task button and turns into
//   it, then "Create a to-do list" asks for a name. Enter makes the list there and opens Add task for it.
// - dots at the bottom middle of the screen, the home one a little different; while a swipe moves, the bright dot
//   slides between them with the fingers. Click a dot to go there; long press or right click a dot (or the list's
//   name under the headline): Rename, Move left, Move right, Page background, Page look, the swipe direction, Delete.
// - moving: a two finger trackpad swipe anywhere on the list (PS says when the fingers lift, ps-mac PageSwipe.swift),
//   a finger on the phone, the Left and Right arrow keys (also with Tab held), or a dot. The V1.34 row swipe is gone.
// - each page can have its own background and look (only the looks on offer, core/looks.ts offeredLooks); they change
//   as the page lands. Only the shown page's video plays.
// - section names: Priority 1, Priorities, Every day and Completed rename by double click (Enter saves, Esc cancels;
//   blank goes back to the usual name). A right click on any section header: Rename, Move to list.
// - moving tasks: drag a task onto a dot, or to the left or right edge of the list, or the task menu's Move to list.
// - for the first use tips (another chat): window events "ps-page-swiped" {from, to, how} after a page lands, and
//   "ps-list-created" {id, name} when a new list is there.
// Everything is saved in settings (one change-only write each), so the Mac, the website and the phone match.
import { panelOpen } from "../core/phonepanels";
import { MWEB, haptic as gosHaptic } from "../gos/bridge";
import * as pd from "../core/pagedots";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import type { Doc, Settings, TaskGroup, Todo } from "../core/model";
import { cleanGroups, groupKey, groupOf, newGroupId, type TabLists } from "../core/groups";
import { isEveryDay } from "../core/repeat";
import { BG_DESIGNS, bgDesign } from "../core/prio";
import { offeredLooks } from "../core/looks";
import {
  GESTURE_GAP_MS, MAIN, PAGES_MAX, PLUS_LEFT, SEC_NAME_MAX, LIST_NAME_MAX, addGroupFor, allPages, cleanNames, cleanPages,
  cleanSwipeDir, fingerDx, swiped, isPlus, listMoveTarget, moveSec, movePage, newPageId, pageDx, pageGesture, pageOfTask, pageOffset, pageOrder,
  pagerIds, placeAt, removePage, renamePage, secsByPage, shownName, springDone, springStart, springStep, stepIndex, tidyName,
  type GestureOver, type GestureOwner, type ListNames, type ListPage, type SwipeDir,
} from "../core/lists";
import { REDUCED_OUT_MS, nearIndex, pageAt, reducedFade, releasePlan } from "../core/pageswipe";
import { useBgVideos as usePsBgVideos, useOverlayShown } from "../ps";
import { sfx } from "../ui/sfx";
import { bgPatch } from "./BgFit";
import { openAddTask, pushUndoAction, taskMapActions } from "./TaskMap";
import { layerArrive, layerBegin, layerDim, layerEnd, layerPaint, pagesClear, pagesPaint, type Layer } from "./pagelayer";
import "./listpager.css";

const GOS = import.meta.env.MODE === "gos";
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const save = (patch: Partial<Settings>) => void taskMapActions.looks(patch);
const emit = (name: string, detail: object) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* no window */ } };

// ---------- what the list shows right now (the Overlay sets it on every draw) ----------
type Ctx = { lists: TabLists; full: string[]; pages: ListPage[]; order: string[]; names: ListNames; groups: TaskGroup[]; dir: SwipeDir; todos: Doc<Todo>[]; st: Settings };
let ctx: Ctx = { lists: { p1: [], prio: [], ranked: [], daily: [], groups: new Map() }, full: [], pages: [], order: [MAIN], names: {}, groups: [], dir: "push", todos: [], st: {} as Settings };
export function setListCtx(c: Ctx) { ctx = c; }
/** What the list shows right now (Dimension X's Lists view and AI Inbox read it while they draw). */
export const listCtx = (): Readonly<Ctx> => ctx;
/** The saved lists, their order, names and swipe direction, checked. */
export function pagePrefs(st: Settings) {
  const pages = cleanPages(st.tmPages);
  return { pages, order: pageOrder(st.tmPageOrder, pages), names: cleanNames(st.tmNames), dir: cleanSwipeDir(st.tmSwipeDir) };
}
const keyName = (k: string) => {
  const g = groupOf(k);
  if (g) return ctx.groups.find((x) => x.id === g)?.name || "Group";
  if (k === "daily") return shownName(ctx.names, "daily", ctx.lists.daily.every((d) => isEveryDay(d.data)));   // as its header says
  return k === "p1" || k === "prio" ? shownName(ctx.names, k) : "List";
};
const pageName = (id: string) => allPages(ctx.pages, ctx.names, ctx.order).find((p) => p.id === id)?.name ?? "";
const ctxIds = () => pagerIds(ctx.order, ctx.pages);

// ---------- which page is showing (this device only, not synced) ----------
let activeId = MAIN;
const activeSubs = new Set<() => void>();
let lastHow: "swipe" | "key" | "dot" | "made" = "swipe";
function setActive(id: string) {
  if (id === activeId) return;
  const from = activeId;
  activeId = id;
  activeSubs.forEach((f) => f());
  if (lastHow !== "made") emit("ps-page-swiped", { from, to: id, how: lastHow });   // for the first use tips
}
export const activePageId = () => activeId;
const useActiveId = () => useSyncExternalStore((l) => { activeSubs.add(l); return () => { activeSubs.delete(l); }; }, () => activeId);
export function useActivePage(ids: string[]): { index: number; id: string } {
  const id = useActiveId();
  const i = ids.indexOf(id);
  if (i >= 0) return { index: i, id };
  const home = ids.indexOf(MAIN);
  return { index: Math.max(0, home), id: MAIN };
}
/** The look the page showing asks for (App.tsx puts it on the whole page): null for the main list's own. */
export function usePageLook(st: Pick<Settings, "tmPages">): string | null {
  const id = useActiveId();
  if (id === MAIN || isPlus(id)) return null;
  return cleanPages(st.tmPages).find((p) => p.id === id)?.look ?? null;
}
/** The background the page showing asks for (the Overlay draws it): null for the usual one. */
export function pageBg(pages: ListPage[], id: string): string | null {
  if (id === MAIN || isPlus(id)) return null;
  const b = pages.find((p) => p.id === id)?.bg;
  return b && bgDesign(b) === b ? b : null;
}
/** A list just made: the pager lands on it when it arrives (PS saves through its main window). */
let goWhenReady: { id: string; until: number; open?: boolean } | null = null;
/** A name that should open ready to type: "list:<id>" or "sec:<key>". */
let renameAsk: string | null = null;
const askSubs = new Set<() => void>();
function askRename(k: string | null) { renameAsk = k; askSubs.forEach((f) => f()); }
/** V1.58: while a swipe moves, the page whose name shows under the headline (it changes at half way, as the name has
 *  faded out); null at rest (the page showing). */
let stripNear: string | null = null;
const stripSubs = new Set<() => void>();
function setStripNear(id: string | null) { if (stripNear !== id) { stripNear = id; stripSubs.forEach((f) => f()); } }
const useStripNear = () => useSyncExternalStore((l) => { stripSubs.add(l); return () => { stripSubs.delete(l); }; }, () => stripNear);
type VtDoc = Document & { startViewTransition?: (f: () => void) => { finished: Promise<void> } };
const useRenameAsk = () => useSyncExternalStore((l) => { askSubs.add(l); return () => { askSubs.delete(l); }; }, () => renameAsk);

// ---------- the changes (each one write) ----------
/** A new list. withKey: a section moved onto it (named after it), else it starts with a "To do" group. at: its place
 *  in the order (default: just right of the page showing). */
export function newList(opts: { withKey?: string; name?: string; at?: number; open?: boolean } = {}) {
  const c = ctx;
  if (c.pages.length >= PAGES_MAX) return null;
  const id = newPageId();
  const here = c.order.indexOf(activeId);
  const at = opts.at ?? (here >= 0 ? here + 1 : c.order.length);
  const tmPageOrder = placeAt(c.order, id, at);
  if (opts.withKey) {
    save({ tmPages: [...c.pages.map((p) => ({ ...p, secs: p.secs.filter((k) => k !== opts.withKey) })), { id, name: opts.name || keyName(opts.withKey), secs: [opts.withKey] }], tmPageOrder });
  } else {
    if (c.groups.length >= 30) return null;
    const gid = newGroupId();
    save({
      tmGroups: cleanGroups([...c.groups, { id: gid, name: "To do" }]), tmSecOrder: [...c.full, groupKey(gid)],
      tmPages: [...c.pages, { id, name: tidyName(opts.name, LIST_NAME_MAX) || `List ${c.pages.length + 2}`, secs: [groupKey(gid)] }], tmPageOrder,
    });
  }
  sfx.click();
  goWhenReady = { id, until: Date.now() + 8000, open: opts.open };
  return id;
}
/** V1.55, the Edit mode overview (views/EditMode.tsx): a page for panels, made with a + card there. at: its place in
 *  the order. It starts empty; the overview opens Add panel for it. */
export function newPanelsPage(at: number): string | null {
  const c = ctx;
  if (c.pages.length >= PAGES_MAX) return null;
  const id = newPageId();
  const n = c.pages.filter((p) => p.kind === "panels").length + 2;
  save({ tmPages: [...c.pages, { id, name: `Page ${n}`, secs: [], kind: "panels" }], tmPageOrder: placeAt(c.order, id, at) });
  goWhenReady = { id, until: Date.now() + 8000 };
  return id;
}
/** The overview: the pages in a new order (one write). */
export function setPageOrder(ids: string[]) { save({ tmPageOrder: ids }); }
/** The overview: show this page (the pager slides to it). */
export function goToPage(id: string) { lastHow = "dot"; goTo(id); }
/** Show a page at once, with no slide inside the list (the Edit overview glides its own cards, views/EditMode.tsx). */
export function jumpToPage(id: string) { lastHow = "dot"; setActive(id); }
/** The Edit overview is open: its own panning owns the wheel, the arrows and the pointer (views/EditMode.tsx). */
const overviewOn = () => typeof document !== "undefined" && document.documentElement.classList.contains("ov-on");
export function moveSecTo(key: string, page: string) {
  sfx.drop();
  save({ tmPages: moveSec(ctx.pages, key, page) });
}
/** A list taken away. withTasks false: its sections go back to the main list. true: its tasks are deleted too (one
 *  Undo, bottom right, brings back the list and every task). */
export function deleteList(id: string, withTasks: boolean) {
  if (id === MAIN) return;
  const c = ctx;
  sfx.drop();
  // The page showing goes: its neighbour shows at once (no slide: the pages are about to change under it).
  if (activeId === id) { const i = c.order.indexOf(id); lastHow = "dot"; setActive(c.order[i + 1] ?? c.order[i - 1] ?? MAIN); }
  const tmPages = removePage(c.pages, id), tmPageOrder = c.order.filter((x) => x !== id);
  if (!withTasks) { save({ tmPages, tmPageOrder }); return; }
  const known = new Set(c.groups.map((g) => g.id));
  const page = c.pages.find((p) => p.id === id);
  const gone = c.todos.filter((d) => pageOfTask(d.data, known, c.pages) === id);
  const drop = new Set((page?.secs ?? []).filter((k) => groupOf(k)));
  const before: Partial<Settings> = { tmPages: c.pages, tmPageOrder: c.order, tmGroups: c.groups, tmSecOrder: c.full };
  for (const d of gone) void taskMapActions.remove(d.id);
  save({ tmPages, tmPageOrder, tmGroups: c.groups.filter((g) => !drop.has(groupKey(g.id))), tmSecOrder: c.full.filter((k) => !drop.has(k)) });
  pushUndoAction(`list:${id}`, `List ${page?.name ?? ""}`, () => {
    save(before);
    for (const d of gone) void taskMapActions.restore(d.id, d.data);
  });
}
export function renameList(id: string, name: string) {
  const n = tidyName(name, LIST_NAME_MAX);
  if (id === MAIN) {
    const names = { ...ctx.names };
    if (n && n !== shownName({}, "main")) names.main = n; else delete names.main;
    save({ tmNames: names });
  } else if (n) save({ tmPages: renamePage(ctx.pages, id, n) });
}
export function renameSec(k: "p1" | "prio" | "daily" | "done", name: string) {
  const n = tidyName(name, SEC_NAME_MAX), names = { ...ctx.names };
  if (n && n !== shownName({}, k)) names[k] = n; else delete names[k];   // blank: back to the usual name
  save({ tmNames: names });
}
function setPageLook(id: string, look: string | null) {
  sfx.click();
  if (id === MAIN) { if (look) save({ look }); return; }
  save({ tmPages: ctx.pages.map((p) => { if (p.id !== id) return p; const n = { ...p }; if (look) n.look = look; else delete n.look; return n; }) });
}
function setPageBg(id: string, bg: string | null) {
  sfx.click();
  if (id === MAIN) { if (bg) save(bgPatch(ctx.st, bg)); return; }
  save({ tmPages: ctx.pages.map((p) => { if (p.id !== id) return p; const n = { ...p }; if (bg) n.bg = bg; else delete n.bg; return n; }) });
}
/** Tasks moved to another list: into its first section that takes them, else a new "To do" group there. */
export function moveToList(ids: string[], page: string) {
  const c = ctx;
  const all = [c.lists.ranked, c.lists.daily, ...c.lists.groups.values()].flat();
  const types = ids.map((id) => all.find((d) => d.id === id)?.data.type).filter((t): t is Todo["type"] => !!t);
  if (!types.length) return;
  const secs = secsByPage(c.full, c.pages).get(page) ?? [];
  const t = listMoveTarget(c.lists, secs, types);
  sfx.drop();
  window.setTimeout(() => sfx.plop(), 120);
  flashDot(page);
  if (t) { void taskMapActions.moveTasks({ ids, to: t.to, index: t.index }); return; }
  if (c.groups.length >= 30) return;
  const gid = newGroupId();
  void taskMapActions.moveTasks({ ids, to: "new", index: 0 }, { group: { id: gid, name: "To do" }, order: [...c.full, groupKey(gid)], page: page === MAIN ? undefined : page });
}
/** A new task typed while a list shows: the group it joins so it shows on that list (null: none needed). */
export function addGroupHere(type: Todo["type"]): string | null {
  if (activeId === MAIN || isPlus(activeId)) return null;
  const secs = secsByPage(ctx.full, ctx.pages).get(activeId) ?? [];
  return addGroupFor(secs, type, new Set(ctx.groups.map((g) => g.id)));
}
/** A new group made by dragging tasks beside the list: it belongs to the list showing. */
export const pageForNewGroup = () => (activeId === MAIN || isPlus(activeId) ? undefined : activeId);

// ---------- the pagers (the floating Tab list and the website's To-do page each have one) ----------
type Pager = { root: HTMLElement; count: () => number; begin: () => boolean; move: (dx: number) => void; release: (v: number) => void; go: (i: number) => void; index: () => number };
const pagers = new Set<Pager>();
function pagerFor(t: EventTarget | null): Pager | null {
  const ov = t instanceof Element ? t.closest(".tm-overlay") : null;
  for (const p of pagers) if (ov && ov.contains(p.root)) return p;
  return null;
}
/** The one the keys move: the floating list when it is open, else the page's own. */
function keyPager(): Pager | null {
  let docked: Pager | null = null;
  for (const p of pagers) { if (!p.root.closest(".tm-docked")) return p; docked = p; }
  return docked;
}
/** Slide to a page (the pager lands on it and says so); with no pager here, just show it. */
function goTo(id: string) {
  const i = ctxIds().indexOf(id);
  if (i >= 0 && pagers.size) for (const p of pagers) p.go(i);
  else setActive(id);
}

// ---------- gestures: one owner per gesture (core/lists.ts pageGesture) ----------
function overOf(t: EventTarget | null): GestureOver {
  const el = t instanceof Element ? t : null;
  if (!el) return "other";
  if (el.closest(".tl-dots")) return "list";
  if (el.closest(".tm-editor, .tm-ctx, .tl-menu, .lp-make, .trm-pop, input, textarea, select, [contenteditable='true']")) return "other";
  const scroller = el.closest(".tm-scroll");
  if (!scroller || !el.closest(".tm-overlay")) return "other";
  // Something inside the list that scrolls sideways itself keeps its own wheel.
  for (let n: Element | null = el; n && n !== scroller; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) { const o = getComputedStyle(n).overflowX; if (o === "auto" || o === "scroll") return "other"; }
  }
  return "list";
}
type Wheel = { over: GestureOver; owner: GestureOwner | null; fx: number; dy: number; last: number; pager: Pager | null;
  samples: { t: number; x: number }[]; peak: number; recent: number[]; ended: boolean; timer: number };
let wg: Wheel | null = null;
let lastScroll = -Infinity;
let nativeSeen = false;   // PS says when the fingers touch and lift (ps-mac PageSwipe.swift)
const speed = (s: { t: number; x: number }[]) => {
  const a = s[0], b = s[s.length - 1];
  return a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
};
function endWheel() {
  const g = wg;
  if (!g || g.ended) return;
  g.ended = true;
  window.clearTimeout(g.timer);
  if (g.owner === "page" && g.pager) { lastHow = "swipe"; g.pager.release(swiped(pageDx(speed(g.samples), ctx.dir), ctx.st.swipeInvert)); }
  if (g.owner === "scroll") lastScroll = performance.now();
}
function onWheel(e: WheelEvent) {
  if (e.ctrlKey || overviewOn()) return;   // a pinch; the Edit overview pans instead
  const now = performance.now();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  // A new gesture after a quiet moment (or when PS said the fingers touched down).
  if (wg && now - wg.last > GESTURE_GAP_MS) { endWheel(); wg = null; }
  if (!wg) {
    const over = overOf(e.target);
    wg = { over, owner: null, fx: 0, dy: 0, last: now, pager: over === "list" ? pagerFor(e.target) : null, samples: [], peak: 0, recent: [], ended: false, timer: 0 };
    if (over === "list" && (!wg.pager || wg.pager.count() < 2)) wg.owner = "none";
  }
  const g = wg;
  g.last = now;
  const fx = fingerDx(e.deltaX * k, (e as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean }).webkitDirectionInvertedFromDevice);
  if (g.ended) {
    // The glide after the fingers lifted belongs to the swipe that just ended, never to a new one.
    if (g.owner === "page") e.preventDefault();
    return;
  }
  if (!g.owner) {
    g.fx += fx; g.dy += e.deltaY * k;
    g.owner = pageGesture(g.over, g.fx, g.dy, now - lastScroll);
    if (g.owner === "page" && !g.pager?.begin()) g.owner = "none";
    if (g.owner === "page") { g.pager!.move(swiped(pageDx(g.fx, ctx.dir), ctx.st.swipeInvert)); g.samples.push({ t: now, x: g.fx }); }
  } else if (g.owner === "page") {
    g.fx += fx;
    g.samples.push({ t: now, x: g.fx });
    while (g.samples.length > 2 && now - g.samples[0].t > 90) g.samples.shift();
    g.pager!.move(swiped(pageDx(g.fx, ctx.dir), ctx.st.swipeInvert));   // Settings, Controls, Invert swipe (V1.57)
    // Without PS's word (the website): the fingers have lifted once the moves only shrink (the Mac's glide).
    if (!nativeSeen) {
      const a = Math.abs(fx);
      g.peak = Math.max(g.peak, a);
      g.recent.push(a); if (g.recent.length > 4) g.recent.shift();
      const r = g.recent;
      if (r.length === 4 && r.every((x, i) => i === 0 || x <= r[i - 1] * 0.94) && r[3] < g.peak * 0.55 && g.peak > 6) endWheel();
    }
  }
  if (g.owner === "page") e.preventDefault();
  if (g.owner === "scroll") lastScroll = now;
  window.clearTimeout(g.timer);
  g.timer = window.setTimeout(endWheel, GESTURE_GAP_MS);
}
/** PS (ps-mac PageSwipe.swift): "b" the fingers touched the trackpad, "e" they lifted, "m" the glide began. */
function nativePhase(p: string) {
  nativeSeen = true;
  // Touched down: a new gesture (unless its first move is already here: the two can arrive either way round).
  if (p === "b") { if (wg && (wg.ended || performance.now() - wg.last > 40)) { endWheel(); wg = null; } }
  else if (p === "e" || p === "m") endWheel();
}

// A finger (the phone, a touch screen): anywhere on the list, rows included (the V1.34 row swipe is gone). A hold still
// lifts a row to drag it (gos/touch.ts): a sideways move first cancels the hold, a hold first means no page swipe. A
// mouse never drags pages: a click on the empty space closes the floating list, as it always did.
type Touch = { pid: number; x0: number; y0: number; owner: GestureOwner | null; pager: Pager; samples: { t: number; x: number }[] };
let tg: Touch | null = null;
function onDown(e: PointerEvent) {
  if (e.pointerType === "mouse" || !e.isPrimary || tg || overviewOn()) return;
  if (overOf(e.target) !== "list") return;
  if (panelOpen()) return;   // PS 1.66: a full screen panel is open over the list: its pages stay put (core/phonepanels.ts)
  const p = pagerFor(e.target);
  if (!p || p.count() < 2) return;
  tg = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, owner: null, pager: p, samples: [] };
}
function onMove(e: PointerEvent) {
  const g = tg;
  if (!g || e.pointerId !== g.pid) return;
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (!g.owner) {
    g.owner = pageGesture("list", dx, dy);
    if (!g.owner) return;
    if (g.owner !== "page" || document.querySelector(".gos-lifted, [data-dragging], .tm-ghost") || !g.pager.begin()) { tg = null; return; }
  }
  e.preventDefault();
  const t = performance.now();
  g.samples.push({ t, x: dx });
  while (g.samples.length > 2 && t - g.samples[0].t > 90) g.samples.shift();
  g.pager.move(swiped(dx, ctx.st.swipeInvert));   // a finger drags the page with it (the other way with Invert swipe, V1.57)
}
function onUp(e: PointerEvent) {
  const g = tg;
  if (!g || e.pointerId !== g.pid) return;
  tg = null;
  if (g.owner !== "page") return;
  const stop = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 300);
  lastHow = "swipe";
  g.pager.release(e.type === "pointercancel" ? 0 : swiped(speed(g.samples), ctx.st.swipeInvert));
}
// Keys: Left and Right arrows go to the page on that side (also while Tab is held), when nothing else wants them.
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || overviewOn()) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const a = document.activeElement as HTMLElement | null;
  if (a?.closest?.("input, textarea, select, [contenteditable='true'], [role='slider'], [role='menu'], .tm-ctx, .tl-menu")) return;
  if (document.querySelector(".tm-ctx, .tl-menu, .tm-ghost, .lp-make, .trm-pop")) return;   // a menu, a drag, Create, a reminder pop-up
  const p = keyPager();
  if (!p || p.count() < 2) return;
  const to = stepIndex(p.index(), p.count(), e.key === "ArrowRight" ? 1 : -1);
  e.preventDefault();
  lastHow = "key";
  if (to !== p.index()) p.go(to); else bump(p);
}
function bump(p: Pager) {
  if (reduced()) return;
  p.root.querySelector(".tl-track")?.animate([{ transform: "translate3d(0,0,0)" }, { transform: `translate3d(${p.index() === 0 ? 14 : -14}px,0,0)` }, { transform: "translate3d(0,0,0)" }],
    { duration: 260, easing: "cubic-bezier(.3, 1.4, .5, 1)" });
}

let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("pointermove", onMove, { capture: true, passive: false });
  window.addEventListener("pointerup", onUp, { capture: true });
  window.addEventListener("pointercancel", onUp, { capture: true });
  window.addEventListener("keydown", onKey);
  (window as unknown as { __psPageSwipe?: (p: string) => void }).__psPageSwipe = nativePhase;
}

// ---------- the pager itself ----------
export function ListPager({ ids, index, docked, render }: { ids: string[]; index: number; docked?: boolean; render: (id: string, here: boolean) => ReactNode }) {
  const box = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState<number[]>([]);
  const st = useRef({ from: index, x: 0, x0: 0, v: 0, to: 0, raf: 0, span: 0, moving: false, lastT: 0,
    layer: null as Layer | null, gen: 0, dim: 1, landed: 0, fade: false });
  const live = useRef({ ids, index });
  live.current = { ids, index };
  useEffect(() => { install(); }, []);

  // V1.58 (core/pageswipe.ts, views/pagelayer.ts): one frame of the move. The list pages, the panels and buttons of
  // their pages and the list's name all follow the fingers as one layer; things on every page stand still.
  // Reduce Motion: nothing slides, the page only dims a little, then a quick cross fade (fadeTo).
  const paint = (x: number) => {
    const s = st.current;
    const rm = reduced();
    const ids = live.current.ids;
    const at = pageAt(s.from, rm ? 0 : x, s.span);
    const atFingers = pageAt(s.from, x, s.span);
    if (rm) s.dim = reducedFade(atFingers, s.from);
    if (track.current) track.current.style.transform = rm ? "" : `translate3d(${x.toFixed(2)}px,0,0)`;
    pagesPaint(track.current, ids, rm ? atFingers : at, s.from, rm);
    layerPaint(s.layer, rm ? atFingers : at, s.from, s.span, rm);
    if (!rm) setStripNear(ids[nearIndex(at, ids.length)] ?? null);
    moveDots(box.current, atFingers);   // the bright dot follows the fingers
  };
  const finish = (to: number) => {
    const s = st.current;
    cancelAnimationFrame(s.raf); s.raf = 0;
    s.gen++;
    s.moving = false;
    const ids = live.current.ids;
    const id = ids[to] ?? MAIN;
    if (id === activeId) { settle(); return; }
    s.landed = to > s.from ? 1 : -1;
    const fromId = activeId;
    sfx.hover();
    // A page with its own background: the two backgrounds cross fade as it lands (a view transition where the web view
    // has one; its look, if it has its own, fades with it, looks/engine.ts), instead of changing in one frame.
    const doc = document as VtDoc, html = document.documentElement;
    if (doc.startViewTransition && pageBg(ctx.pages, fromId) !== pageBg(ctx.pages, id) && !html.classList.contains("lk-turning") && !html.classList.contains("nb-turning")) {
      html.classList.add("pg-turning");
      try { doc.startViewTransition(() => { flushSync(() => setActive(id)); }).finished.finally(() => html.classList.remove("pg-turning")); return; }
      catch { html.classList.remove("pg-turning"); }
    }
    setActive(id);
  };
  /** The pages back in their places: the current one in the page, no transform, no neighbours. */
  const settle = () => {
    const s = st.current;
    if (s.moving) return;
    s.x = 0; s.from = live.current.index;
    if (track.current) track.current.style.transform = "";
    pagesClear(track.current);
    const rode = layerEnd(s.layer);
    const overlay = s.layer?.overlay ?? box.current?.closest<HTMLElement>(".tm-overlay") ?? null;
    s.layer = null;
    setStripNear(null);
    box.current?.classList.remove("moving");
    moveDots(box.current, live.current.index);
    setNear([]);
    // A new page landed: whatever of it did not ride in with the swipe fades in (Reduce Motion: all of it, the second
    // half of the cross fade).
    if (s.landed) {
      const rm = s.fade || reduced();
      const cur = track.current?.querySelector<HTMLElement>(":scope > .tl-page:not(.tl-near)") ?? null;
      layerArrive(overlay, live.current.ids[live.current.index] ?? MAIN, rode, rm, s.landed, [cur, overlay?.querySelector<HTMLElement>(".tl-strip") ?? null]);
    }
    s.landed = 0; s.fade = false; s.dim = 1;
  };
  // A new current page (the spring landed, a dot, a new list): back to rest in the same frame, no flicker.
  useLayoutEffect(() => { settle(); }, [index]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Reduce Motion: a quick fade out of the page (and its panels and name), then the new one fades in as it lands
   *  (settle). Staying on the same page: it fades back up. */
  const fadeTo = (to: number) => {
    const s = st.current;
    s.to = to;
    const leaving = to !== s.from;
    const o0 = s.dim, o1 = leaving ? 0 : 1;
    const gen = ++s.gen;
    let k = 0, last = -1;
    s.fade = true;
    let over = false;
    const end = () => {
      if (over || s.gen !== gen) return;
      over = true;
      s.x = leaving ? -(to - s.from) * s.span : 0;
      finish(to);
    };
    const frame = (k: number) => {
      const o = o0 + (o1 - o0) * k;
      s.dim = o;
      pagesPaint(track.current, live.current.ids, s.from, s.from, true, o);
      layerDim(s.layer, s.from, o);
    };
    const step = () => {
      if (over || s.gen !== gen) return;
      // Frame by frame, each step at most 25 ms worth: a long frame (the next page drawing) slows the fade a little
      // instead of making it jump.
      const now = performance.now();
      if (last >= 0) k = Math.min(1, k + Math.min(25, now - last) / REDUCED_OUT_MS);
      last = now;
      frame(k);
      if (k >= 1) end(); else s.raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(s.raf);
    s.raf = requestAnimationFrame(step);
    window.setTimeout(() => { if (!over && s.gen === gen) { frame(1); end(); } }, REDUCED_OUT_MS + 800);   // a hidden list never runs frames
  };
  const spring = (to: number, v0: number) => {
    const s = st.current;
    s.to = to;
    const target = -(to - s.from) * s.span;
    // The empty + page shows its + in the middle of the screen: the list scrolls to the top on the way there.
    if (isPlus(live.current.ids[to] ?? "")) { const sc = box.current?.closest(".tm-scroll"); if (sc && sc.scrollTop > 0) sc.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" }); }
    if (reduced()) { fadeTo(to); return; }
    s.fade = false;
    s.v = springStart(v0, target - s.x);
    s.lastT = performance.now();
    const gen = ++s.gen;
    const step = (t: number) => {
      if (s.gen !== gen) return;
      // At most two frames' worth per frame: after a long frame (the next page drawing) the glide carries on from where
      // it was instead of jumping ahead.
      const dt = Math.min(0.034, Math.max(0, (t - s.lastT) / 1000)); s.lastT = t;
      const r = springStep(s.x, s.v, target, dt);
      s.x = r.x; s.v = r.v;
      if (springDone(s.x, s.v, target)) { s.x = target; paint(target); finish(to); return; }
      paint(s.x);
      s.raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(s.raf);
    s.raf = requestAnimationFrame(step);
    // A hidden list never runs frames: land anyway.
    window.setTimeout(() => { if (s.gen === gen && s.moving) { cancelAnimationFrame(s.raf); s.x = target; paint(target); finish(to); } }, 1200);
  };
  const measure = () => { const s = st.current; s.span = box.current?.clientWidth || 0; return s.span > 0; };
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    const s = st.current;
    /** The page layer (views/pagelayer.ts) for the pages taking part, started afresh (a caught glide keeps its place:
     *  the caller paints it again in the same event, before the next frame). */
    const startLayer = (pick: (i: number) => boolean) => {
      layerEnd(s.layer);
      s.layer = layerBegin(root.closest<HTMLElement>(".tm-overlay"), live.current.ids, pick);
    };
    const p: Pager = {
      root,
      count: () => live.current.ids.length,
      index: () => live.current.index,
      begin: () => {
        if (live.current.ids.length < 2 || !measure()) return false;
        // Caught while it glides: the swipe carries on from where the pages are.
        if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; } else { s.from = live.current.index; s.x = 0; s.dim = 1; }
        s.gen++;   // a glide or a fade caught by the fingers stops where it is
        s.x0 = s.x;
        s.moving = true;
        root.classList.add("moving");
        const n = [s.from - 1, s.from + 1].filter((i) => i >= 0 && i < live.current.ids.length);
        setNear((old) => (old.length === n.length && old.every((x, i) => x === n[i]) ? old : n));
        startLayer((i) => Math.abs(i - s.from) <= 1);
        paint(s.x);   // at once, so the next page's panels never show for a frame before they are faded
        return true;
      },
      move: (dx) => {
        if (!s.moving) return;
        s.x = pageOffset(s.x0 + dx, s.span, s.from, live.current.ids.length);   // one page at most, rubber at the ends
        paint(s.x);
      },
      release: (v) => {
        if (!s.moving) return;
        const plan = releasePlan(s.from, live.current.ids.length, s.x, v, s.span, reduced());   // core/pageswipe.ts
        spring(plan.to, v);
      },
      go: (i) => {
        const n = live.current.ids.length;
        if (i < 0 || i >= n) return;
        if (i === live.current.index && !s.moving) return;
        if (!measure()) { setActive(live.current.ids[i]); return; }
        const caught = s.moving;
        if (!s.moving) { s.from = live.current.index; s.x = 0; s.dim = 1; }
        if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
        s.gen++;
        s.moving = true;
        root.classList.add("moving");
        setNear([i]);
        startLayer((j) => j === s.from || j === i || (caught && Math.abs(j - s.from) <= 1));
        paint(s.x);
        spring(i, 0);
      },
    };
    pagers.add(p);
    return () => { pagers.delete(p); cancelAnimationFrame(s.raf); };
  }, []);
  // A list just made: once it is saved and here, it is the page showing (it sits where the + page was).
  const k = ids.join(",");
  useEffect(() => {
    const w = goWhenReady;
    if (!w) return;
    if (Date.now() > w.until) { goWhenReady = null; return; }
    if (!ids.includes(w.id)) return;
    goWhenReady = null;
    lastHow = "made";
    setActive(w.id);
    lastHow = "swipe";
    emit("ps-list-created", { id: w.id, name: pageName(w.id) });   // for the first use tips
    if (w.open) window.setTimeout(() => openAddTask(docked ? "docked" : "tab"), 120);
  }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  // The floating list opens on the main list each time (the website's page keeps its place).
  const shown = useOverlayShown();
  const was = useRef(shown);
  useEffect(() => { if (shown && !was.current && !docked) { lastHow = "made"; setActive(MAIN); lastHow = "swipe"; } was.current = shown; }, [shown, docked]);

  const from = st.current.moving ? st.current.from : index;
  // One flat list of pages, keyed by id: the page that slides in keeps its place in the DOM as it becomes the current
  // one (no remount, no flicker as it lands).
  const shownIdx = [from, ...near.filter((i) => i !== from && ids[i])].filter((i) => ids[i]).sort((a, b) => a - b);
  return (
    <div ref={box} className="tl-pager" data-pages={ids.length}>
      <div ref={track} className="tl-track">
        {shownIdx.map((i) => i === from
          ? <div key={ids[i]} className="tl-page" data-page={ids[i]}>{render(ids[i], true)}</div>
          : <div key={ids[i]} className="tl-page tl-near" data-page={ids[i]} aria-hidden="true" inert
              style={{ transform: `translate3d(calc(${i - from} * (100% + 2 * var(--tl-pad))), 0, 0)` }}>{render(ids[i], false)}</div>)}
      </div>
    </div>
  );
}

// ---------- the empty + page and "Create a to-do list" ----------
/** An empty page at either end: a big + in the middle of the screen. */
export function PlusPage({ id, here, docked }: { id: string; here: boolean; docked?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [step, setStep] = useState<"plus" | "flying" | "name" | "making">("plus");
  // Where the middle of the screen is, inside this page (measured from the pager, which never slides, at the top of
  // the list: the list scrolls to the top on the way here).
  useLayoutEffect(() => {
    const place = () => {
      const pager = ref.current?.closest<HTMLElement>(".tl-pager");
      const sc = ref.current?.closest<HTMLElement>(".tm-scroll");
      if (!pager || !sc) return;
      const r = pager.getBoundingClientRect(), pad = parseFloat(getComputedStyle(pager).paddingLeft) || 0;
      if (docked) { setAt({ x: (r.width - 2 * pad) / 2, y: 150 }); return; }
      setAt({ x: window.innerWidth / 2 - r.left - pad, y: Math.max(120, window.innerHeight / 2 - (r.top + sc.scrollTop)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [docked, here]);   // again as it lands (it was measured while it slid in)
  useEffect(() => { if (!here && step !== "making") setStep("plus"); }, [here]); // eslint-disable-line react-hooks/exhaustive-deps
  const side = id === PLUS_LEFT ? "left" : "right";
  const start = () => {
    sfx.click();
    const from = plus.current?.getBoundingClientRect();
    const to = ref.current?.closest(".tm-overlay")?.querySelector<HTMLElement>(".tm-head .tm-add button")?.getBoundingClientRect();
    if (!from || !to || reduced()) { setStep("name"); return; }
    setStep("flying");
    flyPlus(from, to, () => setStep("name"));
  };
  const make = (name: string) => {
    setStep("making");
    if (!newList({ name, at: side === "left" ? 0 : ctx.order.length, open: true })) setStep("plus");
  };
  return (
    <div ref={ref} className="tl-plus-page" style={{ minHeight: at ? at.y + 160 : 420 }}>
      {at && (step === "plus" || step === "flying") && (
        <button ref={plus} type="button" className={`tl-plus-big no-drag${step === "flying" ? " gone" : ""}`} style={{ left: at.x, top: at.y }}
          aria-label={`New list on the ${side}`} title="New list" onMouseDown={(e) => e.stopPropagation()} onClick={start}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      )}
      {at && (step === "name" || step === "making") && (
        <CreateCard at={at} busy={step === "making"} onDone={(name) => { if (name === null) setStep("plus"); else make(name); }} />
      )}
    </div>
  );
}
/** The big + flies in an arc to the green Add task button, shrinking and turning, and becomes it. */
function flyPlus(from: DOMRect, to: DOMRect, done: () => void) {
  const el = document.createElement("div");
  el.className = "tl-plus-fly";
  el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  el.style.left = `${from.left}px`; el.style.top = `${from.top}px`; el.style.width = `${from.width}px`; el.style.height = `${from.height}px`;
  const btn = document.querySelector<HTMLElement>(".tm-overlay .tm-head .tm-add");
  el.style.setProperty("--to", (btn && getComputedStyle(btn).getPropertyValue("--tm-addc").trim()) || "#3DDC84");
  document.body.appendChild(el);
  const sx = from.left + from.width / 2, sy = from.top + from.height / 2, ex = to.left + to.width / 2, ey = to.top + to.height / 2;
  const cx = (sx + ex) / 2 + (ex - sx) * 0.15, cy = Math.min(sy, ey) - Math.max(80, Math.abs(sx - ex) * 0.35);   // the arc's pull
  const sc = to.width / from.width;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, u = 1 - t;
    const x = u * u * sx + 2 * u * t * cx + t * t * ex, y = u * u * sy + 2 * u * t * cy + t * t * ey;
    const s = 1 + (sc - 1) * t * t + Math.sin(t * Math.PI) * 0.12;
    frames.push({ transform: `translate3d(${(x - sx).toFixed(1)}px, ${(y - sy).toFixed(1)}px, 0) scale(${s.toFixed(3)}) rotate(${Math.round(t * 180)}deg)`, offset: t });
  }
  const a = el.animate(frames, { duration: 680, easing: "cubic-bezier(.45, 0, .2, 1)", fill: "forwards" });
  el.classList.add("go");   // its colour turns into the button's (listpager.css)
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    // It lands on the button: the button pops, the flyer fades into it.
    btn?.animate([{ transform: "scale(1)" }, { transform: "scale(1.28)" }, { transform: "scale(1)" }], { duration: 320, easing: "cubic-bezier(.3, 1.6, .5, 1)" });
    sfx.plop();
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" });
    window.setTimeout(() => el.remove(), 180);
    done();
  };
  a.finished.then(end, end);
  window.setTimeout(end, 900);   // a hidden list never runs frames
}
/** "Create a to-do list": a name, Enter makes it, Esc goes back to the +. */
function CreateCard({ at, busy, onDone }: { at: { x: number; y: number }; busy: boolean; onDone: (name: string | null) => void }) {
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { inp.current?.focus({ preventScroll: true }); taskMapActions.editing(true); return () => taskMapActions.editing(false); }, []);
  const go = () => { const v = tidyName(inp.current?.value, LIST_NAME_MAX); if (v) onDone(v); else inp.current?.focus(); };
  return (
    <div className="lp-make no-drag" style={{ left: at.x, top: at.y }} role="dialog" aria-label="Create a to-do list"
      onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <b>Create a to-do list</b>
      <input ref={inp} className="lp-make-in" placeholder="Its name, for example Streaks" maxLength={LIST_NAME_MAX} spellCheck={false} disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); go(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onDone(null); }
        }} />
      <span className="lp-make-row">
        <button type="button" className="lp-make-no" onClick={() => onDone(null)} disabled={busy}>Cancel</button>
        <button type="button" className="lp-make-go" onClick={go} disabled={busy}>{busy ? "Making it" : "Create"}</button>
      </span>
    </div>
  );
}

// ---------- the dots at the bottom ----------
/** The bright dot sits at page `at` (a fraction while a swipe moves). */
function moveDots(pager: HTMLElement | null, at: number) {
  const root = pager?.closest(".tm-overlay");
  const dots = root?.querySelector<HTMLElement>(".tl-dots");
  const pill = dots?.querySelector<HTMLElement>(".tl-pill");
  const all = dots ? [...dots.querySelectorAll<HTMLElement>(".tl-dot")] : [];
  if (!pill || all.length < 1) return;
  const i = Math.max(0, Math.min(all.length - 1, at));
  const a = all[Math.floor(i)], b = all[Math.min(all.length - 1, Math.ceil(i))], f = i - Math.floor(i);
  // PS 1.60: on the phone the dots sit in their own pill (.tl-bed) with the + buttons outside it, so the spot is measured
  // from the pill's own left edge, and the bright dot never slides out over a + button.
  const bed = pill.parentElement && pill.parentElement.classList.contains("tl-bed") ? pill.parentElement : null;
  let x: number;
  if (bed) {
    const br = bed.getBoundingClientRect(), ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const ca = ra.left + ra.width / 2 - br.left, cb = rb.left + rb.width / 2 - br.left;
    x = Math.max(0, Math.min(br.width, ca + (cb - ca) * f));
  } else {
    x = a.offsetLeft + a.offsetWidth / 2 + ((b.offsetLeft + b.offsetWidth / 2) - (a.offsetLeft + a.offsetWidth / 2)) * f;
  }
  pill.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0)`;
  const near = Math.round(i);
  all.forEach((d, n) => d.classList.toggle("on", n === near));
}
export function ListDots({ ids, index, names }: { ids: string[]; index: number; names: ListNames }) {
  const ref = useRef<HTMLDivElement>(null);
  const all = allPages(ctx.pages, names, ctx.order);
  const name = (id: string) => (id === PLUS_LEFT ? "New list on the left" : isPlus(id) ? "New list on the right" : all.find((p) => p.id === id)?.name ?? "");
  useLayoutEffect(() => { moveDots(ref.current?.closest(".tm-overlay")?.querySelector(".tl-pager") ?? null, index); }, [index, ids.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const hold = useRef(0);
  const go = (i: number) => { const p = keyPagerIn(ref.current); lastHow = "dot"; if (p) p.go(i); else setActive(ids[i]); };
  // PS 1.60 (phone): the iPhone's page dots. Tap the left or right half to go back or forward, press and slide to scrub
  // (one haptic tick a page, the pill grows while held). Rules in core/pagedots.ts. The Mac and the website keep the old dots.
  const phone = GOS || MWEB;
  const real = ids.filter((id) => !isPlus(id));
  const first = ids.findIndex((id) => !isPlus(id));
  const curReal = Math.max(0, Math.min(real.length - 1, index - first));
  const bed = useRef<HTMLDivElement>(null);
  const press = useRef<pd.Press | null>(null);
  const [held, setHeld] = useState(false);
  const geo = (): pd.Geo => { const r = bed.current?.getBoundingClientRect(); return { left: r?.left ?? 0, width: r?.width ?? 0, n: real.length }; };
  const gesture = phone ? {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || real.length < 1) return;
      press.current = pd.press(e.clientX, performance.now(), curReal);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* gone */ }
      setHeld(true);
      // The dots do not take touches themselves on the phone, so the pill starts the long press menu for the dot under the finger.
      const x = e.clientX, y = e.clientY, el = e.currentTarget;
      window.clearTimeout(hold.current);
      hold.current = window.setTimeout(() => {
        const p = press.current;
        if (!p || p.scrubbing) { hold.current = 0; return; }
        const id = real[pd.dotAt(x, geo())];
        if (id) { hold.current = -1; menuAt(x, y, id, el); } else hold.current = 0;
      }, pd.LONG_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current; if (!p) return;
      const m = pd.move(p, e.clientX, geo());
      press.current = m.p;
      if (m.started && hold.current > 0) { window.clearTimeout(hold.current); hold.current = 0; }
      if (m.to != null) { gosHaptic("tick"); go(first + m.to); }
    },
    onPointerUp: (e: React.PointerEvent) => {
      const p = press.current; press.current = null; setHeld(false);
      if (hold.current > 0) { window.clearTimeout(hold.current); hold.current = 0; }
      if (!p) return;
      if (hold.current === -1) { hold.current = 0; return; }   // the long press menu already opened
      const r = pd.release(p, e.clientX, performance.now(), geo());
      if (r.kind === "tap" && r.to !== curReal) { gosHaptic("tick"); sfx.hover(); go(first + r.to); }
    },
    onPointerCancel: () => { press.current = null; setHeld(false); if (hold.current > 0) { window.clearTimeout(hold.current); hold.current = 0; } },
  } : {};
  const dot = (id: string, i: number) => (
    <button key={id} type="button" role="tab" aria-selected={i === index} data-page={id}
      className={`tl-dot${i === index ? " on" : ""}${id === MAIN ? " home" : ""}${isPlus(id) ? " plus" : ""}`} title={name(id)} aria-label={name(id)}
      onClick={() => { if (phone && !isPlus(id)) return; if (hold.current === -1) { hold.current = 0; return; } sfx.hover(); go(i); }}
      onContextMenu={(e) => { if (!isPlus(id)) openListMenu(e, id); else e.preventDefault(); }}
      onPointerDown={(e) => {
        if (isPlus(id) || e.button !== 0) return;
        const x = e.clientX, y = e.clientY, el = e.currentTarget;
        window.clearTimeout(hold.current);
        hold.current = window.setTimeout(() => { hold.current = -1; menuAt(x, y, id, el); }, 520);   // a long press: the menu
      }}
      onPointerUp={() => { if (hold.current > 0) { window.clearTimeout(hold.current); hold.current = 0; } }}
      onPointerLeave={() => { if (hold.current > 0) { window.clearTimeout(hold.current); hold.current = 0; } }}>
      {id === MAIN ? <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5.2L5 2l3.5 3.2V8.5h-7z" /></svg> : isPlus(id) ? <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 2v6M2 5h6" /></svg> : <i />}
    </button>
  );
  if (!phone || real.length === 0) {
    return (
      <div ref={ref} className="tl-dots" role="tablist" aria-label="Your lists" onMouseDown={(e) => e.stopPropagation()}>
        <i className="tl-pill" aria-hidden="true" />
        {ids.map(dot)}
      </div>
    );
  }
  const lead = ids.slice(0, first), tail = ids.slice(first + real.length);
  return (
    <div ref={ref} className={`tl-dots tl-phone${held ? " held" : ""}`} role="tablist" aria-label="Your lists" onMouseDown={(e) => e.stopPropagation()}>
      {lead.map((id, k) => dot(id, k))}
      <div ref={bed} className="tl-bed" {...gesture}>
        <i className="tl-pill" aria-hidden="true" />
        {real.map((id, k) => dot(id, first + k))}
      </div>
      {tail.map((id, k) => dot(id, first + real.length + k))}
    </div>
  );
}

// ---------- the name under the headline ----------
export function ListStrip({ names, id: here }: { names: ListNames; id: string }) {
  const all = allPages(ctx.pages, names, ctx.order);
  // V1.58: while a swipe moves, the name fades out, changes at half way and fades in (views/pagelayer.ts).
  const id = useStripNear() ?? here;
  const cur = all.find((p) => p.id === id);
  const ask = useRenameAsk();
  const [edit, setEdit] = useState(false);
  useEffect(() => { if (cur && ask === `list:${cur.id}`) { askRename(null); setEdit(true); } }, [ask, cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const hold = useRef(0);
  if (all.length < 2) return <div className="tl-strip none" aria-hidden="true" />;
  if (!cur) return <div className="tl-strip" aria-hidden="true" />;   // a + page: the same room, so nothing moves as it lands
  return (
    <div className="tl-strip" onMouseDown={(e) => e.stopPropagation()}>
      {edit
        ? <NameInput value={cur.name} max={LIST_NAME_MAX} label="List name" onDone={(v) => { setEdit(false); if (v !== null) renameList(cur.id, v); }} />
        : <span className="lp-name" title="Double click to rename. Right click or hold for more." onDoubleClick={() => { sfx.click(); setEdit(true); }}
            onContextMenu={(e) => openListMenu(e, cur.id)}
            onPointerDown={(e) => { if (e.pointerType === "mouse") return; const x = e.clientX, y = e.clientY, el = e.currentTarget; hold.current = window.setTimeout(() => menuAt(x, y, cur.id, el), 520); }}
            onPointerUp={() => window.clearTimeout(hold.current)} onPointerLeave={() => window.clearTimeout(hold.current)}>{cur.name}</span>}
    </div>
  );
}
function keyPagerIn(el: Element | null): Pager | null {
  const ov = el?.closest(".tm-overlay");
  for (const p of pagers) if (ov?.contains(p.root)) return p;
  return null;
}

/** A name being typed: Enter saves, Esc cancels (onDone(null)), leaving the box saves. */
export function NameInput({ value, max, label, onDone }: { value: string; max: number; label: string; onDone: (v: string | null) => void }) {
  const done = useRef(false);
  const end = (v: string | null) => { if (done.current) return; done.current = true; taskMapActions.editing(false); onDone(v); };
  return (
    <input className="lp-name-in no-drag" autoFocus defaultValue={value} maxLength={max} aria-label={label} spellCheck={false}
      size={Math.max(6, Math.min(max, value.length + 2))}
      onFocus={(e) => { done.current = false; e.currentTarget.select(); taskMapActions.editing(true); }}
      onBlur={(e) => end(e.currentTarget.value)}
      onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); end(e.currentTarget.value); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); end(null); }
      }} />
  );
}

// ---------- a built-in section's name (Priority 1, Priorities, Every day, Completed) ----------
export function SecTitle({ skey, title }: { skey: "p1" | "prio" | "daily" | "done"; title: string }) {
  const ask = useRenameAsk();
  const [edit, setEdit] = useState(false);
  useEffect(() => { if (ask === `sec:${skey}`) { askRename(null); setEdit(true); } }, [ask, skey]);
  if (edit) return <NameInput value={title} max={SEC_NAME_MAX} label="Section name" onDone={(v) => { setEdit(false); if (v !== null) renameSec(skey, v); }} />;
  return <span className="tl-sec-t" title="Double click to rename" onDoubleClick={(e) => { e.stopPropagation(); sfx.click(); setEdit(true); }}>{title}</span>;
}

// ---------- the menus: a section header, a list's name or dot ----------
type MenuAt = { kind: "sec" | "list"; key: string; x: number; y: number; root: Element | null; n: number };
let menu: MenuAt | null = null;
const menuSubs = new Set<() => void>();
const setMenu = (m: MenuAt | null) => { menu = m; menuSubs.forEach((f) => f()); };
const useMenu = () => useSyncExternalStore((l) => { menuSubs.add(l); return () => { menuSubs.delete(l); }; }, () => menu);
/** A right click on a section header (Priority 1, Priorities, Every day, a group). Not on the phone (a hold lifts). */
export function openSecMenu(e: React.MouseEvent, key: string) {
  if (GOS) return;
  e.preventDefault(); e.stopPropagation();
  sfx.hover();
  setMenu({ kind: "sec", key, x: e.clientX, y: e.clientY, root: (e.currentTarget as Element).closest(".tm-overlay"), n: Date.now() });
}
function openListMenu(e: React.MouseEvent, id: string) {
  e.preventDefault(); e.stopPropagation();
  menuAt(e.clientX, e.clientY, id, e.currentTarget as Element);
}
function menuAt(x: number, y: number, id: string, el: Element) {
  sfx.hover();
  setMenu({ kind: "list", key: id, x, y, root: el.closest(".tm-overlay"), n: Date.now() });
}
type Item = { k: string; label: string; run: () => void; bad?: boolean; keep?: boolean; on?: boolean; sub?: Item[] };
export function ListMenuHost({ names, dir }: { names: ListNames; dir: SwipeDir }) {
  const probe = useRef<HTMLSpanElement>(null);
  const m = useMenu();
  const shown = useOverlayShown();
  useEffect(() => { if (!shown) setMenu(null); }, [shown]);
  const mine = !!m && !!probe.current && probe.current.closest(".tm-overlay") === m.root;
  return <><span ref={probe} hidden />{mine && m && <Menu key={m.n} at={m} names={names} dir={dir} />}</>;
}
function Menu({ at, names, dir }: { at: MenuAt; names: ListNames; dir: SwipeDir }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [open, setOpen] = useState<string | null>(at.kind === "sec" ? "m" : null);
  const videos = usePsBgVideos();
  const close = () => setMenu(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const up = at.y + h + 8 > window.innerHeight && at.y - h - 4 >= 0;
    setPos({ left: Math.max(6, Math.min(window.innerWidth - w - 6, at.x + 2)), top: up ? at.y - h - 2 : Math.max(6, Math.min(window.innerHeight - h - 6, at.y + 2)) });
  }, [at, open]);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const wheel = (e: WheelEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      const all = [...(ref.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && all.length) {
        e.preventDefault(); e.stopImmediatePropagation();
        const next = i < 0 ? (e.key === "ArrowDown" ? 0 : all.length - 1) : (i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length;
        all[next]?.focus({ preventScroll: true });
      }
      // Left and Right stay in the menu (the pages behind it never move while it is open).
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: true });
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("wheel", wheel, { capture: true });
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
    };
  }, []);
  useEffect(() => { if (pos) ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true }); }, [!!pos]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = allPages(ctx.pages, names, ctx.order);
  const toggle = (k: string) => () => { sfx.hover(); setOpen((v) => (v === k ? null : k)); };
  let title: string, items: Item[];
  if (at.kind === "sec") {
    const here = all.find((p) => (secsByPage(ctx.full, ctx.pages).get(p.id) ?? []).includes(at.key))?.id ?? MAIN;
    title = keyName(at.key);
    const builtin = at.key === "p1" || at.key === "prio" || at.key === "daily";
    items = [
      ...(builtin ? [{ k: "r", label: "Rename", run: () => askRename(`sec:${at.key}`) }] : []),
      { k: "m", label: "Move to list", keep: true, run: toggle("m"), sub: [
        ...all.filter((p) => p.id !== here).map((p) => ({ k: `to:${p.id}`, label: p.name, run: () => moveSecTo(at.key, p.id) })),
        ...(ctx.pages.length < PAGES_MAX ? [{ k: "new", label: "+ New list", run: () => { newList({ withKey: at.key }); } }] : []),
      ] },
    ];
  } else {
    const id = at.key, i = ctx.order.indexOf(id), main = id === MAIN;
    const page = ctx.pages.find((p) => p.id === id);
    title = all.find((p) => p.id === id)?.name ?? "";
    const known = new Set(ctx.groups.map((g) => g.id));
    const count = main ? 0 : ctx.todos.filter((d) => pageOfTask(d.data, known, ctx.pages) === id).length;
    const tasks = `${count} task${count === 1 ? "" : "s"}`;
    const curBg = main ? null : page?.bg ?? null, curLook = main ? ctx.st.look ?? null : page?.look ?? null;
    items = [
      { k: "r", label: "Rename", run: () => { if (id !== activeId) { lastHow = "dot"; goTo(id); } askRename(`list:${id}`); } },
      ...(i > 0 ? [{ k: "ml", label: "Move left", run: () => { sfx.click(); save({ tmPageOrder: movePage(ctx.order, id, -1) }); } }] : []),
      ...(i < ctx.order.length - 1 ? [{ k: "mr", label: "Move right", run: () => { sfx.click(); save({ tmPageOrder: movePage(ctx.order, id, 1) }); } }] : []),
      { k: "bg", label: "Page background", keep: true, run: toggle("bg"), sub: [
        ...(main ? [] : [{ k: "bg:", label: "Same as main page", on: !curBg, run: () => setPageBg(id, null) }]),
        ...BG_DESIGNS.map((d) => ({ k: `bg:${d.id}`, label: d.label, on: curBg === d.id, run: () => setPageBg(id, d.id) })),
        ...videos.map((v) => ({ k: `bg:video:${v.id}`, label: v.name, on: curBg === `video:${v.id}`, run: () => setPageBg(id, `video:${v.id}`) })),
      ] },
      { k: "lk", label: "Page look", keep: true, run: toggle("lk"), sub: [
        ...(main ? [] : [{ k: "lk:", label: "Same as main page", on: !curLook, run: () => setPageLook(id, null) }]),
        ...offeredLooks().map((l) => ({ k: `lk:${l.id}`, label: l.label, on: curLook === l.id, run: () => setPageLook(id, l.id) })),
      ] },
      { k: "d", label: dir === "push" ? "Swipe: fingers right go right" : "Swipe: the list follows your fingers", keep: true,
        run: () => { sfx.click(); save({ tmSwipeDir: dir === "push" ? "drag" : "push" }); } },
      ...(main ? [] : [{ k: "x", label: "Delete list", bad: true, keep: true, run: toggle("x"), sub: [
        { k: "x:keep", label: count ? `Delete, move its ${tasks} to the main list` : "Delete the list", run: () => deleteList(id, false) },
        ...(count ? [{ k: "x:all", label: `Delete it and its ${tasks}`, bad: true, run: () => deleteList(id, true) }] : []),
        { k: "x:no", label: "Cancel", run: () => setOpen(null), keep: true },
      ] }]),
    ];
  }
  const pick = (it: Item) => { it.run(); if (!it.keep) close(); };
  return createPortal(
    <div ref={ref} className="tm-ctx tl-menu" role="menu" aria-label={title}
      style={pos ? { left: pos.left, top: pos.top } : { left: at.x, top: at.y, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()} onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <span className="tm-ctx-t">{title}</span>
      {items.map((it) => (
        <div key={it.k} className="tm-ctx-grp">
          <button type="button" role="menuitem" className={`tm-ctx-i${it.bad ? " bad" : ""}${open === it.k ? " on" : ""}`}
            aria-expanded={it.sub ? open === it.k : undefined}
            onMouseEnter={(e) => { e.currentTarget.focus({ preventScroll: true }); sfx.hover(); }} onClick={() => pick(it)}>
            <span>{it.label}</span>{it.sub && <kbd>{open === it.k ? "▾" : "▸"}</kbd>}
          </button>
          {it.sub && open === it.k && (
            <div className="lp-sub" role="group" aria-label={it.label}>
              {it.sub.map((s) => (
                <button key={s.k} type="button" role="menuitem" className={`tm-ctx-i lp-sub-i${s.bad ? " bad" : ""}${s.on ? " cur" : ""}`}
                  onMouseEnter={(e) => { e.currentTarget.focus({ preventScroll: true }); sfx.hover(); }} onClick={() => pick(s)}>
                  <span>{s.label}</span>{s.on && <kbd>✓</kbd>}
                </button>
              ))}
              {!it.sub.length && <span className="lp-sub-none">No other list yet</span>}
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** The task menu's Move to list (views/TaskMenu.tsx): the other lists and + New list. */
export function ListPicker({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const all = allPages(ctx.pages, ctx.names, ctx.order);
  const here = new Set<string>();
  const known = new Set(ctx.groups.map((g) => g.id));
  for (const d of [ctx.lists.ranked, ctx.lists.daily, ...ctx.lists.groups.values()].flat()) if (ids.includes(d.id)) here.add(pageOfTask(d.data, known, ctx.pages));
  const others = all.filter((p) => !(here.size === 1 && here.has(p.id)));
  const make = () => {
    // A new list holding these tasks: a new group of its own on a new page just right of this one, in one write.
    if (ctx.pages.length >= PAGES_MAX || ctx.groups.length >= 30) return;
    const id = newPageId(), gid = newGroupId(), name = `List ${ctx.pages.length + 2}`;
    const i = ctx.order.indexOf(activeId);
    sfx.drop();
    void taskMapActions.moveTasks({ ids, to: "new", index: 0 }, { group: { id: gid, name: "To do" }, order: [...ctx.full, groupKey(gid)], page: id, pageName: name,
      pageOrder: placeAt(ctx.order, id, i >= 0 ? i + 1 : ctx.order.length) });
    askRename(`list:${id}`);
    goWhenReady = { id, until: Date.now() + 8000 };
    onDone();
  };
  return (
    <div className="lp-sub" role="group" aria-label="Move to list">
      {others.map((p) => (
        <button key={p.id} type="button" role="menuitem" className="tm-ctx-i lp-sub-i"
          onMouseEnter={(e) => { e.currentTarget.focus({ preventScroll: true }); sfx.hover(); }}
          onClick={() => { moveToList(ids, p.id); onDone(); }}><span>{p.name}</span></button>
      ))}
      {ctx.pages.length < PAGES_MAX && (
        <button type="button" role="menuitem" className="tm-ctx-i lp-sub-i" onMouseEnter={(e) => { e.currentTarget.focus({ preventScroll: true }); sfx.hover(); }}
          onClick={make}><span>+ New list</span></button>
      )}
    </div>
  );
}

// ---------- dragging a task to a dot or an edge ----------
type DropList = { page: string; side: "dot" | "left" | "right" };
let edges: { left: HTMLElement | null; right: HTMLElement | null } = { left: null, right: null };
const EDGE_IN = 14, EDGE_OUT = 110;
/** The page either side of the current one that tasks can go to (never a + page). */
function sideId(by: -1 | 1): string | null {
  const ids = ctxIds(), p = keyPager();
  const id = p ? ids[p.index() + by] : undefined;
  return id && !isPlus(id) ? id : null;
}
/** Where a dragged task would go to another list, if anywhere (x, y on the screen). */
export function listDropAt(x: number, y: number): DropList | null {
  if (ctx.order.length < 2) return null;
  for (const d of document.querySelectorAll<HTMLElement>(".tl-dots .tl-dot:not(.plus)")) {
    const r = d.getBoundingClientRect();
    if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 8 && y <= r.bottom + 8 && d.dataset.page && d.dataset.page !== activeId) return { page: d.dataset.page, side: "dot" };
  }
  const p = keyPager();
  const page = p?.root.querySelector<HTMLElement>(".tl-page:not(.tl-near)");
  if (!p || !page) return null;
  const r = page.getBoundingClientRect();
  const sc = p.root.closest(".tm-scroll")?.getBoundingClientRect();
  if (sc && (y < sc.top || y > sc.bottom)) return null;
  const l = sideId(-1), rr = sideId(1);
  if (l && x <= r.left + EDGE_IN && x >= r.left - EDGE_OUT) return { page: l, side: "left" };
  if (rr && x >= r.right - EDGE_IN && x <= r.right + EDGE_OUT) return { page: rr, side: "right" };
  return null;
}
/** While a task is dragged: the edges show the lists either side; the one it would go to lights up. null: done. */
export function listDragHint(x: number | null, y = 0) {
  if (x === null || ctx.order.length < 2) {
    edges.left?.remove(); edges.right?.remove(); edges = { left: null, right: null };
    document.querySelectorAll(".tl-dot.drop").forEach((d) => d.classList.remove("drop"));
    return;
  }
  const p = keyPager();
  const page = p?.root.querySelector<HTMLElement>(".tl-page:not(.tl-near)");
  if (!p || !page) return;
  const r = page.getBoundingClientRect();
  const make = (side: "left" | "right", name: string) => {
    let el = edges[side];
    if (!el) { el = document.createElement("div"); el.className = `tl-edge ${side}`; el.setAttribute("aria-hidden", "true"); document.body.appendChild(el); edges[side] = el; }
    el.textContent = side === "left" ? `‹ ${name}` : `${name} ›`;
    const sc = p.root.closest(".tm-scroll")?.getBoundingClientRect();
    el.style.top = `${Math.max(sc?.top ?? 0, 0) + 12}px`;
    el.style.height = `${Math.max(80, (sc ? Math.min(sc.bottom, window.innerHeight) : window.innerHeight) - Math.max(sc?.top ?? 0, 0) - 24)}px`;
    el.style.left = side === "left" ? `${r.left - 44}px` : `${r.right + 8}px`;
    return el;
  };
  const at = listDropAt(x, y);
  const l = sideId(-1), rr = sideId(1);
  if (l) make("left", pageName(l)).classList.toggle("hot", at?.side === "left"); else { edges.left?.remove(); edges.left = null; }
  if (rr) make("right", pageName(rr)).classList.toggle("hot", at?.side === "right"); else { edges.right?.remove(); edges.right = null; }
  document.querySelectorAll<HTMLElement>(".tl-dots .tl-dot").forEach((d) => d.classList.toggle("drop", at?.side === "dot" && d.dataset.page === at.page));
}
/** A list's name by id (the drag label). */
export const listName = (id: string) => pageName(id);
let flashTimer = 0;
function flashDot(page: string) {
  document.querySelectorAll<HTMLElement>(`.tl-dots .tl-dot[data-page="${CSS.escape(page)}"]`).forEach((d) => {
    d.classList.remove("got"); void d.offsetWidth; d.classList.add("got");
  });
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => document.querySelectorAll(".tl-dot.got").forEach((d) => d.classList.remove("got")), 900);
}

/** A list with no sections left (they were moved away): say how to fill it, and offer a task group of its own. */
export function EmptyList({ id }: { id: string }) {
  const add = () => {
    const c = ctx;
    if (c.groups.length >= 30) return;
    const gid = newGroupId();
    sfx.click();
    save({ tmGroups: cleanGroups([...c.groups, { id: gid, name: "To do" }]), tmSecOrder: [...c.full, groupKey(gid)], tmPages: moveSec(c.pages, groupKey(gid), id) });
  };
  return (
    <div className="lp-empty">
      <span>This list is empty. Right click a section's name on another list and pick Move to list, or drag a task onto this list's dot.</span>
      <button type="button" className="no-drag" onMouseDown={(e) => e.stopPropagation()} onClick={add}>Add a task group here</button>
    </div>
  );
}
