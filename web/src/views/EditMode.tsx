// Edit mode for the floating Tab list. G Squad release (the developer, 7 Nov 2026): the Edit button top left; every panel and
// button can be dragged anywhere (it snaps to the screen's edges and centre and to the other panels, and never leaves
// the screen) and removed with its x.
//
// V1.55, the overview (the developer, 12 Nov 2026): "when you click the edit button at the top left, I want it to do a very
// fancy animation where the screen minimizes a bit. The screen goes dark around the screen that you just minimized,
// the main page goes to the very centre of your screen in a smaller form, and on the right you see a plus symbol to
// add a new page ... you can move stuff around different pages ... change the size of the different buttons".
// - The page showing springs down to a card in the middle; the rest of the screen goes dark; the other pages sit
//   beside it in their order (core/lists.ts, views/ListPager.tsx), with a + card past each end to add a page there.
//   A click on a page beside brings it to the middle. Its name pill above it drags it to another place in the order.
// - On the card in the middle every panel and button has its outline: drag it within the page, or onto a page beside
//   (or a + card) to move it to that page. The corner handle sizes it; a wide panel also has a width handle.
// - Add panel (the + in the bar, or + on an empty page) opens the gallery: every panel and button, always. Any of
//   them can be added many times (copies, core/tablayout.ts); the x removes one, and the gallery still has it.
// - The Meetings panel's three buttons (refresh, Dynamic Island, Private mode) drag out of it to be buttons of their
//   own, and back in by dropping them on a Meetings panel. Each Meetings panel can show its own calendar.
// - Esc closes the gallery or a menu first, then leaves the overview. Done leaves it too. Nothing is gated.
// The rules (places, pages, copies, sizes, snapping, the record) are pure functions in core/tablayout.ts; the layout is
// one small vault record per account (actions.ts saveTabLayout), written only when something changed, so it follows the
// account to every Mac and the website. The phone and the website's To-do page never use Slots.
//
// How a panel is drawn: each one sits in a <Slot>, a wrapper with display: contents (no box, so the columns lay out
// exactly as before). A moved panel's wrapper becomes position: fixed with a pure CSS place (tablayout.ts slotStyle). A
// removed one, or one on another page, is display: none (still mounted, so whatever it runs keeps running). A copy is
// the same element as its original (the original's Slot hands it over, so it needs no props of its own), drawn by
// <CopySlots> into the original's column, or fixed where it was put; useInst() tells a panel which one it is.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PS, psPost } from "../ps";
import { saveTabLayout } from "../core/actions";
import {
  addPanel, canHide, cfgOf, drawsBare, isOptIn, dropPage, gallery, hideSlot, isCopy, isWide, kindOf, moveSlot, onPage, outOf, pageOf, pullOut, pushIn, putOnPage, resetLayout,
  sameLayout, setCfg, setSize, sizeOf, slotInfo, slotLabel, slotStyle, followStyle, snapRect, toPos, fromPos, MAIN_PAGE, SIZE_MAX, SIZE_MIN, EDGE,
  type InstCfg, type Rect, type TabLayout,
} from "../core/tablayout";
import { macAccounts, newFeedId, panelCal } from "../core/calfeeds";
import { onRedProject } from "../core/project";
import { barSpot, camBounds, clickPick, easeInOut, edgePan, follow, flickTo, glideMs, hintSpot, hitOf, isClick, keepInPlace, pansFrom, rubber, type Spot } from "../core/overviewnav";
import { islandBox, onIsland } from "../ui/islandspot";
import { editSfx, sfx } from "../ui/sfx";
import type { Settings } from "../core/model";
import { passTick } from "../core/editsounds";
import { backupLook, canSaveMore, deleteLook, findLook, looksOf, lookNamed, nextLookName, onlyKind, renameLook, replaceLook, restoreLook, saveLook, tidyLookName, LOOK_NAME_MAX, LOOKS_MAX, type LooksStore, type Removed, type SavedLook } from "../core/looksprofiles";
import { applyMacLook, macDefault, macPreview, macSnapshot, type MacLook } from "../core/maclook";
import { PhoneMount } from "./PhoneEditor";
import { PHONE_BTN, phoneButtonSpot } from "../core/phonedevices";   // V1.56: the bar keeps clear of the phone button
import "./editmode.css";

// ---------- one small store for everything Edit mode draws ----------
const subs = new Set<() => void>();
const emit = () => subs.forEach((l) => l());
const subscribe = (l: () => void) => { subs.add(l); return () => { subs.delete(l); }; };
const useStore = <T,>(get: () => T) => useSyncExternalStore(subscribe, get);

// The overview's three states: off, on, and leaving (the card springs back to full screen, then the chrome goes).
type Phase = "off" | "on" | "leaving";
let phase: Phase = "off";
export const editingNow = () => phase === "on";
export function useEditing() { return useStore(() => phase === "on"); }
const usePhase = () => useStore(() => phase);
function setEditing(on: boolean) {
  const next: Phase = on ? "on" : phase === "off" ? "off" : "leaving";
  if (next === phase) return;
  phase = next;
  emit();
  if (PS) psPost({ type: "island:edit", on });   // the Dynamic Island shows itself, ready to be dragged
  if (next === "leaving") window.setTimeout(() => { if (phase === "leaving") { phase = "off"; emit(); } }, reducedMotion() ? 0 : 560);
}
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- the layout: the vault's copy, or the one just changed here until the vault catches up ----------
let pending: TabLayout | null = null;
let saveTimer = 0;
function change(next: TabLayout, now = false) {
  pending = next;
  emit();
  window.clearTimeout(saveTimer);
  const go = () => { saveTimer = 0; const p = pending; if (p) void saveTabLayout(p).catch(() => {}); emit(); };
  if (now) go(); else saveTimer = window.setTimeout(go, 500);
}
function flush() { if (saveTimer) { window.clearTimeout(saveTimer); saveTimer = 0; const p = pending; if (p) void saveTabLayout(p).catch(() => {}); } }
const usePending = () => useStore(() => pending);
/** The layout on screen: what was just changed here, else the account's saved one. */
export function useTabLayout(saved: TabLayout): TabLayout {
  const p = usePending();
  useEffect(() => { if (p && sameLayout(p, saved) && !saveTimer) { pending = null; emit(); } }, [p, saved]);
  return p ?? saved;
}
const at = () => new Date().toISOString();

// ---------- the pages (views/ListPager.tsx hands them over; one page, the main one, until it does) ----------
export type OvPages = {
  ids: string[];                        // left to right, the main page among them (never the empty + pages)
  cur: string;                          // the page showing
  name: (id: string) => string;
  secs: (id: string) => string[];       // the section names shown on it, for its card
  go: (id: string) => void;
  jump?: (id: string) => void;          // show it at once, no slide inside the list (the overview glides its own row)
  add: (index: number) => string | null;   // a new empty page at this place in ids; its id
  order: (ids: string[]) => void;
  remove: (id: string) => void;
};
const ONE: OvPages = { ids: [MAIN_PAGE], cur: MAIN_PAGE, name: () => "Main list", secs: () => [], go: () => {}, add: () => null, order: () => {}, remove: () => {} };
let pagesApi: OvPages = ONE;
let pagesVer = 0;
/** TaskMap calls this on every draw with the lists' pages. */
export function setOverviewPages(p: OvPages) {
  const same = p.cur === pagesApi.cur && p.ids.join() === pagesApi.ids.join() && p.ids.every((id) => p.name(id) === pagesApi.name(id) && p.secs(id).join() === pagesApi.secs(id).join());
  pagesApi = p;
  if (!same) { pagesVer++; queueMicrotask(emit); }
}
const usePages = () => { useStore(() => pagesVer); return pagesApi; };

// ---------- the panel being dragged, and the ones that just arrived ----------
type Drag = { id: string; rect: Rect };
let drag: Drag | null = null;
function setDrag(d: Drag | null) { drag = d; emit(); }
const useDrag = () => useStore(() => drag);
let fresh = new Set<string>();
function markFresh(ids: string[]) { fresh = new Set(ids); emit(); window.setTimeout(() => { fresh = new Set(); emit(); }, 520); }
const useFresh = () => useStore(() => fresh);
let galleryOpen = false;
function setGallery(on: boolean) { if (galleryOpen !== on) { galleryOpen = on; emit(); } }
const useGallery = () => useStore(() => galleryOpen);

// ---------- slots ----------
type Ctx = { layout: TabLayout; page: string; pages: ReadonlySet<string>; red: boolean };
const SlotCtx = createContext<Ctx | null>(null);
const InstCtx = createContext<string | null>(null);
/** The element each original draws, handed to its copies (filled as the list draws, originals first). */
const made = new Map<string, ReactNode>();
/** V1.56: the same element for the phone (views/PhoneEditor.tsx, gos/PhonePages.tsx), or undefined when this device
 *  does not draw that panel. */
export const panelElement = (kind: string): ReactNode | undefined => made.get(kind);
/** Only the floating list (never the website's To-do page or the phone) gets places and Edit mode. page: the page
 *  showing; pages: every page that exists; red: the developer's account. */
