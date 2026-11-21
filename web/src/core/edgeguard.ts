// PS 1.73 swipe leak on the phone (the developer, 21 Nov 2026: "I had the same problem on the GOS app as well when swiping left and right
// when you're using the PS app"). A sideways swipe that starts near the left or right edge of the screen is taken by Android as
// Back before PS sees it: an open layer closes, or with nothing open PS drops to the background. While PS's own pages can be
// swiped (the home pages, no panel or pop-up over them), the page tells the GrapheneOS shell where they are, and the shell asks
// Android to leave a strip of each side edge over them to PS (setSystemGestureExclusionRects, gos MainActivity.kt EdgeGuard.kt).
// Android allows at most 200 dp of each edge, so Back keeps working above and below the strip, and everywhere the moment a
// panel, sheet, menu or pop-up opens (the strips are cleared). What Back does is not changed.
//
// Pure, so it is unit tested: tests/edgeguard.test.ts. The DOM side is src/gos/edgeguard.ts.

/** Layers that close on Back but are not in core/phonepanels.ts PANEL_LAYERS (the menu, a task's pop-up, the Clients screen, the
 *  island's card and any other dialog, Plan's open panel, Edit mode, the sign in fingerprint button). Counted only when drawn. */
export const OVER_PAGES = [
  ".gos-menu.open", ".tm-pop-wrap.open", ".cs-layer", "[role='dialog']:not(.tm-overlay)", ".gos-show-back", ".pm-room", ".gos-finger",
] as const;
export const OVER_SELECTOR = OVER_PAGES.join(", ");

/** The smallest area worth guarding (CSS px): less and the strips are not set. */
export const MIN_AREA = 48;

export type Snapshot = {
  /** The home pages are on screen (the swipe area exists) and PS is the app in front. */
  home: boolean;
  /** A panel, sheet, menu, pop-up or dialog is open over them (Back must close it from anywhere on the edge). */
  over: boolean;
  /** The swipe area's top and bottom (CSS px from the top of the page) and the page's height. */
  top: number;
  bottom: number;
  vh: number;
};

/** The part of the page whose side edges belong to PS's own swipes, or null: no strips, Back owns every edge. */
export function guardArea(s: Snapshot): { top: number; bottom: number } | null {
  if (!s.home || s.over) return null;
  if (![s.top, s.bottom, s.vh].every(Number.isFinite) || s.vh <= 0) return null;
  const top = Math.max(0, s.top), bottom = Math.min(s.vh, s.bottom);
  if (bottom - top < MIN_AREA) return null;
  return { top, bottom };
}

/** The message for the shell. Rounded, so a sub pixel layout change never sends again. Off is top 0, bottom 0. */
export function guardMessage(a: { top: number; bottom: number } | null): { type: "edgeGuard"; top: number; bottom: number } {
  return a ? { type: "edgeGuard", top: Math.round(a.top), bottom: Math.round(a.bottom) } : { type: "edgeGuard", top: 0, bottom: 0 };
}
