// PS 1.73 swipe leak (the rule is core/edgeguard.ts): tells the GrapheneOS shell where PS's own swipeable pages are, so a sideways
// swipe starting near a side edge over them stays a page swipe instead of Android's Back. Looks again only when the page changes
// (a layer opens or closes, the window resizes, PS comes to the front or goes away) and once a second as a safety net; sends only
// when the answer changes. The iPhone web app has no shell (gosPost ignores it there).
import { gosPost, gosState, onShell } from "./bridge";
import { panelOpen, shown } from "../core/phonepanels";
import { guardArea, guardMessage, OVER_SELECTOR } from "../core/edgeguard";

let last = "";
let raf = 0;

function overPages(): boolean {
  if (panelOpen()) return true;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(OVER_SELECTOR))) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (shown(r.width, r.height, cs.display, cs.visibility, cs.opacity)) return true;
  }
  return false;
}

function check() {
  raf = 0;
  const sw = document.querySelector<HTMLElement>(".gos-home .gos-swipe");
  const r = sw?.getBoundingClientRect();
  const home = !!sw && !!r && r.width > 0 && document.visibilityState === "visible" && gosState().visible !== false;
  const msg = guardMessage(guardArea({ home, over: home && overPages(), top: r?.top ?? 0, bottom: r?.bottom ?? 0, vh: window.innerHeight }));
  const key = `${msg.top}:${msg.bottom}`;
  if (key === last) return;
  last = key;
  gosPost(msg);
}

function soon() { if (!raf) raf = requestAnimationFrame(check); }

let started = false;
export function startEdgeGuard() {
  if (started || typeof document === "undefined") return;
  started = true;
  // Layers mount and unmount, and open with a class: that is all it needs (not style, which a finger's drag changes every frame).
  new MutationObserver(soon).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "role", "hidden", "open"] });
  window.addEventListener("resize", soon);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible") check(); else soon(); });
  window.addEventListener("touchend", soon, { passive: true });
  onShell((m) => { if (m.type === "hello" || m.type === "visible" || m.type === "insets") { last = ""; soon(); } });   // the shell (re)started or came back: send again
  window.setInterval(check, 1000);
  soon();
}
