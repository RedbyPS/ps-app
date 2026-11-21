// PS GOS touch layer: the Mac and website code expects a mouse, so this file teaches it fingers
// without changing the shared views.
//  - Long press drag: hold a task (or an Urgent item, a New tasks card, a Dimension X card, a mini
//    task, a section header) for 0.35 s and it lifts with a haptic; then drag. A quick
//    swipe still scrolls, a tap still taps. The views' own drag code runs unchanged: after the hold
//    it gets the press as a mouse press, so it drags from anywhere on the row.
//  - Haptics on ticks, drops and the hold.
//  - Back gesture: the shell sends "back"; the top layer closes (every layer closes on Escape), and
//    with nothing left to close the app goes to the background.
import { haptic, gosPost, gosState, onShell } from "./bridge";
import { startEdgeGuard } from "./edgeguard";

const DRAGGABLE = ".tm-row, .tm-aware li, .nt-card, [data-k], .mt-item, .tm-sec-h, .tl-item, .todo-row";
const NOT_HERE = "input, textarea, select, [contenteditable='true'], .no-drag, .tm-tick, button.mt-check, input[type='range']";
const HOLD_MS = 350;
const SLOP = 9;

type Hold = { id: number; target: Element; x: number; y: number; timer: number; lifted: boolean; init: PointerEventInit };
// Touch events keep going to the element first touched, even after a view replaces it with a drag
// ghost (Dimension X does), and then never reach window: so the scroll guard also sits on that element.
let touched: Element | null = null;
function guard(el: Element | null) {
  if (touched === el) return;
  touched?.removeEventListener("touchmove", onTouchMove as EventListener);
  touched = el;
  touched?.addEventListener("touchmove", onTouchMove as EventListener, { passive: false });
}
let hold: Hold | null = null;
let replaying = false;

function haptics() { return gosState().prefs?.haptics !== false; }

function cancelHold() {
  if (!hold) return;
  window.clearTimeout(hold.timer);
  hold = null;
}

function onDown(e: PointerEvent) {
  if (replaying || e.pointerType === "mouse" || !e.isPrimary) return;
  const t = e.target as Element | null;
  const row = t?.closest?.(DRAGGABLE);
  if (!row || t?.closest?.(NOT_HERE) || t?.closest?.("[data-dragging]")) return;
  // Keep the press away from the view until we know it is a hold (a tap still makes a click,
  // which the browser builds from the touch itself).
  e.stopPropagation();
  cancelHold();
  const init: PointerEventInit = {
    bubbles: true, cancelable: true, composed: true, pointerId: e.pointerId, pointerType: "mouse", isPrimary: true,
    clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, button: 0, buttons: 1, width: 1, height: 1, pressure: 0.5,
  };
  hold = { id: e.pointerId, target: t!, x: e.clientX, y: e.clientY, lifted: false, init, timer: window.setTimeout(lift, HOLD_MS) };
  guard(t);
}

function lift() {
  const h = hold;
  if (!h || !h.target.isConnected) { cancelHold(); return; }
  h.lifted = true;
  if (haptics()) haptic("drag");
  const row = h.target.closest(DRAGGABLE) as HTMLElement | null;
  row?.classList.add("gos-lifted");
  replaying = true;
  try { h.target.dispatchEvent(new PointerEvent("pointerdown", h.init)); } finally { replaying = false; }
  // The views start their drag after a few pixels: nudge it so the row lifts under the finger at once.
  const nudge = { ...h.init, clientY: (h.init.clientY ?? 0) + 7 };
  window.dispatchEvent(new PointerEvent("pointermove", nudge));
  window.dispatchEvent(new PointerEvent("pointermove", h.init));
}

function onMove(e: PointerEvent) {
  const h = hold;
  if (!h || e.pointerId !== h.id || h.lifted) return;
  if (Math.hypot(e.clientX - h.x, e.clientY - h.y) > SLOP) cancelHold();   // a swipe: let it scroll
}

function onUp(e: PointerEvent) {
  const h = hold;
  if (!h || e.pointerId !== h.id) return;
  const lifted = h.lifted;
  cancelHold();
  guard(null);
  document.querySelectorAll(".gos-lifted").forEach((el) => el.classList.remove("gos-lifted"));
  if (lifted) {
    if (haptics()) haptic("drop");
    // The browser would also fire a click (and a context menu) for this long touch: not a tap.
    const stop = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener("click", stop, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 80);
  }
}

// While a row is lifted the page must not scroll under it.
function onTouchMove(e: TouchEvent) { if (hold?.lifted && e.cancelable) e.preventDefault(); }

// Ticks: a short confirm buzz.
function onClick(e: MouseEvent) {
  if (!haptics()) return;
  const t = e.target as Element | null;
  if (t?.closest?.(".tm-tick, .mt-check, .check, .tm-aware-tick")) haptic("tick");
}

// ---------- back gesture ----------
let backBusy = false;
function back() {
  if (backBusy) return;
  backBusy = true;
  // Our own layers first (the GOS settings sheet and the vault pages listen for this).
  const ev = new CustomEvent("gos-back", { cancelable: true });
  if (!window.dispatchEvent(ev)) { backBusy = false; return; }
  // Then whatever the views have open: they all close on Escape (most also mark it handled).
  let changed = false;
  const mo = new MutationObserver((list) => { if (list.some((r) => [...r.removedNodes].some((n) => n instanceof HTMLElement))) changed = true; });
  mo.observe(document.body, { childList: true, subtree: true });
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : window;
  const handled = !target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  (document.activeElement as HTMLElement | null)?.blur?.();
  window.setTimeout(() => {
    mo.disconnect();
    backBusy = false;
    if (!handled && !changed) gosPost({ type: "back:none" });   // nothing was open: the shell sends PS to the background
  }, 380);
}

let started = false;
export function startTouch() {
  if (started) return;
  started = true;
  window.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("pointermove", onMove, { capture: true, passive: true });
  window.addEventListener("pointerup", onUp, { capture: true });
  window.addEventListener("pointercancel", onUp, { capture: true });
  window.addEventListener("touchmove", onTouchMove, { passive: false });
  window.addEventListener("contextmenu", (e) => { if (hold || document.querySelector(".gos-lifted")) e.preventDefault(); }, { capture: true });
  window.addEventListener("click", onClick, { capture: true });
  onShell((m) => { if (m.type === "back") back(); });
  startEdgeGuard();   // PS 1.73: the side edges over PS's own swipeable pages stay PS's (gos/edgeguard.ts)
}
