// PS 1.66 (the developer, 17 Nov 2026): "on Numerology a sideways swipe also switches the page underneath, which then breaks touches until I
// swipe back." While any full screen panel, tab or pop-up is open over the phone's pages, a sideways swipe never moves the pages
// behind it. The three page swipes (gos/GosLayer.tsx Swipe, gos/PhonePages.tsx, views/ListPager.tsx) ask `panelOpen()` as a finger
// touches down and leave the gesture alone when it says yes.
//
// Run: node --experimental-strip-types tests/phonepanels.test.ts

/** Every full screen panel or pop-up layer that can open over the phone's pages. The feature intro card (.fi-layer) is left out on
 *  purpose: it takes no touches outside its card and the tour moves between pages itself. */
export const PANEL_LAYERS = [
  ".nu-layer", ".pc-layer", ".rs-layer", ".dx-layer", ".ms-layer", ".cs-win", ".tl-layer", ".sp-layer", ".gs-layer", ".gs-win",
  ".gsw", ".sb-layer", ".clw-layer", ".fit-pop-layer", ".fit-look-layer", ".fit-menu-layer", ".fit-scr-layer", ".fp-layer", ".fp-ask-layer", ".fq-ov",
  ".rb-layer", ".bf-layer", ".ia-layer", ".od-layer", ".uf-layer", ".wn-layer", ".wt-layer", ".af-layer", ".gc-modal", ".chk-layer",
  ".trm-layer", ".slp-layer", ".slp-cust-layer", ".slp-warn-layer", ".slp-wi-layer", ".sn-warn-layer", ".isw-back", ".wa-guide",
  ".lk-ask-wrap", ".tm-add-layer", ".nt-win", ".sr-layer", ".am-win", ".mcs-ov", ".scrim", ".sm-overlay", ".gos-sheet-wrap",
] as const;
export const PANEL_SELECTOR = PANEL_LAYERS.join(", ");

/** Does a layer that matched really cover something: drawn, not hidden, not see through, bigger than a sliver. */
export function shown(w: number, h: number, display: string, visibility: string, opacity: string): boolean {
  if (!(w >= 40 && h >= 40)) return false;
  if (display === "none" || visibility === "hidden" || visibility === "collapse") return false;
  const o = parseFloat(opacity);
  return !(Number.isFinite(o) && o <= 0.01);
}

/** A layer that takes no touches itself (the Soundboard's, pointer-events none) counts only when something inside it that does
 *  covers at least half the screen each way (its window, not a mini player). */
export function covers(w: number, h: number, vw: number, vh: number): boolean { return w >= vw * 0.5 && h >= vh * 0.5; }

/** Is a full screen panel open over the pages right now. Reads only the layers that match (a handful at most), once per touch down. */
export function panelOpen(doc: Document | undefined = typeof document === "undefined" ? undefined : document): boolean {
  if (!doc) return false;
  const vw = window.innerWidth || 400, vh = window.innerHeight || 800;
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(PANEL_SELECTOR))) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!shown(r.width, r.height, cs.display, cs.visibility, cs.opacity)) continue;
    if (cs.pointerEvents !== "none") return true;
    for (const c of Array.from(el.children)) {
      const cr = c.getBoundingClientRect();
      if (getComputedStyle(c).pointerEvents !== "none" && covers(cr.width, cr.height, vw, vh)) return true;
    }
  }
  return false;
}
