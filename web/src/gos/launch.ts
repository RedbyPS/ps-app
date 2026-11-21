// Launching a screen from the phone menu (the wheel in PS 1.67, the top left menu since 1.72, gos/navitems.ts): it zooms out
// of the spot the item sat on, like opening an app on an iPhone, and
// when it closes (its X, Back or Esc) a card in its colour zooms back into that spot. Only transform and opacity animate, on the
// compositor, so it holds 60 fps; reduced motion turns both into a short fade.
//
// It works on any screen without touching it: it notes which panel layers are open, runs the item's action, and the first new
// layer that shows is the screen (core/phonepanels.ts lists them). Pages (Plan, Inbox, Time zones) zoom the home itself.
import { PANEL_SELECTOR } from "../core/phonepanels";
import type { Pt } from "./navitems";

/** Every layer a menu item can open. Goals and the screen time card are not in the panel list (they never blocked swipes). */
export const LAUNCH_SELECTOR = `${PANEL_SELECTOR}, .gt-scrim, .gos-home .tm-st.open .tm-st-pop`;

const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const shownEl = (el: Element) => {
  const r = el.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return false;
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden";
};

// ---------- windows that open with morph() (views/DimensionX.tsx): Settings, Dimension X, Numerology, Series map, Brief... ----------
// They animate themselves, so the menu hands morph() the spot instead of animating on top of it: the window zooms out of the
// item's spot and, when it closes, zooms back into it (no card needed, it is the real window).
const MORPH_LAYERS = ".dx-layer, .nu-layer, .sp-layer, .sb-layer, .clw-layer, .nt-layer, .pm-layer";
let pending: { at: Pt; size: number; until: number } | null = null;
const spots = new WeakMap<HTMLElement, { at: Pt; size: number }>();
const zoomFrames = (r: DOMRect, at: Pt, size: number) => {
  const s = Math.max(0.04, Math.min(0.5, size / Math.max(1, Math.max(r.width, r.height))));
  return { small: { transform: `translate3d(${at.x - (r.left + r.width / 2)}px, ${at.y - (r.top + r.height / 2)}px, 0) scale(${s})`, transformOrigin: "50% 50%" },
    full: { transform: "translate3d(0, 0, 0) scale(1)", transformOrigin: "50% 50%" } };
};
/** Called by morph() first. Returns its animation when the menu launched this window (or is closing one it launched), else null
 *  and morph() does what it always did. Only on the phone (html[data-gos-launch], set by gos/GosLayer.tsx). */
export function launchMorph(win: HTMLElement, dir: "in" | "out"): Promise<void> | null {
  if (typeof document === "undefined" || !document.documentElement.hasAttribute("data-gos-launch")) return null;
  const r = win.getBoundingClientRect();
  if (dir === "in") {
    if (!pending || performance.now() > pending.until) return null;
    const o = pending; pending = null;
    spots.set(win, { at: o.at, size: o.size });
    if (reduced()) return win.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" }).finished.then(() => {}, () => {});
    const f = zoomFrames(r, o.at, o.size);
    return win.animate([{ ...f.small, opacity: 0 }, { opacity: 1, offset: 0.28 }, { ...f.full, opacity: 1 }], { duration: 480, easing: "cubic-bezier(.16, 1, .3, 1)" })
      .finished.then(() => {}, () => {});
  }
  const o = spots.get(win);
  if (!o) return null;
  spots.delete(win);
  if (reduced()) return win.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" }).finished.then(() => {}, () => {});
  const f = zoomFrames(r, o.at, o.size);
  return win.animate([{ ...f.full, opacity: 1 }, { opacity: 1, offset: 0.7 }, { ...f.small, opacity: 0 }], { duration: 380, easing: "cubic-bezier(.55, 0, .3, 1)", fill: "forwards" })
    .finished.then(() => {}, () => {});
}

interface Live { el: HTMLElement; at: Pt; size: number; rect: DOMRect; bg: string; radius: string; stop: () => void; quiet: boolean }
let live: Live | null = null;

/** The colour the screen shows most: its own background, else the first child that has one. */
function bgOf(el: HTMLElement): string {
  const see = (e: Element) => { const c = getComputedStyle(e).backgroundColor; return c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c) ? c : ""; };
  let c = see(el);
  for (let i = 0; !c && i < el.children.length && i < 6; i++) {
    c = see(el.children[i]);
    for (let j = 0; !c && j < el.children[i].children.length && j < 4; j++) c = see(el.children[i].children[j]);
  }
  return c || "var(--k-surface, #1A1016)";
}