export function EditScope({ layout, page = MAIN_PAGE, pages, red = false, children }: { layout: TabLayout | null; page?: string; pages?: string[]; red?: boolean; children: ReactNode }) {
  const key = pages?.join() ?? "";
  const set = useMemo(() => new Set(pages ?? [MAIN_PAGE]), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = useMemo(() => (layout ? { layout, page, pages: set, red } : null), [layout, page, set, red]);
  return <SlotCtx.Provider value={v}>{children}</SlotCtx.Provider>;
}
/** Which panel this is (its Slot's id) with its own settings and the buttons dragged out of it. null: not in a Slot. */
export function useInst(): { id: string; cfg: InstCfg; out: Set<string> } | null {
  const c = useContext(SlotCtx);
  const id = useContext(InstCtx);
  return useMemo(() => (c && id ? { id, cfg: cfgOf(c.layout, id), out: outOf(c.layout, id) } : null), [c, id]);
}
/** V1.57: change this panel's own settings from inside it (outside Edit mode too), saved and synced at once with the
 *  layout record. A no-op outside a Slot (the website's To-do page, the phone). */
export function useInstSave(): ((patch: Partial<InstCfg>) => void) | null {
  const c = useContext(SlotCtx);
  const id = useContext(InstCtx);
  const ref = useRef(c);
  ref.current = c;
  return useMemo(() => (c && id ? (patch: Partial<InstCfg>) => { const l = ref.current?.layout; if (l) change(setCfg(l, id, patch, at()), true); } : null), [!!c, id]); // eslint-disable-line react-hooks/exhaustive-deps
}
/** V1.57: is this panel on the page showing (true outside a Slot)? A panel kept open asks, so one on another page
 *  draws nothing (and runs no timer) until its page shows. */
export function useShownHere(): boolean {
  const c = useContext(SlotCtx);
  const id = useContext(InstCtx);
  return !c || !id || shownHere(c, id);
}
/** Is a Slot of this panel on the page showing? (A panel that runs something only while seen can ask.) */
const shownHere = (c: Ctx, id: string) => {
  const s = slotInfo(id);
  if (s?.keep) return true;   // the gear and Tab and Lock are on every page
  if (isOptIn(id)) return false;   // PS 1.65 G Squad pieces: off the page until a copy is added
  if (!isCopy(id) && c.layout.hidden.includes(id)) return false;
  return pageOf(c.layout, id, c.pages) === c.page;
};
export function Slot({ id, children }: { id: string; children: ReactNode }) {
  const c = useContext(SlotCtx);
  const d = useDrag();
  const f = useFresh();
  if (!isCopy(id)) made.set(id, children);   // V1.56: on the phone too (no Edit mode there), for its pages of panels
  if (!c) return drawsBare(id) ? <>{children}</> : null;   // PS 1.65: a G Squad piece original is on no page, here either (the website To-do page drew all five)
  const here = shownHere(c, id);
  const p = c.layout.pos[id];
  // V1.58 smooth page swipe (views/pagelayer.ts): which page it belongs to (none for the gear and Tab and Lock, on
  // every page, and for a removed one). A main page panel in a column keeps its room while another page shows
  // (ed-box), so the columns never reflow as pages change and it can slide back in with its page.
  const removed = !isCopy(id) && (c.layout.hidden.includes(id) || isOptIn(id));
  const pg = slotInfo(id)?.keep || removed ? undefined : pageOf(c.layout, id, c.pages);
  const box = !here && !removed && !p && pg === MAIN_PAGE;
  const z = sizeOf(c.layout, id);
  const dragging = d?.id === id;
  const style: Record<string, string> = dragging
    ? { left: `${d.rect.left}px`, top: `${d.rect.top}px`, width: `${d.rect.width}px`, maxHeight: `calc(100vh - ${2 * EDGE}px)` }
    : p ? slotStyle(p, z) : followStyle(c.layout, id) ?? {};   // V1.58: Pomodoro follows a moved Time zones (core/tablayout.ts)
  const follows = !p && !dragging && "left" in style;
  if (z !== 1) style["--ed-z"] = String(z);
  return (
    <InstCtx.Provider value={id}>
      <div data-slot={id} data-pg={pg} style={style}
        className={`ed-slot${p || dragging || follows ? " ed-moved" : ""}${here ? "" : " ed-hidden"}${box && !dragging ? " ed-box" : ""}${dragging ? " ed-dragging" : ""}${f.has(id) ? " ed-fresh" : ""}${z !== 1 ? " ed-z" : ""}${isCopy(id) ? " ed-copy" : ""}`}>
        {children}
      </div>
    </InstCtx.Provider>
  );
}
/** A button inside a panel that can be dragged out (core/tablayout.ts inner): left out while it is outside. */
export function Inner({ kind, children }: { kind: string; children: ReactNode }) {
  const c = useContext(SlotCtx);
  const inst = useInst();
  if (!c) return <>{children}</>;
  made.set(kind, children);
  if (inst?.out.has(kind)) return null;
  return <span className="ed-inner" data-inner={kind}>{children}</span>;
}
/** The copies (core/tablayout.ts extra): each drawn where its original's column is, or at its own place. */
export function CopySlots() {
  const c = useContext(SlotCtx);
  if (!c) return null;
  return <>{(c.layout.extra ?? []).map((id) => <CopyAt key={id} id={id} />)}</>;
}
function CopyAt({ id }: { id: string }) {
  const [host, setHost] = useState<Element | null>(null);
  const kind = kindOf(id);
  useLayoutEffect(() => {
    const root = document.querySelector(".tm-overlay:not(.tm-docked)");
    const orig = slotInfo(id)?.inner ? null : root?.querySelector(`[data-slot="${kind}"]`)?.parentElement ?? null;
    setHost(orig ?? root ?? null);
  }, [id, kind]);
  const el = made.get(kind);
  if (!host || el === undefined) return null;
  return createPortal(<Slot id={id}>{el}</Slot>, host);
}

// ---------- the Edit button, top left ----------
export function EditButton({ kept, onKeep, shown, red, saved, st, onSettings }: { kept: boolean; onKeep: (on: boolean, stay?: boolean) => void; shown: boolean; red: boolean; saved: TabLayout; st?: Settings; onSettings?: (patch: Partial<Settings>) => void }) {
  const ph = usePhase();
  const keptBefore = useRef(false);
  const start = () => {
    editSfx("edit-in");
    keptBefore.current = kept;
    if (!kept) onKeep(true);   // the list stays up while you move things, with Tab let go
    setGallery(false);
    setEditing(true);
  };
  const done = () => {
    flush();
    setDrag(null);
    setGallery(false);
    setEditing(false);
    // V1.57 (the developer: "it keeps you in until you hold/let go of tab again or you click anywhere on screen that there isn't
    // a button/panel"): leaving Edit (a page clicked, the room clicked, Done, Esc) never puts the list away. Keep comes
    // off, the list stays up pinned: the next Tab or a click on empty space (the list's own background) closes it.
    if (!keptBefore.current) onKeep(false, true);
  };
  // The list put away (or the page closing) ends Edit mode and saves.
  useEffect(() => { if (!shown && phase !== "off") { flush(); setDrag(null); setGallery(false); phase = "off"; emit(); if (PS) psPost({ type: "island:edit", on: false }); } }, [shown]);
  useEffect(() => () => { flush(); if (phase !== "off") { setDrag(null); phase = "off"; emit(); } }, []);
  return (
    <>
      {ph === "off" && (
        <div className="ed-corner" onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" className="ed-btn" onClick={start} title="Arrange pages, panels and buttons">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" />
            </svg>
            Edit
          </button>
        </div>
      )}
      {ph !== "off" && createPortal(<Overview red={red} saved={saved} leaving={ph === "leaving"} onDone={done} st={st} onSettings={onSettings} />, document.body)}
    </>
  );
}

// ---------- the camera: sliding along the row of pages (V1.56, core/overviewnav.ts) ----------
// The developer, 13 Nov 2026: "use my mouse in the edit panel to like slide across and move to different screens", and the screen
// edges slide it like the to-do list's bottom edge. The whole row (the live page in the middle, the cards beside, the +
// cards, the name pills) moves together with one `translate` on two elements, written straight to the page each frame
// (never a React draw, never a CSS variable on <html>, so nothing else recalculates). The camera is an offset in pages
// from the page showing: 0 is that page in the middle. One frame loop runs only while something moves and stops by itself.
type Glide = { from: number; to: number; t0: number; ms: number; then?: () => void; at: number; fired: boolean };
const cam = {
  off: 0, raw: 0, target: 0, step: 1, ci: 0, n: 1,
  edge: 0,                   // px per frame from the edge zone (0: not at an edge)
  drag: false,               // the room is held and dragged: the camera follows the pointer directly
  wheelUntil: 0,             // a trackpad swipe is moving it directly until this time
  glide: null as Glide | null,
  raf: 0, last: 0,
  onPan: null as (() => void) | null,   // the edit layer re-checks a carried panel's drop target as the row slides
  ticks: false, tickPage: 0, tickAt: 0,   // a soft tick as each page passes the middle (core/editsounds.ts passTick)
};
const offBounds = () => { const b = camBounds(cam.n); return { min: b.min - cam.ci, max: b.max - cam.ci }; };
/** How far the row is moved right now, in screen pixels. */
const panPx = () => -cam.off * cam.step;
function camPaint() {
  const px = `${panPx().toFixed(2)}px 0`;
  const t = document.querySelector<HTMLElement>(".ov-track");
  if (t) t.style.translate = px;
  const ov = overlayEl();
  if (ov) ov.style.translate = cam.off ? px : "";
  cam.onPan?.();
  if (cam.ticks) {
    const t = passTick(cam.tickPage, cam.ci + cam.off, cam.tickAt, performance.now());
    if (t.tick) editSfx("edit-tick");
    cam.tickPage = t.page; cam.tickAt = t.at;
  }
}
function camTick(t: number) {
  cam.raf = 0;
  const dt = Math.min(48, Math.max(1, t - (cam.last || t - 16)));
  cam.last = t;
  const b = offBounds();
  const was = cam.off;
  let busy = false;
  if (cam.glide) {
    const g = cam.glide;
    const k = reducedMotion() ? 1 : (t - g.t0) / g.ms;
    cam.off = g.from + (g.to - g.from) * easeInOut(k);
    if (g.then && !g.fired && k >= g.at) { g.fired = true; g.then(); }
    if (k >= 1) { cam.glide = null; cam.off = cam.target = cam.raw = g.to; } else busy = true;
  } else if (cam.edge && !cam.drag) {
    cam.off = Math.max(b.min, Math.min(b.max, cam.off + cam.edge * dt / 16.67 / cam.step));
    cam.target = cam.raw = cam.off;
    busy = cam.off !== was;   // stopped at an end: the loop rests until the pointer moves again
  } else if (!cam.drag && performance.now() > cam.wheelUntil) {
    const to = Math.max(b.min, Math.min(b.max, cam.target));
    cam.off = follow(cam.off, to, dt);
    if (Math.abs(cam.off - to) * cam.step < 0.25) cam.off = to;
    cam.raw = cam.target = cam.off === to ? to : cam.target;
    busy = cam.off !== to;
  } else busy = !cam.drag;   // a trackpad swipe still moving: look again next frame
  if (cam.off !== was) camPaint();
  if (busy) cam.raf = requestAnimationFrame(camTick);
}
function camRun() { if (!cam.raf) { cam.last = 0; cam.raf = requestAnimationFrame(camTick); } }
/** Glide the camera to an offset (0: the page showing in the middle); `then` runs once at `at` (0 to 1) of the way. */
function camGlide(to: number, then?: () => void, at = 1, maxMs = Infinity) {
  const dist = Math.abs(to - cam.off);
  if (dist * cam.step < 1 && !cam.glide) { cam.off = cam.target = cam.raw = to; camPaint(); then?.(); return; }
  cam.glide = { from: cam.off, to, t0: performance.now(), ms: Math.min(maxMs, glideMs(dist)), then, at, fired: false };
  camRun();
}
function camReset() {
  cancelAnimationFrame(cam.raf);
  Object.assign(cam, { off: 0, raw: 0, target: 0, edge: 0, drag: false, wheelUntil: 0, glide: null, raf: 0, last: 0, ticks: false });
  document.querySelector<HTMLElement>(".ov-track")?.style.removeProperty("translate");
  overlayEl()?.style.removeProperty("translate");
}

// ---------- the overview's geometry (the same numbers as editmode.css html.ov-on) ----------
const S_ON = 0.6, S_GALLERY = 0.46, GAP = 56;
const scaleOf = (g: boolean) => (g ? S_GALLERY : S_ON);
/** The live page's card (the list itself, scaled): where it is on screen right now, and its scale. */
function liveCard(): { r: DOMRect; s: number } | null {
  const el = document.querySelector<HTMLElement>(".tm-overlay.ed-able");
  if (!el || !el.offsetWidth) return null;
  const r = el.getBoundingClientRect();
  return { r, s: r.width / el.offsetWidth };
}
/** Spring easing for CSS (a damped spring sampled into linear()), with a plain overshoot curve where linear() is not known. */
function springCss(): string {
  const ok = typeof CSS !== "undefined" && CSS.supports?.("transition-timing-function", "linear(0, 1)");
  if (!ok) return "cubic-bezier(.3, 1.32, .45, 1)";
  const w = 2 * Math.PI / 0.62, z = 0.58, out: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, wd = w * Math.sqrt(1 - z * z);
    const x = 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
    out.push(x.toFixed(4));
  }
  return `linear(${out.join(", ")})`;
}

