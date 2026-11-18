// PS 1.67: the Dynamic Island on for everyone (the developer, 18 Nov 2026: "Make it on for everyone. But if they go in the settings
// and actually turn off, then it turns off"; his answers: keep the quick hides, turn it back on once for people who have it off).
// Once per account: island prefs saved as "off" go back to "notch" (a Mac without a notch draws the pill), and a marker
// (settings.islandOn167) is saved with it, so a later Off in Settings stays off. Every other island choice is kept as saved.
// Once per phone: "Island inside PS" switched off on this phone (localStorage ps.phone.inAppIsland) is cleared, with a per
// phone marker. The quick hides on the island itself (grey line, right click) are untouched. Pure: no vault, no clock.
import type { Settings } from "./model";

/** The settings patch the one time step writes, or null when it already ran (or settings are not loaded yet). */
export function islandOnPatch(st: Settings | null | undefined): Partial<Settings> | null {
  if (!st || st.islandOn167) return null;
  const isl = st.island;
  return isl && typeof isl === "object" && isl.mode === "off"
    ? { island: { ...isl, mode: "notch" }, islandOn167: true }
    : { islandOn167: true };
}

/** The phone's own step: storage like localStorage (get, set, remove). Runs once per phone; true when it turned the island back on. */
export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const PHONE_ISLAND_KEY = "ps.phone.inAppIsland", PHONE_MARK_KEY = "ps.phone.islandOn167";
export function phoneIslandOnce(s: Store): boolean {
  if (s.getItem(PHONE_MARK_KEY)) return false;
  const was = s.getItem(PHONE_ISLAND_KEY) === "off";
  if (was) s.removeItem(PHONE_ISLAND_KEY);
  s.setItem(PHONE_MARK_KEY, "1");
  return was;
}