/** Grow `el` out of the point `at` (a circle `size` wide) to where it sits. */
export function zoomIn(el: HTMLElement, at: Pt, size: number) {
  const r = el.getBoundingClientRect();
  if (reduced()) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" }); return; }
  const s = Math.max(0.04, Math.min(0.5, size / Math.max(1, Math.max(r.width, r.height))));
  const tx = at.x - (r.left + r.width / 2), ty = at.y - (r.top + r.height / 2);
  el.animate([
    { transform: `translate3d(${tx}px, ${ty}px, 0) scale(${s})`, opacity: 0, transformOrigin: "50% 50%" },
    { opacity: 1, offset: 0.28, transformOrigin: "50% 50%" },
    { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1, transformOrigin: "50% 50%" },
  ], { duration: 480, easing: "cubic-bezier(.16, 1, .3, 1)" });
}

/** A card in the screen's colour shrinks from where the screen was back into the spot it came from. */
function zoomBack(l: Live) {
  const g = document.createElement("div");
  g.className = "gos-launch-ghost";
  const r = l.rect;
  Object.assign(g.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, background: l.bg, borderRadius: l.radius });
  document.body.appendChild(g);
  const done = () => g.remove();
  if (reduced()) { g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-out" }).onfinish = done; return; }
  const s = Math.max(0.04, Math.min(0.5, l.size / Math.max(1, Math.max(r.width, r.height))));
  const tx = l.at.x - (r.left + r.width / 2), ty = l.at.y - (r.top + r.height / 2);
  const a = g.animate([
    { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
    { opacity: 1, offset: 0.7 },
    { transform: `translate3d(${tx}px, ${ty}px, 0) scale(${s})`, opacity: 0 },
  ], { duration: 380, easing: "cubic-bezier(.55, 0, .3, 1)" });
  a.onfinish = done; a.oncancel = done;
  window.setTimeout(done, 900);   // never left behind
}

/** Follow a launched screen until it closes, then zoom it back. A close starts when it leaves the page or takes a closing class. */
function track(el: HTMLElement, at: Pt, size: number) {
  live?.stop();
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const l: Live = { el, at, size, rect, bg: bgOf(el), radius: cs.borderRadius || "0px", quiet: false, stop: () => {} };
  let over = false;
  const end = (animate: boolean) => {
    if (over) return;
    over = true;
    body.disconnect(); cls.disconnect();
    if (live === l) live = null;
    if (animate && !l.quiet) zoomBack(l);
  };
  // Removed: the layer itself or a parent left the page. Cheap: one isConnected per batch of changes.
  const body = new MutationObserver(() => { if (!el.isConnected) end(true); });
  body.observe(document.body, { childList: true, subtree: true });
  const cls = new MutationObserver(() => {
    if (/\b(out|closing|leaving|docked)\b/.test(el.className)) { el.style.visibility = "hidden"; end(true); }
  });
  cls.observe(el, { attributes: true, attributeFilter: ["class"] });
  l.stop = () => end(false);
  live = l;
}

/** Is a screen the menu launched still open. */
export const launchedOpen = () => !!live && live.el.isConnected;

/** Close the screen the menu launched last (a new launch replaces it, the way an iPhone leaves one app for another). */
export function closeLaunched(): boolean {
  if (!launchedOpen()) return false;
  live!.quiet = true;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  return true;
}

/** Run an item's action and zoom the screen it opens out of `at`. `home`: it changes the page instead (zoom the whole home).
 *  `own`: the screen grows out of the spot by itself (Gym). */
export function launch(at: Pt, size: number, act: () => void, how: "layer" | "home" | "own" | "none" = "layer") {
  const before = new Set(Array.from(document.querySelectorAll(LAUNCH_SELECTOR)));
  pending = how === "layer" ? { at, size, until: performance.now() + 1500 } : null;
  act();
  if (how === "none" || how === "own") return;
  if (how === "home") {
    requestAnimationFrame(() => requestAnimationFrame(() => { const h = document.querySelector<HTMLElement>(".gos-home"); if (h) zoomIn(h, at, size); }));
    return;
  }
  const until = performance.now() + 1500;
  let mo: MutationObserver | null = null;
  // Looked for in the observer's own tick (before the browser paints), so the screen never shows one full size frame first.
  const look = () => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(LAUNCH_SELECTOR)).find((e) => !before.has(e) && shownEl(e));
    if (el) {
      mo?.disconnect();
      if (el.matches(MORPH_LAYERS)) return true;   // morph() zooms it (launchMorph above)
      pending = null;
      zoomIn(el, at, size); track(el, at, size);
      return true;
    }
    if (performance.now() > until) { mo?.disconnect(); return true; }
    return false;
  };
  if (look()) return;
  mo = new MutationObserver(() => { look(); });
  mo.observe(document.body, { childList: true, subtree: true });
  window.setTimeout(() => { mo?.disconnect(); pending = null; }, 1600);
}