// ---------- the overview: the dark room, the pages beside, the bar, the gallery ----------
type CalPick = { id: string; x: number; y: number };
let calPickNow: CalPick | null = null;
function setCalPick(p: CalPick | null) { calPickNow = p; emit(); }
const useCalPick = () => useStore(() => calPickNow);
/** The drop the edit layer is hovering (a page beside or a + card), for the cards to light up. */
let hoverTarget: string | null = null;
function setHoverTarget(t: string | null) { if (t !== hoverTarget) { hoverTarget = t; emit(); } }
const useHoverTarget = () => useStore(() => hoverTarget);
/** Where every panel was last seen on its page (page coordinates), for the cards of the pages beside. */
const lastSeen = new Map<string, Rect>();
let liveSize = { w: 1440, h: 900 };

function Overview({ red, saved, leaving, onDone, st, onSettings }: { red: boolean; saved: TabLayout; leaving: boolean; onDone: () => void; st?: Settings; onSettings?: (patch: Partial<Settings>) => void }) {
  const layout = useTabLayout(saved);
  const pg = usePages();
  const gal = useGallery();
  const pick = useCalPick();
  const hov = useHoverTarget();
  const [on, setOn] = useState(false);   // one frame at full size, then the spring down (so it always animates)
  const [vw, setVw] = useState(() => window.innerWidth), [vh, setVh] = useState(() => window.innerHeight);
  const [reorder, setReorder] = useState<{ id: string; dx: number; to: number } | null>(null);
  const [sure, setSure] = useState<"reset" | string | null>(null);
  const s = scaleOf(gal);
  const ty = gal ? -0.15 * vh : 0.02 * vh;
  // The page that was showing when Edit opened: a click on the room goes back to it (the developer, 13 Nov 2026).
  const start = useRef(pg.cur);
  const exiting = useRef(false);
  // The overlay itself is the card in the middle: html.ov-on scales it (editmode.css).
  useLayoutEffect(() => {
    const h = document.documentElement;
    h.style.setProperty("--ov-spring", springCss());
    // Two frames at full size so the spring always runs (a timer too, for a page whose frames are paused).
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    const t = window.setTimeout(() => setOn(true), 60);
    return () => { cancelAnimationFrame(r); window.clearTimeout(t); };
  }, []);
  useLayoutEffect(() => {
    const h = document.documentElement;
    const live = on && !leaving;
    h.classList.toggle("ov-on", live);
    h.style.setProperty("--ov-s", String(live ? s : 1));
    h.style.setProperty("--ov-inv", String(live ? 1 / s : 1));
    h.style.setProperty("--ov-y", `${live ? ty : 0}px`);
  }, [on, leaving, s, ty]);
  useEffect(() => () => { const h = document.documentElement; h.classList.remove("ov-on", "ov-panning"); for (const v of ["--ov-s", "--ov-inv", "--ov-y"]) h.style.removeProperty(v); camReset(); }, []);
  useEffect(() => { const f = () => { setVw(window.innerWidth); setVh(window.innerHeight); }; window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  // Leaving (Done, Esc, a click): the row glides home while the card grows back to the whole screen.
  const flying = useRef(false);
  const leave = () => { if (exiting.current) return; exiting.current = true; cam.edge = 0; cam.ticks = false; if (!flying.current) editSfx("edit-out"); if (cam.glide?.to !== 0) camGlide(0, undefined, 1, 440); onDone(); };   // home before the card is full size (560 ms)
  // Esc: the calendar menu, a question, the gallery, then out. Never waits on anything.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (calPickNow) setCalPick(null);
      else if (sure) setSure(null);
      else if (popOpen.current) setPop(null);
      else if (galleryOpen) { sfx.click(); setGallery(false); }
      else leave();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [sure, onDone]); // eslint-disable-line react-hooks/exhaustive-deps
  const popOpen = useRef(false);
  useEffect(() => { if (!sure) return; const t = window.setTimeout(() => setSure(null), 3500); return () => window.clearTimeout(t); }, [sure]);

  const ids = pg.ids;
  const ci = Math.max(0, ids.indexOf(pg.cur));
  const W = vw * s, H = vh * s, cx = vw / 2, cy = vh / 2 + ty;
  const step = W + GAP;
  const slotLeft = (i: number) => cx - W / 2 + (i - ci) * step;
  // While a name pill is dragged: the order it would make.
  const shownOrder = reorder ? (() => { const o = ids.filter((x) => x !== reorder.id); o.splice(reorder.to, 0, reorder.id); return o; })() : ids;
  const pagesSet = new Set(ids);

  // ---- Saved looks (core/looksprofiles.ts, core/maclook.ts): Save, the Looks menu, Reset to default, Undo ----
  const [pop, setPop] = useState<"looks" | "save" | null>(null);
  const [toast, setToast] = useState<{ text: string; undo: () => void; key: number } | null>(null);
  const live$ = useRef({ st, layout });
  live$.current = { st, layout };
  const canLooks = !!st && !!onSettings;
  const storeNow = (): LooksStore => live$.current.st?.looksSaved ?? {};
  const snapNow = (): MacLook => macSnapshot(live$.current.st ?? {}, live$.current.layout);
  const saveStore = (next: LooksStore, extra?: Partial<Settings>) => onSettings?.({ ...extra, looksSaved: onlyKind(next, "mac") });
  /** Put a whole setup on: its settings, its layout, a soft blur through the change, every panel arriving fresh. */
  const putOn = (l: { patch: Partial<Settings>; layout: TabLayout }, store?: LooksStore) => {
    onSettings?.(store ? { ...l.patch, looksSaved: onlyKind(store, "mac") } : l.patch);
    change(l.layout, true);
    markFresh([...Object.keys(l.layout.pos), ...(l.layout.extra ?? []), ...Object.keys(live$.current.layout.pos)]);
    const h = document.documentElement;
    h.classList.remove("ov-swap"); void h.offsetWidth; h.classList.add("ov-swap");
    window.setTimeout(() => h.classList.remove("ov-swap"), 700);
    camGlide(0);
  };
  const say = (text: string, undo: () => void) => setToast({ text, undo, key: Date.now() });
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 10_000); return () => window.clearTimeout(t); }, [toast]);
  /** Undo a switch or a reset: the setup saved just before it goes back on (and stays saved). */
  const undoTo = (id: string) => () => {
    const b = findLook<MacLook>(storeNow(), "mac", id);
    if (!b) return;
    editSfx("edit-switch");
    putOn(applyMacLook(live$.current.st ?? {}, b.data, at()));
    setToast(null);
  };
  const switchTo = (look: SavedLook<MacLook>) => {
    const b = backupLook(storeNow(), "mac", snapNow(), "switch", at());
    editSfx("edit-switch");
    putOn(applyMacLook(live$.current.st ?? {}, look.data, at()), b.store);
    setPop(null);
    say(`Now showing ${look.name}`, undoTo(b.id));
  };
  const resetAll = () => {
    const b = backupLook(storeNow(), "mac", snapNow(), "reset", at());
    editSfx("edit-reset");
    putOn(macDefault(live$.current.st ?? {}, at()), b.store);
    say("Back to the default layout", undoTo(b.id));
  };
  const saveAs = (name: string, over: string | null) => {
    const data = snapNow();
    const next = over ? replaceLook(storeNow(), "mac", over, data, at(), name) : saveLook(storeNow(), "mac", data, { name, now: at() }).store;
    editSfx("edit-save");
    saveStore(next);
    setPop("looks");
  };
  const removeLook = (id: string) => {
    const r = deleteLook(storeNow(), "mac", id);
    if (!r.removed) return;
    const gone: Removed = r.removed;
    editSfx("edit-page-remove");
    saveStore(r.store);
    say(`${gone.look.name} deleted`, () => { saveStore(restoreLook(storeNow(), gone)); editSfx("edit-save"); setToast(null); });
  };
  const renameTo = (id: string, name: string) => saveStore(renameLook(storeNow(), "mac", id, name));

  // ---- the camera follows the page showing (core/overviewnav.ts keepInPlace) ----
  const room = useRef<HTMLDivElement>(null);
  const prev = useRef<{ cur: string; ids: string[] } | null>(null);
  const focusNext = useRef<{ id: string; zoom: boolean; until: number } | null>(null);
  const [plusGen, setPlusGen] = useState(0);
  useEffect(() => { if (on && !leaving && !exiting.current) { cam.tickPage = Math.round(cam.ci + cam.off); cam.ticks = true; } }, [on, leaving]);
  useLayoutEffect(() => {
    cam.step = step; cam.ci = ci; cam.n = ids.length;
    const p = prev.current;
    prev.current = { cur: pg.cur, ids };
    if (p && p.ids.length !== ids.length) setPlusGen((g) => g + 1);   // the + cards move out: they pop in again
    if (p && p.cur !== pg.cur) {
      // A new page in the middle: everything stays where it was on screen this frame (no glides for one frame), then
      // the camera glides to the new page. Asked by a click: then it zooms in (the developer: "a fancy animation going there").
      cam.glide = null;
      cam.off = cam.raw = cam.target = keepInPlace(cam.off, p.ids, p.cur, ids, pg.cur);
      const r = room.current;
      if (r && p.ids.includes(pg.cur)) {
        r.classList.add("ov-snap");
        requestAnimationFrame(() => requestAnimationFrame(() => r.classList.remove("ov-snap")));
      }
      camPaint();
      const f = focusNext.current;
      focusNext.current = null;
      if (f && f.id === pg.cur && f.zoom) camGlide(0, leave, 0.72);
      else camGlide(0);
      return;
    }
    camPaint();
  }, [pg.cur, ids.join(), step]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Bring a page to the middle (no slide inside the list: the row glides), and zoom into it when asked. */
  const focusPage = (id: string, zoom: boolean) => {
    if (id === pg.cur) { if (zoom) camGlide(0, leave, 0.72); else camGlide(0); return; }
    focusNext.current = { id, zoom, until: Date.now() + 1500 };
    (pg.jump ?? pg.go)(id);
    // The page did not come (deleted meanwhile): just leave or stay.
    window.setTimeout(() => { if (focusNext.current?.id === id) { focusNext.current = null; if (zoom) leave(); } }, 1500);
  };
  const zoomInto = (id: string) => { if (exiting.current) return; flying.current = true; cam.ticks = false; editSfx("edit-fly"); setGallery(false); setPop(null); focusPage(id, true); };
  const addAt = (index: number) => {
    editSfx("edit-page-add");
    const id = pg.add(index);
    if (!id) return;
    focusNext.current = { id, zoom: false, until: Date.now() + 1500 };
    (pg.jump ?? pg.go)(id);
    window.setTimeout(() => setGallery(true), 260);
  };
  // Add panel adds to the page in the middle: the row glides back to it first.
  useEffect(() => { if (gal) camGlide(0); }, [gal]);

  // ---- the pointer: clicks zoom in, drags slide the row, the screen's left and right edges slide it too ----
  const live = on && !leaving;
  popOpen.current = !!pop;
  const api = useRef({ ids, cur: pg.cur, zoomInto, live, sure, unsure: () => setSure(null), pop: !!pop, unpop: () => setPop(null) });
  api.current = { ids, cur: pg.cur, zoomInto, live, sure, unsure: () => setSure(null), pop: !!pop, unpop: () => setPop(null) };
  useEffect(() => {
    type Press = { x: number; y: number; pid: number; pan: boolean; moved: boolean; raw0: number; samples: { t: number; x: number }[] };
    let press: Press | null = null;
    let eatClick = 0;
    const down = (e: PointerEvent) => {
      if (!api.current.live || e.button !== 0 || !e.isPrimary) { press = null; return; }
      const t = e.target as Element | null;
      press = { x: e.clientX, y: e.clientY, pid: e.pointerId, pan: !drag && pansFrom(t), moved: false, raw0: cam.off, samples: [{ t: performance.now(), x: e.clientX }] };
    };
    const moveP = (e: PointerEvent) => {
      // The edge scroll: the pointer resting near the screen's left or right edge (also while carrying a panel).
      const over = e.target as Element | null;
      const quiet = !api.current.live || galleryOpen || !!calPickNow || cam.drag || !!over?.closest?.(".ov-gal, .ov-cal, .ov-bar") || phoneUi(over);
      const sp = quiet ? 0 : edgePan(e.clientX, window.innerWidth);
      if (sp !== cam.edge) { cam.edge = sp; if (sp) { cam.glide = null; camRun(); } }
      else if (sp) camRun();
      const p = press;
      if (!p || e.pointerId !== p.pid) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (!p.moved && isClick(dx, dy)) return;
      p.moved = true;
      if (!p.pan) return;
      if (!cam.drag) {
        cam.drag = true; cam.glide = null; cam.edge = 0; document.documentElement.classList.add("ov-panning");
        try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* let go outside the window: blur ends it */ }
      }
      const b = offBounds();
      cam.raw = p.raw0 - dx / cam.step;
      cam.off = rubber(cam.raw, b.min, b.max, 0.35);
      const now = performance.now();
      p.samples.push({ t: now, x: e.clientX });
      while (p.samples.length > 2 && now - p.samples[0].t > 90) p.samples.shift();
      camPaint();
    };
    const up = (e: PointerEvent) => {
      const p = press;
      if (!p || e.pointerId !== p.pid) return;
      press = null;
      if (p.moved) eatClick = performance.now();   // a drag is never a click
      if (!cam.drag) return;
      cam.drag = false;
      document.documentElement.classList.remove("ov-panning");
      const a = p.samples[0], z = p.samples[p.samples.length - 1];
      const v = a && z && z.t > a.t && performance.now() - z.t < 80 ? -(z.x - a.x) / (z.t - a.t) / cam.step : 0;
      cam.target = flickTo(cam.ci + cam.off, e.type === "pointercancel" ? 0 : v, cam.n) - cam.ci;
      camRun();
    };
    const click = (e: MouseEvent) => {
      if (!api.current.live) return;
      if (performance.now() - eatClick < 400) { eatClick = 0; e.preventDefault(); e.stopPropagation(); return; }
      const hit = hitOf(e.target as Element | null, api.current.cur);
      if (hit.kind === "control") return;
      // A menu or a question open: the click only closes it.
      if (calPickNow) { e.preventDefault(); e.stopPropagation(); setCalPick(null); return; }
      if (api.current.sure) { e.preventDefault(); e.stopPropagation(); api.current.unsure(); return; }
      if (api.current.pop) { e.preventDefault(); e.stopPropagation(); api.current.unpop(); return; }
      if (hit.kind === "room" && galleryOpen) { e.preventDefault(); e.stopPropagation(); sfx.click(); setGallery(false); return; }
      const id = clickPick(hit, start.current, api.current.ids);
      if (!id) return;
      e.preventDefault(); e.stopPropagation();
      api.current.zoomInto(id);
    };
    // A sideways swipe or the wheel anywhere but the list's own scrolling slides the row.
    const wheel = (e: WheelEvent) => {
      if (!api.current.live || e.ctrlKey) return;
      const t = e.target as Element | null;
      if (t?.closest?.(".ov-gal, .ov-cal, input, textarea") || phoneUi(t)) return;
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * k, dy = e.deltaY * k;
      const sideways = Math.abs(dx) >= Math.abs(dy);
      if (!sideways && t?.closest?.(".tm-overlay")) return;   // up and down over the list scrolls the list
      e.preventDefault();
      cam.glide = null;
      const b = offBounds();
      if (sideways) {
        // A trackpad: the row follows the fingers exactly (its own glide included), with the rubber band at the ends.
        cam.raw = Math.max(b.min - 1, Math.min(b.max + 1, cam.raw + dx / cam.step));
        cam.off = rubber(cam.raw, b.min, b.max, 0.35);
        cam.target = Math.max(b.min, Math.min(b.max, cam.raw));
        cam.wheelUntil = performance.now() + 140;
        camPaint();
      } else {
        // A mouse wheel: the row eases towards where the notches say.
        cam.target = Math.max(b.min, Math.min(b.max, cam.target + dy / cam.step));
      }
      camRun();
    };
    // Left and Right glide one page; the list's own arrows are off while the overview is open (ListPager.tsx).
    const key = (e: KeyboardEvent) => {
      if (!api.current.live || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      if (phoneUi(null)) return;   // V1.57: the phone canvas is open: its own arrows move its pages (views/usePhonePan.ts)
      if ((document.activeElement as HTMLElement | null)?.closest?.("input, textarea, [contenteditable='true'], [role='slider']")) return;
      e.preventDefault();
      const b = offBounds();
      const to = Math.max(Math.ceil(b.min), Math.min(Math.floor(b.max), Math.round(cam.off) + (e.key === "ArrowRight" ? 1 : -1)));
      cam.target = to;
      camGlide(to);
    };
    const gone = () => {
      cam.edge = 0;
      if (cam.drag) { cam.drag = false; press = null; document.documentElement.classList.remove("ov-panning"); cam.target = cam.raw; camRun(); }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", moveP, { capture: true, passive: true });
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("click", click, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: false });
    window.addEventListener("keydown", key);
    document.documentElement.addEventListener("mouseleave", gone);
    window.addEventListener("blur", gone);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", moveP, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("wheel", wheel, true);
      window.removeEventListener("keydown", key);
      document.documentElement.removeEventListener("mouseleave", gone);
      window.removeEventListener("blur", gone);
      cam.edge = 0;
    };
  }, []);

  // ---- nothing over anything: the bar and the hint keep clear of the Dynamic Island (the developer's standing rule) ----
  const bar = useRef<HTMLDivElement>(null), hint = useRef<HTMLParagraphElement>(null);
  const [isl, setIsl] = useState(0);
  useEffect(() => onIsland(() => setIsl((n) => n + 1)), []);
  const [barAt, setBarAt] = useState<Spot | null>(null), [hintAt, setHintAt] = useState<Spot | null>(null);
  const hintNow = hintText(ids.length);
  useLayoutEffect(() => {
    const box = islandBox();
    const safe = (v: string) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
    const b = bar.current, h = hint.current;
    if (b) { const ph = phoneButtonSpot(box, vw); const sp = barSpot(box, vw, b.offsetWidth, b.offsetHeight, 16 + safe("--safe-top"), 24, 12, [{ left: ph.left, top: ph.top, right: ph.left + PHONE_BTN, bottom: ph.top + PHONE_BTN }]); setBarAt((o) => (o && o.left === sp.left && o.top === sp.top ? o : sp)); }
    if (h) { const sp = hintSpot(box, vw, vh, h.offsetWidth, h.offsetHeight, 16 + safe("--safe-bottom")); setHintAt((o) => (o && o.left === sp.left && o.top === sp.top ? o : sp)); }
  }, [isl, vw, vh, hintNow, sure]);
  const [placed, setPlaced] = useState(false);
  useEffect(() => { if (!barAt || placed) return; const r = requestAnimationFrame(() => requestAnimationFrame(() => setPlaced(true))); return () => cancelAnimationFrame(r); }, [barAt, placed]);

  return (
    <>
    <div ref={room} className={`ov-room${live ? " on" : ""}${leaving ? " leaving" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
      {/* The spotlight: a soft pool of light behind the pages, fading to dark at the edges (the developer, 13 Nov 2026). */}
      <div className="ov-dim" aria-hidden="true"><i className="ov-beam" /><i className="ov-floor" /></div>
      <div className="ov-track">
      {/* The pages beside the one in the middle, and the + cards past each end. */}
      {shownOrder.map((id, i) => {
        if (id === pg.cur && !reorder) return null;
        const isCur = id === pg.cur;
        const x = reorder?.id === id ? slotLeft(ids.indexOf(id)) + reorder.dx : slotLeft(i);
        return (
          <div key={id} className={`ov-slot${isCur ? " cur" : ""}${reorder?.id === id ? " lifting" : ""}`} style={{ transform: `translate(${x}px, ${cy - H / 2}px)`, width: W, height: H, ["--d" as string]: Math.abs(i - ci) }}>
            {!isCur && <PageCard id={id} layout={layout} red={red} pages={pagesSet} w={W} h={H} s={s} name={pg.name(id)} secs={pg.secs(id)} lit={hov === id}
              onOpen={() => zoomInto(id)} onAdd={() => { focusPage(id, false); window.setTimeout(() => setGallery(true), 260); }} />}
          </div>
        );
      })}
      {(["left", "right"] as const).map((side) => {
        // Just past the first and the last page: with one page both are fully on screen beside it.
        const pw = Math.max(150, Math.min(W * 0.42, (vw - W) / 2 - GAP - 18)), ph = Math.min(H * 0.6, pw * 1.3);
        const x = side === "left" ? slotLeft(0) - GAP - pw : slotLeft(ids.length - 1) + W + GAP;
        return (
          <button key={`${side}${plusGen}`} type="button" data-ov-plus={side} className={`ov-plus${hov === `+${side}` ? " lit" : ""}${plusGen ? " again" : ""}`} aria-label={`Add a page on the ${side}`}
            style={{ transform: `translate(${x}px, ${cy - ph / 2}px)`, width: pw, height: ph }} onClick={() => addAt(side === "left" ? 0 : ids.length)}>
            <span className="ov-plus-c" aria-hidden="true"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg></span>
            <span className="ov-plus-t">New page</span>
          </button>
        );
      })}
      {/* Each page's name pill: drag it sideways to change the order; the x deletes a page (never the main one). */}
      {shownOrder.map((id, i) => {
        const x = reorder?.id === id ? slotLeft(ids.indexOf(id)) + reorder.dx : slotLeft(i);
        return (
          <PagePill key={id} id={id} name={pg.name(id)} cur={id === pg.cur} x={x + W / 2} y={cy - H / 2 - 30} lifting={reorder?.id === id}
            sure={sure === id} count={ids.length}
            onDrag={(dx) => { const to = Math.max(0, Math.min(ids.length - 1, ids.indexOf(id) + Math.round(dx / step))); setReorder({ id, dx, to }); }}
            onDrop={() => { if (reorder && reorder.to !== ids.indexOf(id)) { editSfx("edit-drop"); pg.order(shownOrder); } setReorder(null); }}
            onDelete={() => {
              if (sure !== id) { sfx.click(); setSure(id); return; }
              editSfx("edit-page-remove"); setSure(null);
              change(dropPage(layout, id, at()), true);
              if (pg.cur === id) (pg.jump ?? pg.go)(MAIN_PAGE);
              pg.remove(id);
            }} />
        );
      })}
      </div>
    </div>
    {/* Over the card in the middle: the bar, the hint, the gallery and the calendar menu. */}
    <div className={`ov-top${live ? " on" : ""}${leaving ? " leaving" : ""}`} data-placed={placed ? "" : undefined} onMouseDown={(e) => e.stopPropagation()}>
      <div ref={bar} className="ov-bar" role="toolbar" aria-label="Edit pages" style={barAt ? { left: barAt.left, top: barAt.top } : { visibility: "hidden" }}>
        <button type="button" className="ed-btn ed-done" onClick={() => { sfx.click(); leave(); }}>Done</button>
        <button type="button" className={`ed-btn ov-add${gal ? " on" : ""}`} aria-expanded={gal} onClick={() => { sfx.click(); setPop(null); setGallery(!gal); }}>
          <span className="ed-plus" aria-hidden="true">+</span>Add panel
        </button>
        {canLooks && (<>
          <button type="button" className={`ed-btn${pop === "looks" ? " on" : ""}`} aria-expanded={pop === "looks"} title="Your saved looks: click one to switch to it"
            onClick={() => { sfx.click(); setGallery(false); setPop(pop === "looks" ? null : "looks"); }}>Looks</button>
          <button type="button" className={`ed-btn${pop === "save" ? " on" : ""}`} aria-expanded={pop === "save"} title="Save this whole setup as a look you can come back to"
            onClick={() => { sfx.click(); setGallery(false); setPop(pop === "save" ? null : "save"); }}>Save</button>
        </>)}
        <button type="button" className={`ed-btn${sure === "reset" ? " ov-sure" : ""}`} title={canLooks ? "Back to PS's default layout (this setup is kept as Before reset)" : "Every panel back where it started, on the main page"}
          onClick={() => {
            if (sure !== "reset") { sfx.click(); setSure("reset"); return; }
            setSure(null);
            if (canLooks) { resetAll(); return; }
            editSfx("edit-reset");
            markFresh([...Object.keys(layout.pos), ...layout.hidden, ...Object.keys(layout.page ?? {}), ...Object.keys(layout.size ?? {})]);
            change(resetLayout(at()), true);
          }}>{sure === "reset" ? "Sure? Back to default" : "Reset to default"}</button>
      </div>
      <p ref={hint} className="ov-hint" aria-live="polite" style={hintAt ? { left: hintAt.left, top: hintAt.top } : { visibility: "hidden" }}>{hintNow}</p>
      {gal && <Gallery layout={layout} red={red} page={pg.cur} pages={pagesSet} pageName={pg.name(pg.cur)} />}
      {pop && canLooks && (
        <div className="ov-looks" role="dialog" aria-label={pop === "save" ? "Save this look" : "Your looks"}
          style={{ left: Math.max(16, Math.min(vw - 16 - Math.min(560, vw - 32), barAt?.left ?? 16)), top: (barAt?.top ?? 16) + (bar.current?.offsetHeight ?? 44) + 10, width: Math.min(560, vw - 32) }}>
          {pop === "save"
            ? <SaveLook store={storeNow()} onSave={saveAs} onCancel={() => setPop(null)} />
            : <LooksMenu store={storeNow()} onPick={switchTo} onDelete={removeLook} onRename={renameTo} onSave={() => setPop("save")} />}
        </div>
      )}
      {toast && (
        <div key={toast.key} className="ov-toast" role="status">
          <span>{toast.text}</span>
          <button type="button" className="ed-btn sm" onClick={() => { sfx.click(); toast.undo(); }}>Undo</button>
          <i aria-hidden="true" />
        </div>
      )}
      {pick && <CalMenu pick={pick} layout={layout} red={red} />}
    </div>
    {/* V1.56: the phone button, top left, and the phone layout editor (views/PhoneEditor.tsx). */}
    <PhoneMount live={live} leaving={leaving} red={red} onDone={onDone} />
    </>
  );
}
/** V1.56: the phone button and the phone layout editor (views/PhoneEditor.tsx, PhoneLink.tsx, PhoneLooks.tsx) sit over the
 *  overview: the edge scroll and the wheel leave them alone, and stay quiet while the phone editor is open. */
const PHONE_UI = ".pe-room, .pe-phone-btn, .pe-pick, .pe-shade, .pl-card, .lk-panel, .lk-ask-wrap, .lk-toast";
const phoneUi = (t: Element | null) => !!t?.closest?.(PHONE_UI) || !!document.querySelector(".pe-room");
const hintText = (n: number) => n > 1
  ? "Click a page to open it. Drag the background or move to an edge to slide. Drag panels onto another page."
  : "Drag panels anywhere, the corner handle sizes them. The + on either side adds a page. Click the page to go back.";

/** One page beside the middle: its name, its sections and its panels, as a small map. Click: it comes to the middle. */
function PageCard({ id, layout, red, pages, w, h, s, name, secs, lit, onOpen, onAdd }: {
  id: string; layout: TabLayout; red: boolean; pages: ReadonlySet<string>; w: number; h: number; s: number; name: string; secs: string[]; lit: boolean; onOpen: () => void; onAdd: () => void;
}) {
  const ids = onPage(layout, id, red, pages).filter((x) => made.has(kindOf(x)) && !slotInfo(x)?.keep);   // only what this device draws
  const k = w / liveSize.w;
  let flow = 0;
  return (
    <div className={`ov-card${lit ? " lit" : ""}`} data-ov-page={id} role="button" tabIndex={0} aria-label={`Open ${name}`} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      <div className="ov-card-head" style={{ fontSize: Math.max(11, 46 * k) }}>{name}</div>
      <div className="ov-card-secs">
        {secs.slice(0, 6).map((t, i) => <span key={i} style={{ width: `${Math.min(92, 46 + ((t.length * 7) % 40))}%` }}>{t}</span>)}
      </div>
      {ids.map((pid) => {
        const p = layout.pos[pid];
        const z = sizeOf(layout, pid);
        let r = p ? fromPos({ ...p, w: p.w * z, h: p.h * z }, liveSize.w, liveSize.h) : lastSeen.get(pid) ?? lastSeen.get(kindOf(pid)) ?? null;
        if (!r) { r = { left: liveSize.w - 340, top: 80 + flow * 70, width: 300, height: 56 }; flow++; }
        return <span key={pid} className="ov-mini" style={{ left: r.left * k, top: r.top * k, width: Math.max(10, r.width * k), height: Math.max(8, r.height * k) }}><i>{slotLabel(pid)}</i></span>;
      })}
      {ids.length === 0 && secs.length === 0 && (
        <button type="button" className="ov-card-add" onClick={(e) => { e.stopPropagation(); sfx.click(); onAdd(); }}>
          <span className="ed-plus" aria-hidden="true">+</span>Add panels
        </button>
      )}
      <span className="ov-card-scale" aria-hidden="true" style={{ ["--s" as string]: s }} />
    </div>
  );
}

function PagePill({ id, name, cur, x, y, lifting, sure, count, onDrag, onDrop, onDelete }: {
  id: string; name: string; cur: boolean; x: number; y: number; lifting: boolean; sure: boolean; count: number;
  onDrag: (dx: number) => void; onDrop: () => void; onDelete: () => void;
}) {
  const g = useRef<{ x0: number; moved: boolean; pid: number } | null>(null);
  return (
    <div className={`ov-pill${cur ? " cur" : ""}${lifting ? " lifting" : ""}`} style={{ transform: `translate(${x}px, ${y}px) translateX(-50%)` }}
      onPointerDown={(e) => {
        if (e.button !== 0 || count < 2 || (e.target as Element).closest("button")) return;
        e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        g.current = { x0: e.clientX, moved: false, pid: e.pointerId };
      }}
      onPointerMove={(e) => {
        const d = g.current;
        if (!d || d.pid !== e.pointerId) return;
        const dx = e.clientX - d.x0;
        if (!d.moved && Math.abs(dx) < 5) return;
        if (!d.moved) { d.moved = true; sfx.click(); }
        onDrag(dx);
      }}
      onPointerUp={(e) => { const d = g.current; g.current = null; if (d?.moved && d.pid === e.pointerId) onDrop(); }}
      onPointerCancel={() => { g.current = null; onDrop(); }}
      title={count > 1 ? "Drag sideways to move this page" : undefined}>
      {count > 1 && <span className="ov-grip" aria-hidden="true" />}
      <span className="ov-pill-n">{name}</span>
      {id !== MAIN_PAGE && (
        <button type="button" className={`ov-pill-x${sure ? " sure" : ""}`} aria-label={`Delete the page ${name}`} onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          {sure ? "Delete page?" : <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>}
        </button>
      )}
    </div>
  );
}

/** Save: a name (the next "Look N" ready), Enter saves; a name you already have asks before it saves over it. */
function SaveLook({ store, onSave, onCancel }: { store: LooksStore; onSave: (name: string, over: string | null) => void; onCancel: () => void }) {
  const [name, setName] = useState(() => nextLookName(store, "mac"));
  const [ask, setAsk] = useState<string | null>(null);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { inp.current?.focus(); inp.current?.select(); }, []);
  const clash = lookNamed(store, "mac", name);
  const full = !canSaveMore(store, "mac") && !clash;
  const go = () => {
    const n = tidyLookName(name);
    if (!n || full) return;
    if (clash && ask !== clash.id) { sfx.click(); setAsk(clash.id); return; }
    onSave(n, clash ? clash.id : null);
  };
  return (
    <div className="ov-save">
      <b>Save this look</b>
      <p>Everything here: your pages, every panel and button with its place and size, and each page's background and look.</p>
      <div className="ov-save-row">
        <input ref={inp} className="ov-gal-q" value={name} maxLength={LOOK_NAME_MAX} spellCheck={false} aria-label="Name of the look"
          onChange={(e) => { setName(e.target.value); setAsk(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }} />
        <button type="button" className={`ed-btn${clash && ask === clash.id ? " ov-sure" : " ed-done"}`} disabled={!tidyLookName(name) || full} onClick={go}>
          {clash ? (ask === clash.id ? `Replace ${clash.name}?` : "Save over it") : "Save"}
        </button>
      </div>
      {clash && ask !== clash.id && <span className="ov-save-note">You already have a look called {clash.name}.</span>}
      {full && <span className="ov-save-note">{LOOKS_MAX} looks saved: delete one to save another.</span>}
    </div>
  );
}
/** Your looks: click one to switch to it; double click its name (or the pencil) to rename; the x deletes it (Undo). */
function LooksMenu({ store, onPick, onDelete, onRename, onSave }: {
  store: LooksStore; onPick: (l: SavedLook<MacLook>) => void; onDelete: (id: string) => void; onRename: (id: string, name: string) => void; onSave: () => void;
}) {
  const list = looksOf<MacLook>(store, "mac");
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <div className="ov-lk">
      <div className="ov-lk-head"><b>Your looks</b><button type="button" className="ed-btn sm" onClick={() => { sfx.click(); onSave(); }}><span className="ed-plus" aria-hidden="true">+</span>Save this look</button></div>
      {list.length === 0 && <p className="ed-none">No saved looks yet. Save keeps this whole setup, so you can come back to it any time.</p>}
      <div className="ov-lk-grid" role="list">
        {list.map((l) => (
          <div key={l.id} role="listitem" className={`ov-lk-card${l.auto ? " auto" : ""}`}>
            <button type="button" className="ov-lk-pick" aria-label={`Switch to ${l.name}`} onClick={() => onPick(l)}><LookThumb look={l.data} /></button>
            <div className="ov-lk-name">
              {edit === l.id
                ? <input className="ov-lk-in" defaultValue={l.name} maxLength={LOOK_NAME_MAX} autoFocus spellCheck={false} aria-label="New name"
                    onBlur={(e) => { onRename(l.id, e.target.value); setEdit(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEdit(null); } }} />
                : <span title="Double click to rename" onDoubleClick={() => setEdit(l.id)}>{l.name}</span>}
              {edit !== l.id && <button type="button" className="ov-lk-ic" aria-label={`Rename ${l.name}`} title="Rename" onClick={() => setEdit(l.id)}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /></svg>
              </button>}
              <button type="button" className="ov-lk-ic x" aria-label={`Delete ${l.name}`} title="Delete" onClick={() => onDelete(l.id)}>
                <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
            <span className="ov-lk-when">{l.auto ? "Saved by itself" : savedWhen(l.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
const savedWhen = (iso: string) => { const d = new Date(iso); return Number.isNaN(+d) ? "" : `Saved ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`; };
/** A tiny screen: the main page's moved panels, and a dot per page (the main one bright). */
function LookThumb({ look }: { look: MacLook }) {
  const p = macPreview(look);
  return (
    <span className="ov-lk-thumb" aria-hidden="true">
      <i className="ov-lk-head-line" />
      {[0, 1, 2].map((i) => <i key={i} className="ov-lk-row" style={{ top: `${34 + i * 13}%` }} />)}
      {p.boxes.map((b, i) => <i key={`b${i}`} className="ov-lk-box" style={{ left: `${4 + b.x * (92 - b.w * 92)}%`, top: `${6 + b.y * (88 - b.h * 88)}%`, width: `${Math.max(5, b.w * 92)}%`, height: `${Math.max(6, b.h * 88)}%` }} />)}
      <span className="ov-lk-dots">{Array.from({ length: Math.min(9, p.pages) }, (_, i) => <i key={i} className={i === p.main ? "on" : ""} />)}</span>
    </span>
  );
}

/** Add panel: every panel and button there is (the developer's own only for him), always, removed ones included. */
function Gallery({ layout, red, page, pages, pageName }: { layout: TabLayout; red: boolean; page: string; pages: ReadonlySet<string>; pageName: string }) {
  const [q, setQ] = useState("");
  const list = gallery(layout, page, red, PS, pages).filter((g) => made.has(g.kind) && (!q || g.label.toLowerCase().includes(q.toLowerCase())));
  const add = (kind: string) => {
    sfx.plop();
    const inner = slotInfo(kind)?.inner;
    const lc = liveCard();
    const w = lc ? Math.round(lc.r.width / lc.s) : window.innerWidth, h = lc ? Math.round(lc.r.height / lc.s) : window.innerHeight;
    // A button that normally lives inside a panel needs a place of its own: top right, a little lower each time.
    const n = (layout.extra ?? []).filter((x) => kindOf(x) === kind).length;
    const p = inner ? toPos({ left: w - 120 - 46 * (n % 5), top: 90 + 46 * Math.floor(n / 5), width: 36, height: 36 }, w, h) : undefined;
    const r = addPanel(layout, kind, page, at(), p);
    if (!r.id) return;
    markFresh([r.id]);
    change(r.layout, true);
  };
  return (
    <div className="ov-gal" role="dialog" aria-label="Add panel">
      <div className="ov-gal-head">
        <b>Add to {pageName}</b>
        <input className="ov-gal-q" value={q} placeholder="Find a panel" spellCheck={false} onChange={(e) => setQ(e.target.value)} aria-label="Find a panel"
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (q) setQ(""); else setGallery(false); } }} />
        <button type="button" className="ed-btn sm" onClick={() => { sfx.click(); setGallery(false); }}>Close</button>
      </div>
      <div className="ov-gal-grid" role="list">
        {list.map((g) => (
          <button key={g.kind} type="button" role="listitem" className={`ov-tile${g.removed ? " removed" : ""}`} onClick={() => add(g.kind)}
            title={g.removed ? "Removed: add brings it back" : g.here ? `${g.here} on this page` : "Add it to this page"}>
            <span className="ov-tile-ic" aria-hidden="true">{glyph(g.kind)}</span>
            <span className="ov-tile-n">{g.label}</span>
            <span className="ov-tile-s">{g.removed ? "Removed" : g.inner ? "A button from Meetings" : g.here ? `${g.here} here` : g.all ? `${g.all} on other pages` : "Not on any page"}</span>
            <span className="ov-tile-plus" aria-hidden="true">+</span>
          </button>
        ))}
        {list.length === 0 && <p className="ed-none">Nothing called that.</p>}
      </div>
      {PS && (
        <div className="ed-isl">
          <span>Dynamic Island: drag its grab line to move it anywhere.</span>
          <button type="button" className="ed-btn sm" onClick={() => { sfx.click(); psPost({ type: "island:reset" }); }}>Put it back at the top</button>
        </div>
      )}
    </div>
  );
}
/** A small sign for each tile: the first letters, in the panel's own colour family. */
function glyph(kind: string) {
  const l = slotLabel(kind).replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean);
  return ((l[0]?.[0] ?? "") + (l[1]?.[0] ?? "")).toUpperCase();
}

/** A Meetings panel's own calendar: the usual one, one more Google calendar (the developer, his own server), or one account of
 *  this Mac's Calendar (everyone else). */
function CalMenu({ pick, layout, red }: { pick: CalPick; layout: TabLayout; red: boolean }) {
  const cur = panelCal(cfgOf(layout, pick.id).cal);
  const accts = useMacAccounts();
  const google = red && onRedProject();   // The developer only feeds stay the developer only (his own server)
  const set = (cal: string) => { sfx.click(); change(setCfg(layout, pick.id, { cal }, at()), true); setCalPick(null); };
  return (
    <div className="ov-cal" role="menu" style={{ left: Math.min(pick.x, window.innerWidth - 300), top: Math.min(pick.y, window.innerHeight - 260) }}>
      <b>This panel's calendar</b>
      <button type="button" role="menuitemradio" aria-checked={cur.kind === "usual"} onClick={() => set("")}>{red ? "Your usual Google calendar" : "Every calendar on this Mac"}</button>
      {google && (
        <button type="button" role="menuitemradio" aria-checked={cur.kind === "google"} onClick={() => set(cur.kind === "google" ? `g:${cur.feed}` : `g:${newFeedId()}`)}>
          {cur.kind === "google" ? "Its own Google calendar (linked in the panel)" : "Another Google calendar: link it in the panel"}
        </button>
      )}
      {!red && accts.map((a) => (
        <button key={a} type="button" role="menuitemradio" aria-checked={cur.kind === "mac" && cur.account === a} onClick={() => set(`m:${a}`)}>Only {a}</button>
      ))}
      {!red && accts.length === 0 && <p className="ed-none">Once Calendar is switched on, each account shows here.</p>}
    </div>
  );
}
let macAcctsNow: string[] = [];
/** TaskMap hands over the accounts seen in the Mac's calendar copy. */
export function setMacAccounts(snap: Parameters<typeof macAccounts>[0]) {
  const next = macAccounts(snap);
  if (next.join("\n") !== macAcctsNow.join("\n")) { macAcctsNow = next; queueMicrotask(emit); }
}
const useMacAccounts = () => useStore(() => macAcctsNow);

// ---------- the edit layer: outlines, the x, dragging, sizing, inner buttons ----------
type Box = { id: string; r: Rect; inner?: { kind: string; panel: string } };
const overlayEl = () => document.querySelector<HTMLElement>(".tm-overlay.ed-able");
function slotEl(id: string): HTMLElement | null { return document.querySelector<HTMLElement>(`.tm-overlay:not(.tm-docked) [data-slot="${CSS.escape(id)}"]`); }
/** A screen rectangle in the page's own coordinates (the overview scales the whole page). */
function toPage(x: DOMRect | Rect, o: DOMRect, s: number): Rect {
  const l = "left" in x ? x.left : 0, t = "top" in x ? x.top : 0;
  return { left: (l - o.left) / s, top: (t - o.top) / s, width: x.width / s, height: x.height / s };
}
/** A slot's rectangle: its own box once moved, else the union of what it holds (its wrapper has no box). */
function slotRect(el: HTMLElement): DOMRect | null {
  const list = el.classList.contains("ed-moved") ? [el] : [...el.children] as HTMLElement[];
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const c of list) {
    const x = c.getBoundingClientRect();
    if (x.width <= 0 || x.height <= 0) continue;
    l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom);
  }
  return Number.isFinite(l) ? new DOMRect(l, t, r - l, b - t) : null;
}
function measure(): Box[] {
  const ov = overlayEl();
  if (!ov) return [];
  const o = ov.getBoundingClientRect(), s = o.width / (ov.offsetWidth || 1);
  liveSize = { w: ov.offsetWidth, h: ov.offsetHeight };
  const out: Box[] = [];
  for (const el of ov.querySelectorAll<HTMLElement>("[data-slot]")) {
    if (el.classList.contains("ed-hidden") || el.closest(".ed-hidden")) continue;
    const r = slotRect(el);
    if (!r) continue;
    const id = el.dataset.slot!;
    const pr = toPage(r, o, s);
    out.push({ id, r: pr });
    lastSeen.set(id, pr);
    if (!isCopy(id)) lastSeen.set(kindOf(id), pr);
    // The buttons inside it that can be dragged out (only its own, not those of a panel inside it).
    for (const inner of el.querySelectorAll<HTMLElement>(":scope [data-inner]")) {
      if (inner.closest("[data-slot]") !== el) continue;
      const b = (inner.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
      if (b && b.width > 0) out.push({ id: `${id}>${inner.dataset.inner}`, r: toPage(b, o, s), inner: { kind: inner.dataset.inner!, panel: id } });
    }
  }
  return out;
}
/** The page beside (or + card) under the pointer, if any. */
function dropTargetAt(x: number, y: number): string | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const h = el as HTMLElement;
    if (h.dataset?.ovPage) return h.dataset.ovPage;
    if (h.dataset?.ovPlus) return `+${h.dataset.ovPlus}`;
    if (h.classList?.contains("tm-overlay")) return null;
  }
  return null;
}

type Live = {
  mode: "move" | "size" | "width" | "out";
  id: string; p0: { x: number; y: number }; base: Rect | null; at: Rect; moved: boolean; pointer: number; z0: number; inner?: Box["inner"];
  grab: { x: number; y: number };   // where in the panel it was picked up (page coordinates)
  pan0: number;                     // how far the row was slid when it was picked up (the row may slide while it is carried)
};
/** A pointer position: a real event, or the last one again while the row slides under a carried panel. */
type Pt = { clientX: number; clientY: number; pointerId: number };
export function EditLayer({ saved }: { saved: TabLayout }) {
  const on = useEditing();
  const layout = useTabLayout(saved);
  const d = useDrag();
  const pg = usePages();
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const guideX = useRef<HTMLDivElement>(null), guideY = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const clearOnCommit = useRef<string | null>(null);
  // Outlines follow the panels: measured on entry, after every change, on resize, and twice a second (a panel's
  // contents can change size, and the card springs into place). Never while dragging.
  useLayoutEffect(() => {
    if (!on) { setBoxes([]); return; }
    // V1.56: drawn again only when something really moved (it used to draw every 0.4 s whatever happened).
    const put = () => { if (live.current) return; const next = measure(); setBoxes((old) => (sameBoxes(old, next) ? old : next)); };
    let raf = requestAnimationFrame(put);
    const tick = window.setInterval(put, 400);
    const rs = put;
    window.addEventListener("resize", rs);
    return () => { cancelAnimationFrame(raf); raf = 0; window.clearInterval(tick); window.removeEventListener("resize", rs); };
  }, [on, layout, d, pg.cur]);
  useLayoutEffect(() => {
    const id = clearOnCommit.current;
    if (!id || d) return;
    clearOnCommit.current = null;
    const el = slotEl(id);
    // Only the drag offset is ours to take off: the size and width the drop saved come back through React's style.
    if (el) { el.style.translate = ""; el.classList.remove("ed-away"); }
  }, [d, layout]);
  // The row slides under a carried panel (the screen's edge, core/overviewnav.ts): the drop target is checked again.
  const lastPt = useRef<Pt | null>(null);
  const moveNow = useRef<(e: Pt) => void>(() => {});
  useEffect(() => {
    if (!on) return;
    cam.onPan = () => { if (live.current?.moved && lastPt.current) moveNow.current(lastPt.current); };
    return () => { cam.onPan = null; };
  }, [on]);
  if (!on) return null;

  const scale = () => liveCard()?.s ?? 1;
  const room = () => { const ov = overlayEl(); return { w: ov?.offsetWidth ?? window.innerWidth, h: ov?.offsetHeight ?? window.innerHeight }; };
  const guides = (gx: number | null, gy: number | null) => {
    if (guideX.current) { guideX.current.style.opacity = gx === null ? "0" : "1"; if (gx !== null) guideX.current.style.transform = `translateX(${gx}px)`; }
    if (guideY.current) { guideY.current.style.opacity = gy === null ? "0" : "1"; if (gy !== null) guideY.current.style.transform = `translateY(${gy}px)`; }
  };
  const begin = (e: React.PointerEvent, b: Box, mode: Live["mode"]) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const lc = liveCard();
    const px = lc ? (e.clientX - lc.r.left) / lc.s : e.clientX, py = lc ? (e.clientY - lc.r.top) / lc.s : e.clientY;
    live.current = { mode, id: b.id, p0: { x: e.clientX, y: e.clientY }, base: null, at: b.r, moved: false, pointer: e.pointerId, z0: b.inner ? 1 : sizeOf(layout, b.id), inner: b.inner, grab: { x: px - b.r.left, y: py - b.r.top }, pan0: panPx() };
    lastPt.current = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId };
  };
  const move = (e: Pt) => {
    const g = live.current;
    if (!g || e.pointerId !== g.pointer) return;
    lastPt.current = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId };
    const s = scale();
    // Less the slide of the row since it was picked up, so the panel stays under the pointer.
    const dx = (e.clientX - g.p0.x - (panPx() - g.pan0)) / s, dy = (e.clientY - g.p0.y) / s;
    if (!g.moved) {
      if (Math.hypot(dx, dy) * s < 4) return;   // a press that hardly moves is not a drag
      g.moved = true;
      sfx.click();
      if (g.mode === "move") setDrag({ id: g.id, rect: g.at });   // lifted out of its column at the very spot it was
      if (g.mode === "out") setGhost({ x: e.clientX, y: e.clientY, label: slotLabel(g.inner!.kind) });
      return;
    }
    if (g.mode === "out") {
      setGhost({ x: e.clientX, y: e.clientY, label: slotLabel(g.inner!.kind) });
      setHoverTarget(dropTargetAt(e.clientX, e.clientY));
      return;
    }
    const el = slotEl(g.id);
    if (!el) return;
    if (g.mode === "size") {
      // The corner handle: the size follows the diagonal, the top left corner stays put.
      const diag = Math.hypot(g.at.width, g.at.height) || 1;
      const z = Math.max(SIZE_MIN, Math.min(SIZE_MAX, g.z0 * (1 + (dx + dy) / Math.SQRT2 / diag)));
      el.style.setProperty("--ed-z", String(Math.round(z * 100) / 100));
      el.classList.add("ed-z");
      g.base = { ...g.at, width: g.at.width * z / g.z0, height: g.at.height * z / g.z0 };
      if (el.classList.contains("ed-moved")) el.style.width = `${Math.round(g.base.width)}px`;
      return;
    }
    if (g.mode === "width") {
      const w = Math.max(120, Math.min(room().w - 2 * EDGE, g.at.width + dx));
      if (!el.classList.contains("ed-moved")) { setDrag({ id: g.id, rect: g.at }); }
      el.style.width = `${Math.round(w)}px`;
      g.base = { ...g.at, width: w };
      return;
    }
    if (!g.base) { el.style.translate = ""; const ov = overlayEl()!; const o = ov.getBoundingClientRect(); g.base = toPage(el.getBoundingClientRect(), o, s); }
    // Over a page beside, or a + card: it will go there (it fades here, a chip follows the pointer).
    const target = slotInfo(g.id)?.keep ? null : dropTargetAt(e.clientX, e.clientY);   // the gear and Tab and Lock are on every page
    setHoverTarget(target);
    el.classList.toggle("ed-away", !!target);
    if (target) { setGhost({ x: e.clientX, y: e.clientY, label: slotLabel(g.id) }); guides(null, null); return; }
    // Out in the room (on the way to a page further along): a chip follows the pointer; let go here and it goes back.
    if (offCard(e)) { el.classList.add("ed-away"); setGhost({ x: e.clientX, y: e.clientY, label: slotLabel(g.id) }); guides(null, null); return; }
    if (ghost) setGhost(null);
    const others = boxes.filter((x) => x.id !== g.id && !x.inner).map((x) => x.r);
    const { w, h } = room();
    const sn = snapRect({ ...g.base, left: g.base.left + dx, top: g.base.top + dy }, others, w, h);
    el.style.translate = `${sn.left - g.base.left}px ${sn.top - g.base.top}px`;
    g.at = { ...g.base, left: sn.left, top: sn.top };
    guides(sn.gx, sn.gy);
  };
  const end = (e: React.PointerEvent) => {
    const g = live.current;
    if (!g || e.pointerId !== g.pointer) return;
    live.current = null;
    lastPt.current = null;
    guides(null, null);
    setGhost(null);
    const target = g.moved && (g.mode === "move" || g.mode === "out") && !slotInfo(g.id)?.keep ? dropTargetAt(e.clientX, e.clientY) : null;
    setHoverTarget(null);
    if (!g.moved) return;
    const { w, h } = room();
    const s = scale();
    const z = sizeOf(layout, g.id);
    const time = at();
    // Onto a page beside, or a + card (a new page there): the panel goes there, at the spot it was dropped.
    const landOn = (page: string, l: TabLayout, id: string, wPx: number, hPx: number, zz: number) => {
      const card = document.querySelector<HTMLElement>(`[data-ov-page="${CSS.escape(page)}"]`)?.getBoundingClientRect();
      const left = card ? (e.clientX - card.left) / s - g.grab.x : w / 2 - wPx / 2;
      const top = card ? (e.clientY - card.top) / s - g.grab.y : h / 3;
      const pos = toPos({ left: Math.max(EDGE, left), top: Math.max(EDGE, top), width: wPx, height: hPx }, w, h);
      return putOnPage(moveSlot(l, id, { ...pos, w: Math.round(wPx / zz), h: Math.round(hPx / zz) }, time), id, page, time);
    };
    const pageFor = (t: string) => {
      if (!t.startsWith("+")) return t;
      return pg.add(t === "+left" ? 0 : pg.ids.length);
    };
    if (g.mode === "out") {
      const inner = g.inner!;
      const lc = liveCard();
      const px = lc ? (e.clientX - lc.r.left) / lc.s : e.clientX, py = lc ? (e.clientY - lc.r.top) / lc.s : e.clientY;
      // Dropped back on a Meetings panel: it stays inside.
      if (!target && boxes.some((b) => !b.inner && kindOf(b.id) === slotInfo(inner.kind)?.inner && inside(px, py, b.r))) return;
      const page = target ? pageFor(target) : pg.cur;
      if (!page) return;
      const left = px - g.grab.x, top = py - g.grab.y;
      const r = pullOut(layout, inner.panel, inner.kind, page, toPos({ left, top, width: g.at.width, height: g.at.height }, w, h), time);
      if (!r.id) return;
      editSfx("edit-drop");
      let n = r.layout;
      if (target) n = landOn(page, n, r.id, g.at.width, g.at.height, 1);
      markFresh([r.id]);
      change(n, true);
      return;
    }
    if (g.mode === "size") {
      const el = slotEl(g.id);
      const zNow = Number(el?.style.getPropertyValue("--ed-z")) || z;
      editSfx("edit-drop");
      clearOnCommit.current = g.id;
      let n = setSize(layout, g.id, zNow, time);
      const p = layout.pos[g.id];
      if (p) n = moveSlot(n, g.id, p, time);
      change(n, true);
      setDrag(null);
      return;
    }
    if (g.mode === "width") {
      if (!g.base) { setDrag(null); return; }
      editSfx("edit-drop");
      clearOnCommit.current = g.id;
      const pos = toPos(g.base, w, h);
      change(moveSlot(layout, g.id, { ...pos, w: Math.round(g.base.width / z), h: Math.round(g.base.height / z) }, time), true);
      setDrag(null);
      return;
    }
    if (!g.base) { setDrag(null); return; }
    // Let go out in the room, on no page: it glides back where it was (nothing changes).
    if (!target && offCard(e)) { clearOnCommit.current = g.id; setDrag(null); return; }
    editSfx("edit-drop");
    clearOnCommit.current = g.id;
    // A button that was dragged out, dropped on a Meetings panel: back inside.
    const lc = liveCard();
    const px = lc ? (e.clientX - lc.r.left) / lc.s : e.clientX, py = lc ? (e.clientY - lc.r.top) / lc.s : e.clientY;
    const info = slotInfo(g.id);
    const home = !target && info?.inner && isCopy(g.id) ? boxes.find((b) => !b.inner && b.id !== g.id && kindOf(b.id) === info.inner && inside(px, py, b.r)) : undefined;
    if (home) { change(pushIn(layout, g.id, home.id, time), true); setDrag(null); return; }
    if (target) {
      const page = pageFor(target);
      if (page) change(landOn(page, layout, g.id, g.base.width, g.base.height, z), true);
      setDrag(null);
      return;
    }
    const pos = toPos(g.at, w, h);
    change(moveSlot(layout, g.id, { ...pos, w: Math.round(g.at.width / z), h: Math.round(g.at.height / z) }, time));
    setDrag(null);
  };
  moveNow.current = move;
  const remove = (id: string) => {
    sfx.click();
    const el = slotEl(id);
    el?.classList.add("ed-out");
    window.setTimeout(() => {
      el?.classList.remove("ed-out");
      // A button dragged out of a panel goes back inside it; a copy goes; an original goes to the gallery as removed.
      const n = slotInfo(id)?.inner && isCopy(id) && cfgOf(layout, id).of ? pushIn(layout, id, cfgOf(layout, id).of!, at()) : hideSlot(layout, id, at());   // a copy goes for good, an original to the gallery as removed
      change(n);
    }, 180);
  };
  const vis = boxes.filter((b) => !b.inner || !boxes.some((o) => o.id === b.inner!.panel && d?.id === o.id));
  return (
    <div className="ed-layer" onMouseDown={(e) => e.stopPropagation()} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      {vis.map((b) => {
        const small = b.r.width < 110;
        if (b.inner) {
          return (
            <div key={b.id} className="ed-box ed-inner-box" style={{ left: b.r.left - 3, top: b.r.top - 3, width: b.r.width + 6, height: b.r.height + 6 }}
              onPointerDown={(e) => begin(e, b, "out")} role="button" aria-label={`Drag ${slotLabel(b.inner.kind)} out of the panel`} title={`Drag ${slotLabel(b.inner.kind)} out to make it its own button`} />
          );
        }
        return (
          <div key={b.id} className={`ed-box${d?.id === b.id ? " ed-lift" : ""}${small ? " ed-small" : ""}${isCopy(b.id) ? " ed-copybox" : ""}`} style={{ left: b.r.left, top: b.r.top, width: b.r.width, height: b.r.height }}
            onPointerDown={(e) => begin(e, b, "move")} role="button" aria-label={`Move ${slotLabel(b.id)}`}>
            <span className="ed-name">{slotLabel(b.id)}</span>
            {canHide(b.id) && (
              <button type="button" className="ed-x" aria-label={`Remove ${slotLabel(b.id)}`}
                onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); remove(b.id); }}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            )}
            {kindOf(b.id) === "meetings" && (
              <button type="button" className="ed-cal" aria-label="This panel's calendar" title="Choose this panel's calendar"
                onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); sfx.click(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCalPick({ id: b.id, x: r.left, y: r.bottom + 8 }); }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
              </button>
            )}
            <span className="ed-rs" aria-label={`Size of ${slotLabel(b.id)}`} title="Drag to make it bigger or smaller" onPointerDown={(e) => begin(e, b, "size")} />
            {isWide(b.id) && <span className="ed-rw" aria-label={`Width of ${slotLabel(b.id)}`} title="Drag to make it wider or narrower" onPointerDown={(e) => begin(e, b, "width")} />}
          </div>
        );
      })}
      <div ref={guideX} className="ed-guide x" aria-hidden="true" />
      <div ref={guideY} className="ed-guide y" aria-hidden="true" />
      {ghost && createPortal(<div className="ov-ghost" style={{ transform: `translate(${Math.max(80, Math.min(window.innerWidth - 80, ghost.x))}px, ${ghost.y}px)` }}>{ghost.label}</div>, document.body)}
    </div>
  );
}
const inside = (x: number, y: number, r: Rect) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
/** The same outlines, to the pixel (nothing to draw again). */
function sameBoxes(a: Box[], b: Box[]): boolean {
  if (a.length !== b.length) return false;
  const r = (x: number) => Math.round(x);
  return a.every((x, i) => { const y = b[i]; return x.id === y.id && r(x.r.left) === r(y.r.left) && r(x.r.top) === r(y.r.top) && r(x.r.width) === r(y.r.width) && r(x.r.height) === r(y.r.height); });
}
/** The pointer is off the page in the middle (out in the room). */
function offCard(e: Pt): boolean {
  const lc = liveCard();
  if (!lc) return false;
  const r = lc.r;
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}
